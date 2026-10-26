<#
.SYNOPSIS
    Stage-based installer (ADR-0009, T-91): renders the operator's admin file, then runs the test deployment's
    already-proven scripts in a fixed order - config (scripts/admin/new-gateway-config.mjs), base, entra, image, app
    (infra/azure-test/deploy.mjs), budgets (scripts/admin/bootstrap-budgets.mjs), admin-ui
    (admin-ui/infra/Deploy-AdminUi.ps1) - and nothing else. No az, ARM or Graph call of its own: only sequencing,
    -Plan preview and a clean stop, naming the Azure portal or Cloud Shell fallback, when a stage fails.

.DESCRIPTION
    config touches no Azure resource and runs first, so an admin file the renderer refuses stops the install before
    anything is created; app deploys that rendering (deploy.mjs --config), and requesting app runs config too, so a
    stale rendering is never deployed. budgets runs before admin-ui, whose last step grants Microsoft Graph application
    permissions that need a directory role many operators do not hold (docs/UNKNOWNS.md, U-75): a refusal there leaves
    every other stage done. Each stage is independently idempotent (ADR-0003, ADR-0008), so re-running after a stage
    was fixed by hand repeats only what is still needed. Every stage runs from the repository root.

    base, entra, image and app build the single-tenant ADR-0003 test topology. deploy.mjs refuses to redeploy an app
    that holds settings its template does not define, such as a cross-tenant Foundry credential (U-80).

.PARAMETER ResourceGroup
    The resource group every stage targets.

.PARAMETER AdminFile
    The admin file: roles, models, policies, deployment and budgets (docs/learn/how-to-admin-configure.md).

.PARAMETER TesterCidr
    Passed to deploy.mjs --tester-cidr; required when base, entra, image or app is requested.

.PARAMETER ConfigFile
    Where config writes the rendering that app deploys. Default: gateway-admin.<name>.json renders to
    gateway.<name>.yaml next to it; any other admin file name to <name>.gateway.yaml.

.PARAMETER AppRegistrationName
    The Entra app registration's display name, given to deploy.mjs --app-display-name and Deploy-AdminUi.ps1.
    Default: claude-apps-gateway-test, deploy.mjs's own default.

.PARAMETER Location
    Passed to deploy.mjs --location when given.

.PARAMETER FoundryResourceGroup
    Passed to deploy.mjs --foundry-resource-group when given.

.PARAMETER FoundryAccount
    Passed to deploy.mjs --foundry-account when given.

.PARAMETER EmailDomain
    Passed to deploy.mjs --email-domain when given; needed when the signed-in account has no mail address.

.PARAMETER AcrName
    The registry for admin-ui's image. Default: the acrName the base stage records in deploy.mjs's state file.

.PARAMETER GatewayAppName
    Forwarded to bootstrap-budgets.mjs and Deploy-AdminUi.ps1. Default: ca-claude-gw.

.PARAMETER EnvironmentName
    Forwarded to Deploy-AdminUi.ps1. Default: cae-claude-gw, the environment the test template creates.

.PARAMETER AllowedCidr
    The range admin-ui admits, forwarded to Deploy-AdminUi.ps1. Default: -TesterCidr, since the test topology has no
    virtual network.

.PARAMETER SignInAdmins
    The people who may open the admin console, as user principal names (name@domain), comma-separated. Required for the
    admin-ui stage: the console is admin-only (ADR-0011), and each one gets the AdminUi.Admin role.

.PARAMETER NoSignIn
    Deploys the admin console without sign-in, so anyone inside -AllowedCidr can use it (ADR-0008). Not for a console
    that holds real spend data.

.PARAMETER ClientSecretDays
    Lifetime in days, 1 to 30, of the gateway's Entra client secret, which the app stage creates (7 when absent). The
    app stage renews it when it runs with less than a day left, so it runs again before the secret ends.

.PARAMETER RotateClientSecret
    Passed to deploy.mjs --rotate-client-secret for app: a new client secret now, whatever the current one's end date.

.PARAMETER DatabaseLocation
    Passed to deploy.mjs --database-location for the app stage: the region of the managed database when the admin file
    sets deployment.database to "managed" and the gateway's region refuses its size (docs/UNKNOWNS.md, U-105).

.PARAMETER Steps
    Which stages to run: config, base, entra, image, app, budgets, admin-ui. Default: all seven.

.PARAMETER Plan
    Prints the command line of every requested stage and runs none of them.

