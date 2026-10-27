<#
.SYNOPSIS
    Builds and deploys the admin-ui (ADR-0008): a web UI for the gateway's spend-limits admin API and Entra
    developer-role management, hosted as a second Container App in the gateway's own existing environment.

.DESCRIPTION
    Four steps, each printed as it runs:
      1. Build the image in the existing ACR (az acr build - no local Docker needed).
      2. Read what the Bicep template needs from the already-deployed gateway: its service principal ID, the Entra
         app manifest's roles, the admin file's content, and the admin.write_keys secret value the gateway container
         already holds (so both sides use the identical key - this script never invents a second one).
      3. Deploy admin-ui/infra/main.bicep.
      4. Grant the new identity's Microsoft Graph application permissions: AppRoleAssignment.ReadWrite.All, Application.Read.All,
         User.Read.All, Application.ReadWrite.OwnedBy. The first three are Microsoft's documented "least privileged" set for the
         POST /servicePrincipals/{id}/appRoleAssignedTo call set-developer.mjs's logic makes
         (https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto) - AppRoleAssignment.ReadWrite.All
         is itself a highly privileged grant (it can manage permission grants for any API, not only this one), which
         is a real trade-off this script does not hide: see admin-ui/README.md, "Permissions this needs, and why".
         Granting an Entra application permission needs a Global Administrator or Privileged Role Administrator
         (or Cloud Application Administrator with the specific resource's consent already present) - plain Owner
         on the resource group, enough for everything else this script does, is not enough for this one step.

    Idempotent: re-running updates the existing image/app/identity rather than failing; an already-granted Graph
    permission is detected and skipped, not re-granted.

.PARAMETER ResourceGroup
    The resource group the gateway (ca-claude-gw) already runs in.

.PARAMETER EnvironmentName
    The existing Container Apps environment name. Default: cae-claude-gw.

.PARAMETER GatewayAppName
    The existing gateway Container App's name. Default: ca-claude-gw.

.PARAMETER AcrName
    The existing Azure Container Registry name (bare name, not the login server).

.PARAMETER AppRegistrationName
    The gateway's Entra app registration's display name, e.g. claude-apps-gateway-private-d0f9ec
    (infra/azure-private/Deploy-Gateway.ps1 names it <AppRegistration> internally).

.PARAMETER AdminFile
    Path to the rendered admin file. Default: config/gateway-admin.azure-private.json.

.PARAMETER ImageTag
    Image tag to build and deploy. Default: today's date.

.PARAMETER AllowedCidr
    The CIDR admin-ui is reachable from, matching the gateway's own restriction for this environment: the VNet's
    range for the network-restricted deployment (ADR-0005, the default), or a tester CIDR for the ADR-0003 test
    topology, which has no VNet.

.PARAMETER Plan
    Prints what would happen without building, deploying or granting anything.

.PARAMETER Topology
    The topology the gateway's configuration was rendered for: private (default) or test. admin-ui renders the
    configuration it saves with the same value (ADR-0010).

.PARAMETER EnableSignIn
    Turns on Container Apps authentication for admin-ui with its own app registration ("<app>-signin", created if
    missing) carrying the AdminUi.Admin app role. Saving the configuration, creating roles and tagging users need it.

.PARAMETER SignInAdmins
    UPNs to assign the AdminUi.Admin role to, with -EnableSignIn: several values, or one comma-separated value (the form
    pwsh -File passes). Required with -EnableSignIn, so the console always has an administrator who can sign in.

.EXAMPLE
    pwsh -File admin-ui/infra/Deploy-AdminUi.ps1 -ResourceGroup rg-claude-gw-internal -AcrName acrclaudegwd0f9ec -AppRegistrationName claude-apps-gateway-private-d0f9ec
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [string]$EnvironmentName = 'cae-claude-gw',
    [string]$GatewayAppName = 'ca-claude-gw',
    [Parameter(Mandatory = $true)][string]$AcrName,
    [Parameter(Mandatory = $true)][string]$AppRegistrationName,
    [string]$AdminFile = 'config/gateway-admin.azure-private.json',
    [string]$ImageTag = (Get-Date -Format 'yyyy-MM-dd'),
    [string]$AllowedCidr = '10.40.0.0/16',
    [ValidateSet('test', 'private')][string]$Topology = 'private',
    [switch]$EnableSignIn,
    [string[]]$SignInAdmins = @(),
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AdminAppName = 'ca-admin-ui'
$GRAPH_SP_APP_ID = '00000003-0000-0000-c000-000000000000' # Microsoft Graph's own appId: universal, not tenant-specific.
# Live-verified against this Entra tenant's own Microsoft Graph service principal (not a hardcoded guess): the
# appRole id of each permission VALUE is part of Microsoft Graph's own app manifest and is identical in every tenant,
# even though the service principal's own object id (looked up below, not here) is tenant-specific.
# Application.ReadWrite.OwnedBy (ADR-0010): creating app roles on the gateway's registration, which this script makes
# admin-ui an owner of; it reaches no other application. https://learn.microsoft.com/en-us/graph/permissions-reference
$NEEDED_GRAPH_ROLES = @(
    @{ Value = 'AppRoleAssignment.ReadWrite.All'; Id = '06b708a9-e830-4db3-a914-8e69da51d44f' },
    @{ Value = 'Application.Read.All'; Id = '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30' },
    @{ Value = 'User.Read.All'; Id = 'df021288-bdef-4463-88db-98f22de89214' },
    @{ Value = 'Application.ReadWrite.OwnedBy'; Id = '18a4783c-866b-4cc7-a460-3d5e5662c884' }
)
# ADR-0015: business-unit tags live in the gateway database, so admin-ui never needs User.ReadWrite.All.

function Step([string]$Name, [scriptblock]$Body) {
    Write-Host "== $Name =="
    if ($Plan) { Write-Host '  (plan: not run)'; return $null }
    & $Body
}

Write-Host "=== admin-ui deploy: $ResourceGroup / $EnvironmentName ==="

# Checked before any Azure call (T-117): with sign-in on and no administrator, nobody could open the console.
$SignInAdmins = @($SignInAdmins -join ',' -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($EnableSignIn) {
    if (-not $SignInAdmins.Count) { throw '-EnableSignIn needs -SignInAdmins <upn>[,<upn>]: the people who may open the console (the AdminUi.Admin role). Nothing was changed.' }
    $notUpn = @($SignInAdmins | Where-Object { $_ -notmatch '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' })
    if ($notUpn.Count) { throw "-SignInAdmins holds values that are not user principal names (name@domain): $($notUpn -join ', '). Nothing was changed." }
    Write-Host "  administrators: $($SignInAdmins -join ', ')"
}

$acrLoginServer = (az acr show -g $ResourceGroup -n $AcrName --query loginServer -o tsv)
if (-not $acrLoginServer) { throw "ACR $AcrName was not found in $ResourceGroup." }

$imageDigest = $null
Step 'Build image' {
    az acr build --registry $AcrName --image "admin-ui:$ImageTag" --file (Join-Path $root 'admin-ui\Dockerfile') $root | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'az acr build failed.' }
    # A mutable tag (e.g. today's date) does not by itself make Container Apps re-pull on a same-day rebuild: with an
    # unchanged image-reference string, ARM sees no template change and keeps serving the old container (live-found
    # 2026-10-16: a revision's createdTime was unchanged across two redeploys 30 minutes apart, same tag, new
    # digest). Pinning to the digest forces a real update every time.
    $script:imageDigest = (az acr repository show -n $AcrName --image "admin-ui:$ImageTag" --query digest -o tsv)
    if (-not $script:imageDigest) { throw "Could not read the digest just pushed for admin-ui:$ImageTag." }
}

$gatewaySpId = $null; $gatewayAppObjectId = $null; $appId = $null; $appRolesJson = $null; $adminWriteKey = $null; $adminFileJson = $null; $graphSpId = $null
Step 'Read gateway context' {
    Import-Module (Join-Path $PSScriptRoot 'AppLookup.psm1'); $script:appId = Select-AppIdByName -Apps (az ad app list --display-name $AppRegistrationName -o json | ConvertFrom-Json) -Name $AppRegistrationName
    if (-not $script:appId) { throw "No Entra app registration named $AppRegistrationName." }
    $script:gatewayAppObjectId = (az ad app show --id $script:appId --query id -o tsv)
    $script:gatewaySpId = (az ad sp show --id $script:appId --query id -o tsv)
    $manifestRoles = (az ad app show --id $script:appId --query 'appRoles[].{id:id,value:value}' -o json | ConvertFrom-Json)
    $script:appRolesJson = ConvertTo-Json -Compress @($manifestRoles)
    $script:adminWriteKey = (az containerapp secret show -g $ResourceGroup -n $GatewayAppName --secret-name admin-write-key --query value -o tsv)
    if (-not $script:adminWriteKey) { throw "The gateway's admin-write-key secret was not found - deployment.adminApi must be true and the app step must have run (infra/azure-private/Deploy-Gateway.ps1 -Step app)." }
    $script:adminFileJson = [IO.File]::ReadAllText((Join-Path $root $AdminFile))
    $script:graphSpId = (az ad sp show --id $GRAPH_SP_APP_ID --query id -o tsv)
    Write-Host "  gateway service principal: $($script:gatewaySpId)"
}

# The environment's own internal DNS name for the gateway app (http://<app-name>), not its public HTTPS FQDN:
# calling the public FQDN from another app in the *same* environment hit a live, Consumption-topology-specific
# bug (U-73-adjacent, found 2026-10-17) - Container Apps' own platform-level ipSecurityRestrictions (set from
# --tester-cidr for the ADR-0003 topology) rejects the request, since intra-environment traffic arrives from the
# environment's own reserved routing range (measured 100.100.0.190), not the calling app's address. The internal
# name stays inside the platform's own network fabric and is unaffected by either side's ingress restrictions.
$gatewayUrl = "http://$GatewayAppName"

# ADR-0010: admin-ui's own sign-in registration, separate from the gateway's so the gateway's roles never grant admin
# rights. ID tokens only, no client secret; appRoleAssignmentRequired stops users without AdminUi.Admin signing in.
$signInClientId = ''
if ($EnableSignIn) {
    Step 'Ensure the admin-ui sign-in app registration' {
        $domain = (az containerapp env show -g $ResourceGroup -n $EnvironmentName --query properties.defaultDomain -o tsv)
        if (-not $domain) { throw "Could not read the default domain of $EnvironmentName." }
        $redirect = "https://$AdminAppName.$domain/.auth/login/aad/callback"
        $name = "$AppRegistrationName-admin-ui-signin"
        $script:signInClientId = Select-AppIdByName -Apps (az ad app list --display-name $name -o json | ConvertFrom-Json) -Name $name
        if (-not $script:signInClientId) {
            $rolesFile = [IO.Path]::GetTempFileName()
            try {
                ConvertTo-Json -Depth 5 @(@{ id = [guid]::NewGuid().ToString(); value = 'AdminUi.Admin'; displayName = 'admin-ui administrator'; description = 'Can use admin-ui: read spend and chargeback, set caps, grant gateway roles, change the gateway configuration and tag users (ADR-0011).'; isEnabled = $true; allowedMemberTypes = @('User') }) | Set-Content -Path $rolesFile -Encoding utf8
                $script:signInClientId = (az ad app create --display-name $name --sign-in-audience AzureADMyOrg --web-redirect-uris $redirect --enable-id-token-issuance true --app-roles "@$rolesFile" --query appId -o tsv)
            } finally { Remove-Item $rolesFile -Force -ErrorAction SilentlyContinue }
            if (-not $script:signInClientId) { throw "Creating the app registration $name failed." }
            Write-Host "  created: $name ($($script:signInClientId))"
        } else { Write-Host "  exists: $name ($($script:signInClientId))" }
        $spId = (az ad sp show --id $script:signInClientId --query id -o tsv 2>$null)
        if (-not $spId) { $spId = (az ad sp create --id $script:signInClientId --query id -o tsv) }
        az ad sp update --id $spId --set appRoleAssignmentRequired=true | Out-Null
        $roleId = @(az ad app show --id $script:signInClientId --query appRoles -o json | ConvertFrom-Json | Where-Object value -eq 'AdminUi.Admin')[0].id
        if (-not $roleId) { throw 'The sign-in app registration has no AdminUi.Admin app role.' }
        $bodyFile = [IO.Path]::GetTempFileName()
        try {
            foreach ($upn in $SignInAdmins) {
                $userId = (az ad user show --id $upn --query id -o tsv)
                if (-not $userId) { throw "No Entra user $upn." }
                $have = @(az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo" --query value -o json | ConvertFrom-Json | Where-Object { $_.principalId -eq $userId -and $_.appRoleId -eq $roleId })[0]
                if ($have) { Write-Host "  already admin: $upn"; continue }
                @{ principalId = $userId; resourceId = $spId; appRoleId = $roleId } | ConvertTo-Json -Compress | Set-Content -Path $bodyFile -Encoding utf8 -NoNewline
                az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo" --body "@$bodyFile" --headers 'Content-Type=application/json' | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "Assigning AdminUi.Admin to $upn failed." }
                Write-Host "  admin: $upn"
            }
        } finally { Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue }
    }
}
if (-not $EnableSignIn) {
    Write-Warning 'Sign-in is off: admin-ui is not limited to administrators. Anyone in the allowed IP range can read spend, set caps and grant gateway roles (ADR-0008). Run again with -EnableSignIn -SignInAdmins <upn> to require the AdminUi.Admin role (ADR-0011).'
}

$identityPrincipalId = $null
Step 'Deploy Bicep' {
    $paramFile = [IO.Path]::GetTempFileName()
    @{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = @{
            environmentName           = @{ value = $EnvironmentName }
            acrLoginServer            = @{ value = $acrLoginServer }
            acrName                   = @{ value = $AcrName }
            imageTag                  = @{ value = "admin-ui@$imageDigest" }
            gatewayUrl                = @{ value = $gatewayUrl }
            gatewayServicePrincipalId = @{ value = $gatewaySpId }
            gatewayAppRolesJson       = @{ value = $appRolesJson }
            gatewayAdminFileJson      = @{ value = $adminFileJson }
            gatewayAdminWriteKey      = @{ value = $adminWriteKey }
            allowedCidr               = @{ value = $AllowedCidr }
            gatewayAppName            = @{ value = $GatewayAppName }
            gatewayTopology           = @{ value = $Topology }
            gatewayAdminFilePath      = @{ value = ($AdminFile -replace '\\', '/') }
            enableSignIn              = @{ value = [bool]$EnableSignIn }
            signInClientId            = @{ value = $signInClientId }
        }
    } | ConvertTo-Json -Depth 10 | Set-Content -Path $paramFile -Encoding utf8
    $result = az deployment group create -g $ResourceGroup --template-file (Join-Path $root 'admin-ui\infra\main.bicep') --parameters "@$paramFile" -o json | ConvertFrom-Json
    Remove-Item $paramFile -Force
    if ($LASTEXITCODE -ne 0) { throw 'Bicep deployment failed.' }
    $script:identityPrincipalId = $result.properties.outputs.identityPrincipalId.value
    Write-Host "  admin-ui: https://$($result.properties.outputs.fqdn.value)"
    Write-Host "  identity principal: $($script:identityPrincipalId)"
}

Step 'Grant Microsoft Graph application permissions (needs Global Administrator or Privileged Role Administrator)' {
    $assignments = (az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$identityPrincipalId/appRoleAssignments" --query 'value[].{id:id,appRoleId:appRoleId,resourceId:resourceId}' -o json | ConvertFrom-Json)
    $existing = @($assignments | Where-Object { $_.resourceId -eq $graphSpId } | ForEach-Object appRoleId)
    # A body passed inline (--body $json) goes through az.cmd's cmd.exe re-parse on Windows, which mangles the
    # embedded quotes; @file (az rest's own documented form for this) sidesteps that entirely.
    $bodyFile = [IO.Path]::GetTempFileName()
    try {
        foreach ($role in $NEEDED_GRAPH_ROLES) {
            if ($existing -contains $role.Id) { Write-Host "  already granted: $($role.Value)"; continue }
            @{ principalId = $identityPrincipalId; resourceId = $graphSpId; appRoleId = $role.Id } | ConvertTo-Json -Compress | Set-Content -Path $bodyFile -Encoding utf8 -NoNewline
            $out = az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId/appRoleAssignedTo" --body "@$bodyFile" --headers 'Content-Type=application/json' 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Granting $($role.Value) failed (needs Global Administrator or Privileged Role Administrator, among other possible causes): $out" }
            Write-Host "  granted: $($role.Value)"
        }
    } finally {
        Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
    }
    # An install before ADR-0015 could grant User.ReadWrite.All on request. It is no longer used; removing an
    # app role assignment needs the same administrator as granting one, so the command is printed, not run.
    $LEGACY_USER_WRITE = '741f803b-c850-494e-b5df-cde7c675a1ca'
    foreach ($legacy in @($assignments | Where-Object { $_.resourceId -eq $graphSpId -and $_.appRoleId -eq $LEGACY_USER_WRITE })) {
        Write-Warning "admin-ui still holds User.ReadWrite.All from an earlier install; it is not used (ADR-0015). A Privileged Role Administrator removes it with: az rest --method delete --url `"https://graph.microsoft.com/v1.0/servicePrincipals/$identityPrincipalId/appRoleAssignments/$($legacy.id)`""
    }
}

# Application.ReadWrite.OwnedBy reaches only applications admin-ui owns (U-86), so it becomes an owner of the gateway's.
Step 'Make admin-ui an owner of the gateway app registration' {
    $owners = @(az rest --method get --url "https://graph.microsoft.com/v1.0/applications/$gatewayAppObjectId/owners" --query 'value[].id' -o json | ConvertFrom-Json)
    if ($owners -contains $identityPrincipalId) { Write-Host '  already an owner'; return }
    $bodyFile = [IO.Path]::GetTempFileName()
    try {
        @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$identityPrincipalId" } | ConvertTo-Json -Compress | Set-Content -Path $bodyFile -Encoding utf8 -NoNewline
        $out = az rest --method post --url "https://graph.microsoft.com/v1.0/applications/$gatewayAppObjectId/owners/`$ref" --body "@$bodyFile" --headers 'Content-Type=application/json' 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Adding admin-ui as an owner of $AppRegistrationName failed: $out" }
        Write-Host '  added as owner'
    } finally {
        Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '=== done ==='
