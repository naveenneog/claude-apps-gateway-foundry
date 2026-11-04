<#
.SYNOPSIS
    Updates only the existing admin console's image, preserving its deployment settings.
.DESCRIPTION
    Builds from this repository, pins the new image by digest and updates only the admin-ui container.
    No Bicep provisioning, app-registration lookup, Graph grant, gateway change or database change runs.
    Prints the previous image for rollback and checks settings and the ready revision after rollout (ADR-0019).
.PARAMETER ResourceGroup
    The resource group containing the existing console and its registry.
.PARAMETER AppName
    The existing console Container App, ca-admin-ui by default.
.PARAMETER ImageTag
    A build tag; the deployed image reference uses its digest, not this mutable tag.
.PARAMETER Plan
    Reads the current context and prints the update plan. Builds and updates nothing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [string]$AppName = 'ca-admin-ui',
    [string]$ImageTag = ('update-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')),
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
foreach ($entry in @{ ResourceGroup = $ResourceGroup; AppName = $AppName; ImageTag = $ImageTag }.GetEnumerator()) {
    if ($entry.Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
        throw "$($entry.Key) must be a non-empty native-command-safe name; nothing was run."
    }
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Invoke-Az([string[]]$Arguments) {
    if (@($Arguments | Where-Object { $_ -match '["&|<>^%()\r\n]' }).Count) {
        throw 'Azure CLI arguments contain a shell metacharacter; nothing was run for this command.'
    }
    & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI $($Arguments[0]) $($Arguments[1]) failed (exit $LASTEXITCODE)." }
}
function Get-AzJson([string[]]$Arguments) {
    $text = (Invoke-Az ($Arguments + @('-o', 'json'))) -join "`n"
    return ($text | ConvertFrom-Json -ErrorAction Stop)
}
function Read-App {
    Get-AzJson @('containerapp', 'show', '-g', $ResourceGroup, '-n', $AppName)
}
function Read-Auth {
    Get-AzJson @('containerapp', 'auth', 'show', '-g', $ResourceGroup, '-n', $AppName)
}
function Canonical($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary] -or $Value -is [pscustomobject]) {
        $result = [ordered]@{}
        $keys = if ($Value -is [Collections.IDictionary]) { $Value.Keys } else { $Value.PSObject.Properties.Name }
        foreach ($key in ($keys | Sort-Object -CaseSensitive)) { $result[$key] = Canonical $Value.$key }
        return $result
    }
    if ($Value -is [array]) { return ,@($Value | ForEach-Object { Canonical $_ }) }
    return $Value
}
function Snapshot($App, $Auth) {
    $template = $App.properties.template | ConvertTo-Json -Depth 100 | ConvertFrom-Json
    foreach ($container in $template.containers) { $container.PSObject.Properties.Remove('image') }
    Canonical @{
        identity = $App.identity
        configuration = $App.properties.configuration
        template = $template
        authentication = $Auth
        location = $App.location
        tags = $App.tags
        workloadProfileName = $App.properties.workloadProfileName
    } | ConvertTo-Json -Depth 100 -Compress
}

$account = Get-AzJson @('account', 'show')
$before = Read-App
if (-not $account.id -or $before.id.Split('/')[2] -ne $account.id) { throw 'The target app does not match the selected subscription.' }
$container = @($before.properties.template.containers | Where-Object { $_.name -eq 'admin-ui' })
if ($container.Count -ne 1) { throw 'The console must have exactly one container named admin-ui.' }
$previousImage = $container[0].image
if ($previousImage -notmatch '^(?<registry>[a-z0-9-]+\.azurecr\.(io|us|cn))/admin-ui[:@][A-Za-z0-9:._-]+$') {
    throw 'The existing image is not an admin-ui image in Azure Container Registry; nothing was changed.'
}
$registryServer = $Matches.registry
$registryName = $registryServer.Split('.')[0]
$registry = Get-AzJson @('acr', 'show', '-g', $ResourceGroup, '-n', $registryName)
if ($registry.loginServer -ne $registryServer) { throw 'The registry does not match the running console image.' }
$auth = Read-Auth
$snapshot = Snapshot $before $auth
Write-Host "Target: subscription $($account.id), $ResourceGroup / $AppName"
Write-Host "Previous image: $previousImage"
Write-Host "Rollback: az containerapp update -g $ResourceGroup -n $AppName --container-name admin-ui --image $previousImage"
Write-Host "Build: $registryServer/admin-ui:$ImageTag from $root"
if ($Plan) {
    Write-Host 'Plan only: build a digest-pinned image, update the console image, then check preserved settings and revision health.'
    return
}

Invoke-Az @('acr', 'build', '--registry', $registryName, '--image', "admin-ui:$ImageTag",
    '--file', (Join-Path $root 'admin-ui\Dockerfile'), $root, '--no-logs', '-o', 'none') | Out-Host
$image = Get-AzJson @('acr', 'repository', 'show', '-n', $registryName, '--image', "admin-ui:$ImageTag")
if ($image.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'The build returned no valid image digest; the console was not updated.' }
$targetImage = "$registryServer/admin-ui@$($image.digest)"
$changed = $targetImage -ne $previousImage
if ($changed) {
    Invoke-Az @('containerapp', 'update', '-g', $ResourceGroup, '-n', $AppName,
        '--container-name', 'admin-ui', '--image', $targetImage, '-o', 'none') | Out-Host
}

$deadline = [DateTime]::UtcNow.AddMinutes(15)
do {
    $after = Read-App
    if ($after.properties.provisioningState -in @('Failed', 'Canceled')) { throw 'Console rollout failed; use the rollback image printed above.' }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Console rollout did not become ready in 15 minutes; use the rollback image printed above.' }
    $ready = $after.properties.provisioningState -eq 'Succeeded' -and
        $after.properties.latestReadyRevisionName -eq $after.properties.latestRevisionName -and
        (-not $changed -or $after.properties.latestReadyRevisionName -ne $before.properties.latestReadyRevisionName)
    if (-not $ready) { Start-Sleep -Seconds 15 }
} until ($ready)

if (($after.properties.template.containers | Where-Object { $_.name -eq 'admin-ui' }).image -ne $targetImage) {
    throw 'The console image differs from the requested digest; update was not verified.'
}
$afterSnapshot = Snapshot $after (Read-Auth)
if ($afterSnapshot -cne $snapshot) {
    $oldSettings = $snapshot | ConvertFrom-Json
    $newSettings = $afterSnapshot | ConvertFrom-Json
    $differences = @($oldSettings.PSObject.Properties.Name | Where-Object {
        ($oldSettings.$_ | ConvertTo-Json -Depth 100 -Compress) -cne ($newSettings.$_ | ConvertTo-Json -Depth 100 -Compress)
    })
    throw "Console settings changed unexpectedly ($($differences -join ', ')); do not report the update as verified. Review the rollback image above."
}
$revision = Get-AzJson @('containerapp', 'revision', 'show', '-g', $ResourceGroup, '-n', $AppName,
    '--revision', $after.properties.latestReadyRevisionName)
if ($revision.properties.healthState -ne 'Healthy') { throw 'The new console revision is not Healthy; use the rollback image printed above.' }
Write-Host "$(if ($changed) { 'Update complete' } else { 'Already up to date' }): $($after.properties.latestReadyRevisionName) is Healthy; authentication, ingress, secrets, identity and environment are unchanged."
Write-Host 'Gateway, database, app registrations, role grants and scheduled jobs were not modified.'