.EXAMPLE
    pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -TesterCidr 203.0.113.0/26
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [Parameter(Mandatory = $true)][string]$AdminFile,
    [string]$TesterCidr,
    [string]$ConfigFile,
    [string]$AppRegistrationName = 'claude-apps-gateway-test',
    [string]$Location,
    [string]$FoundryResourceGroup,
    [string]$FoundryAccount,
    [string]$EmailDomain,
    [string]$AcrName,
    [string]$GatewayAppName = 'ca-claude-gw',
    [string]$EnvironmentName = 'cae-claude-gw',
    [string]$AllowedCidr,
    [string]$SignInAdmins,
    [switch]$NoSignIn,
    [string]$DatabaseLocation,
    [ValidateRange(1, 30)][int]$ClientSecretDays,
    [switch]$RotateClientSecret,
    [string[]]$Steps = @('config', 'base', 'entra', 'image', 'app', 'budgets', 'admin-ui'),
    [switch]$Plan,
    # Overridable for testing (tests/install-orchestrator.test.mjs); default to the real scripts and state (ADR-0009).
    [string]$ConfigScript = (Join-Path $PSScriptRoot '..' '..' 'scripts' 'admin' 'new-gateway-config.mjs'),
    [string]$DeployScript = (Join-Path $PSScriptRoot 'deploy.mjs'),
    [string]$BudgetsScript = (Join-Path $PSScriptRoot '..' '..' 'scripts' 'admin' 'bootstrap-budgets.mjs'),
    [string]$AdminUiScript = (Join-Path $PSScriptRoot '..' '..' 'admin-ui' 'infra' 'Deploy-AdminUi.ps1'),
    [string]$StateDir = (Join-Path $PSScriptRoot '.state')
)
$ErrorActionPreference = 'Stop'
$ORDER = @('config', 'base', 'entra', 'image', 'app', 'budgets', 'admin-ui')
$DEPLOY = @('base', 'entra', 'image', 'app')
$DOC = 'docs/learn/how-to-install-stage-by-stage.md'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path

# Deploy-AdminUi.ps1 passes these values to az, a .cmd file on Windows whose arguments cmd.exe parses again, so one of
# & | < > ^ % " or a line break in a value would run as a command; such a value is refused before anything runs.
function Assert-PlainValue([string]$Name, [string]$Value) {
    if ($Value -match '[&|<>^%"\r\n]') { throw "-$Name holds a character cmd.exe interprets (& | < > ^ % `" or a line break); nothing was run." }
}

# A comma-joined list (deploy.mjs's own --step convention) and several -Steps values both work: PowerShell does not
# split a comma inside one external argument on its own.
$Steps = @($Steps -join ',' -split ',' | Where-Object { $_ })
$unknown = $Steps | Where-Object { $ORDER -notcontains $_ }
if ($unknown) { throw "unknown step(s) $($unknown -join ', '); use $($ORDER -join ', ')" }
if ($Steps -contains 'app') { $Steps += 'config' }
$requested = @($ORDER | Where-Object { $Steps -contains $_ })

$adminFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AdminFile)
if (-not (Test-Path -LiteralPath $adminFull -PathType Leaf)) { throw "-AdminFile $AdminFile does not exist; nothing was run." }
$adminRel = [IO.Path]::GetRelativePath($root, $adminFull)
if (-not $ConfigFile) {
    $name = [IO.Path]::GetFileName($adminRel)
    $out = if ($name -match '^gateway-admin\.(.+)\.json$') { "gateway.$($Matches[1]).yaml" } else { "$([IO.Path]::GetFileNameWithoutExtension($name)).gateway.yaml" }
    $configRel = [IO.Path]::Combine([IO.Path]::GetDirectoryName($adminRel), $out)
} else {
    $configRel = [IO.Path]::GetRelativePath($root, $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ConfigFile))
}
if ([IO.Path]::IsPathRooted($adminRel) -or [IO.Path]::IsPathRooted($configRel)) { throw 'the admin and configuration files must be on the same drive as the repository; nothing was run.' }
# A later run without -TesterCidr keeps the range the deployment already admits, from the state deploy.mjs records, so a
# day-2 run does not narrow the gateway and the console to this machine's address.
if (-not $TesterCidr) {
    $recordedState = Join-Path $StateDir "$ResourceGroup.json"
    if (Test-Path -LiteralPath $recordedState) {
        $TesterCidr = (Get-Content -Raw -LiteralPath $recordedState | ConvertFrom-Json).testerCidr
        if ($TesterCidr) { Write-Host "tester range: recorded range $TesterCidr ($recordedState)" }
    }
}
if (-not $AllowedCidr) { $AllowedCidr = $TesterCidr }

$values = [ordered]@{ ResourceGroup = $ResourceGroup; AdminFile = $adminRel; ConfigFile = $configRel; TesterCidr = $TesterCidr
    AppRegistrationName = $AppRegistrationName; Location = $Location; FoundryResourceGroup = $FoundryResourceGroup; FoundryAccount = $FoundryAccount
    EmailDomain = $EmailDomain; AcrName = $AcrName; GatewayAppName = $GatewayAppName; EnvironmentName = $EnvironmentName; AllowedCidr = $AllowedCidr
    SignInAdmins = $SignInAdmins; DatabaseLocation = $DatabaseLocation }
foreach ($key in $values.Keys) { Assert-PlainValue $key $values[$key] }
if (($requested | Where-Object { $DEPLOY -contains $_ }) -and -not $TesterCidr) { throw "-TesterCidr is required for the $($DEPLOY -join ', ') steps, or a run where $StateDir\$ResourceGroup.json records the range." }
# base grants the gateway's identity a role on the Foundry account and app points the gateway at it; deploy.mjs's own
# defaults name this project's test account, so a first install names its own.
if (($requested | Where-Object { @('base', 'app') -contains $_ }) -and -not ($FoundryResourceGroup -and $FoundryAccount)) {
    throw '-FoundryResourceGroup and -FoundryAccount are required for the base and app steps: the resource group and name of your Microsoft Foundry account; nothing was run.'
}
if (($requested -contains 'admin-ui') -and -not $AllowedCidr) { throw '-AllowedCidr or -TesterCidr is required for the admin-ui step.' }
if (($requested -contains 'admin-ui') -and -not $NoSignIn -and -not $SignInAdmins) {
    throw '-SignInAdmins <upn>[,<upn>] is required for the admin-ui step: the people who may open the admin console (ADR-0011). -NoSignIn deploys it without sign-in instead; nothing was run.'
}
if ($DatabaseLocation -and $DatabaseLocation -notmatch '^[a-z0-9]+$') { throw "-DatabaseLocation takes an Azure region name such as centralus, not '$DatabaseLocation'; nothing was run." }

try { $admin = Get-Content -Raw -LiteralPath $adminFull | ConvertFrom-Json } catch { throw "-AdminFile $AdminFile is not readable JSON: $($_.Exception.Message)" }
$declaresBudgets = $null -ne $admin.PSObject.Properties['budgets'] -and @($admin.budgets).Count -gt 0
$adminApi = $null -ne $admin.deployment -and $admin.deployment.adminApi -eq $true
if ((($requested -contains 'admin-ui') -or (($requested -contains 'budgets') -and $declaresBudgets)) -and -not $adminApi) {
    throw "the admin-ui and budgets steps need the gateway's admin API: set deployment.adminApi to true in $AdminFile (ADR-0008); nothing was run."
}

# admin-ui's registry is the one base created, read from the state deploy.mjs writes, after base has run.
function Resolve-AcrName {
    if ($AcrName) { return $AcrName }
    $state = Join-Path $StateDir "$ResourceGroup.json"
    if (Test-Path -LiteralPath $state) {
        $recorded = (Get-Content -Raw -LiteralPath $state | ConvertFrom-Json).acrName
        if ($recorded) { Assert-PlainValue 'AcrName' $recorded; return $recorded }
    }
    if ($Plan) { return '<acrName the base stage records>' }
    throw "no registry is recorded for $ResourceGroup in $state; run the base stage first, or pass -AcrName."
}

function Invoke-Stage([string]$Name, [string]$Command, [string[]]$CommandArgs) {
    Write-Host "== $Name =="
    Write-Host "  $Command $($CommandArgs -join ' ')"
    if ($Plan) { return }
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "stage '$Name' failed (exit $LASTEXITCODE). See $DOC#$Name for the Azure portal or Cloud Shell steps to do this by hand, then re-run with -Steps naming '$Name' and the stages after it."
    }
}

$deployArgs = @('--resource-group', $ResourceGroup, '--app-display-name', $AppRegistrationName)
if ($Location) { $deployArgs += @('--location', $Location) }
if ($FoundryResourceGroup) { $deployArgs += @('--foundry-resource-group', $FoundryResourceGroup) }
if ($FoundryAccount) { $deployArgs += @('--foundry-account', $FoundryAccount) }
if ($EmailDomain) { $deployArgs += @('--email-domain', $EmailDomain) }

Push-Location $root
try {
    foreach ($step in $requested) {
        if ($step -eq 'config') {
            Invoke-Stage 'config' 'node' @($ConfigScript, '--topology', 'test', '--admin', $adminRel, '--out', $configRel)
        } elseif ($DEPLOY -contains $step) {
            $extra = if ($step -eq 'app') { @('--config', $configRel) + $(if ($DatabaseLocation) { @('--database-location', $DatabaseLocation) } else { @() }) + $(if ($ClientSecretDays) { @('--client-secret-days', "$ClientSecretDays") } else { @() }) + $(if ($RotateClientSecret) { @('--rotate-client-secret') } else { @() }) } else { @() }
            Invoke-Stage $step 'node' (@($DeployScript, '--tester-cidr', $TesterCidr, '--step', $step) + $deployArgs + $extra)
        } elseif ($step -eq 'budgets') {
            Invoke-Stage 'budgets' 'node' @($BudgetsScript, '--admin', $adminRel, '--resource-group', $ResourceGroup, '--gateway-app', $GatewayAppName)
        } else {
            $signIn = if ($NoSignIn) { @() } else { @('-EnableSignIn', '-SignInAdmins', $SignInAdmins) }
            Invoke-Stage 'admin-ui' 'pwsh' (@('-NoProfile', '-File', $AdminUiScript, '-ResourceGroup', $ResourceGroup, '-EnvironmentName', $EnvironmentName,
                '-GatewayAppName', $GatewayAppName, '-AcrName', (Resolve-AcrName), '-AppRegistrationName', $AppRegistrationName, '-AdminFile', $adminRel,
                '-AllowedCidr', $AllowedCidr, '-Topology', 'test') + $signIn)
        }
    }
} finally {
    Pop-Location
}
Write-Host $(if ($Plan) { "=== plan: $($requested.Count) stage(s) would run ===" } else { '=== install complete ===' })
