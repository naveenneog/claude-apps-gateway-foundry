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
    Limits the gateway to this range (a /24 or narrower), passed to deploy.mjs --tester-cidr. Optional: without it a new
    install admits every address and relies on Entra sign-in with a gateway role (ADR-0017). A later run without it keeps
    the range the state file records.

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
    Limits the admin console to this range, forwarded to Deploy-AdminUi.ps1. Optional with sign-in: without it a new
    install admits every address and relies on Entra sign-in with AdminUi.Admin (ADR-0017). Required with -NoSignIn,
    where it defaults to -TesterCidr.

.PARAMETER SignInAdmins
    The people who may open the admin console, as user principal names (name@domain), comma-separated. Required for the
    admin-ui stage: the console is admin-only (ADR-0011), and each one gets the AdminUi.Admin role.

.PARAMETER UseExistingResourceGroup
    Installs into a resource group that already exists and was not created by this installer, such as one that holds the
    Foundry account (ADR-0018). The base stage stops if the group holds a resource named like one the installer creates;
    the installer's resources carry this install's runId tag, and teardown removes only those, never the group. Later
    runs do not need the switch again.

.PARAMETER ConsoleAllowAnyAddress
    Deploys the admin console with no IP rule (ADR-0017), so administrators reach it from any network; it still requires
    Entra sign-in with the AdminUi.Admin role. This is the default for a new install; the switch reopens a console that an
    earlier run limited to a range. Recorded in the state file, so later runs keep it. Refused with -NoSignIn or
    -AllowedCidr.

.PARAMETER GatewayAllowAnyAddress
    Deploys the gateway with no IP rule (ADR-0017); it still requires Entra sign-in with a gateway role. This is the
    default for a new install; the switch reopens a gateway that an earlier run limited with -TesterCidr. Refused with
    -TesterCidr.

.PARAMETER NoSignIn
    Deploys the admin console without sign-in, so anyone inside -AllowedCidr can use it (ADR-0008). Not for a console
    that holds real spend data.

.PARAMETER SignInCredential
    How the gateway signs in to Microsoft Entra (ADR-0016): certificate, a self-signed certificate the app stage makes and
    registers on the app registration, or secret, a client secret. Absent: a new install uses a certificate and falls back
    to a client secret if the certificate cannot be made or registered; an install that already uses a secret keeps it.

.PARAMETER CredentialValidityMonths
    Validity of a new sign-in certificate, 1 to 24 months (12 when absent). The app stage, and the console's renewal job,
    replace it 30 days before it ends.

.PARAMETER ClientSecretDays
    Lifetime in days, 1 to 365, of the gateway's Entra client secret when it signs in with one (365 when absent). A tenant
    app management policy can refuse a long secret; the app stage then says so. The renewal job replaces it 30 days before
    it ends.

.PARAMETER RotateClientSecret
    Passed to deploy.mjs --rotate-client-secret for app: a new sign-in certificate or client secret now, whatever the
    current one's end date.

.PARAMETER DatabaseLocation
    The region, or a comma-separated list of regions tried in order (for example eastus,centralus,westus3), for the managed
    database when the admin file sets deployment.database to "managed" (ADR-0018). The preflight stage skips a region that
    does not offer the database to the subscription; the base stage creates the database first and moves to the next region
    when one refuses it. Default: the install region (-Location).

.PARAMETER Steps
    Which stages to run: config, preflight, base, entra, image, app, budgets, admin-ui. Default: all eight.

.PARAMETER Plan
    Runs the read-only preflight stage (ADR-0018) and prints the command line of every other requested stage, which it
    does not run. Nothing in Azure or Entra is changed.

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
    [switch]$UseExistingResourceGroup,
    [switch]$ConsoleAllowAnyAddress,
    [switch]$GatewayAllowAnyAddress,
    [string]$DatabaseLocation,
    [ValidateSet('certificate', 'secret')][string]$SignInCredential,
    [ValidateRange(1, 24)][int]$CredentialValidityMonths,
    [ValidateRange(1, 365)][int]$ClientSecretDays,
    [switch]$RotateClientSecret,
    [string[]]$Steps = @('config', 'preflight', 'base', 'entra', 'image', 'app', 'budgets', 'admin-ui'),
    [switch]$Plan,
    # Overridable for testing (tests/install-orchestrator.test.mjs); default to the real scripts and state (ADR-0009).
    [string]$ConfigScript = (Join-Path $PSScriptRoot '..' '..' 'scripts' 'admin' 'new-gateway-config.mjs'),
    [string]$DeployScript = (Join-Path $PSScriptRoot 'deploy.mjs'),
    [string]$BudgetsScript = (Join-Path $PSScriptRoot '..' '..' 'scripts' 'admin' 'bootstrap-budgets.mjs'),
    [string]$AdminUiScript = (Join-Path $PSScriptRoot '..' '..' 'admin-ui' 'infra' 'Deploy-AdminUi.ps1'),
    [string]$StateDir = (Join-Path $PSScriptRoot '.state')
)
$ErrorActionPreference = 'Stop'
$ORDER = @('config', 'preflight', 'base', 'entra', 'image', 'app', 'budgets', 'admin-ui')
$DEPLOY = @('preflight', 'base', 'entra', 'image', 'app')
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
# ADR-0018: -Plan, and any run that creates or redeploys the gateway, runs the read-only checks first.
if ($Plan -or ($Steps | Where-Object { @('base', 'app') -contains $_ })) { $Steps += 'preflight' }
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
# ADR-0017, revised 2026-11-03: a new install opens the gateway and the console to every address; -TesterCidr and
# -AllowedCidr restrict them. A later run keeps what the state file records, so it never widens an install by itself.
if ($GatewayAllowAnyAddress -and $TesterCidr) { throw '-GatewayAllowAnyAddress and -TesterCidr contradict each other: pass one; nothing was run.' }
if ($ConsoleAllowAnyAddress -and $AllowedCidr) { throw '-ConsoleAllowAnyAddress and -AllowedCidr contradict each other: pass one; nothing was run.' }
if ($ConsoleAllowAnyAddress -and $NoSignIn) { throw '-ConsoleAllowAnyAddress needs sign-in: with -NoSignIn the console would be open to every address with no check; nothing was run.' }
$stateFile = Join-Path $StateDir "$ResourceGroup.json"
$recorded = if (Test-Path -LiteralPath $stateFile) { Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } else { $null }
$gatewayAny = [bool]$GatewayAllowAnyAddress
if (-not $TesterCidr -and -not $gatewayAny) {
    if ($recorded.testerCidr -and $recorded.testerCidr -ne '0.0.0.0/0') {
        $TesterCidr = $recorded.testerCidr
        Write-Host "tester range: recorded range $TesterCidr ($stateFile)"
    } else { $gatewayAny = $true }
}
if ($gatewayAny) { Write-Host 'gateway: open to every address; Entra sign-in with a gateway role is required' }
if ($NoSignIn) {
    # Without sign-in the console's only protection is its range, as before ADR-0017.
    if (-not $AllowedCidr) { $AllowedCidr = $TesterCidr }
    if (-not $AllowedCidr) { throw '-NoSignIn needs -AllowedCidr (or -TesterCidr): without sign-in the console must be limited to a range; nothing was run.' }
    $consoleAny = $false
} elseif ($ConsoleAllowAnyAddress) { $consoleAny = $true
} elseif ($AllowedCidr) { $consoleAny = $false
} elseif ($recorded -and $null -ne $recorded.consoleAnyAddress) {
    $consoleAny = [bool]$recorded.consoleAnyAddress
    if (-not $consoleAny) { $AllowedCidr = $recorded.consoleCidr }
} elseif ($recorded -and $recorded.testerCidr -and $recorded.testerCidr -ne '0.0.0.0/0') {
    $consoleAny = $false; $AllowedCidr = $recorded.testerCidr  # an install from before ADR-0017 limited the console to the tester range
} else { $consoleAny = $true }
# A console limited to a range is never widened by a run that does not know the range (code review, 2026-11-03).
if (-not $consoleAny -and (-not $AllowedCidr -or $AllowedCidr -eq '0.0.0.0/0')) { throw "the admin console is limited to an address range that $stateFile does not record; pass -AllowedCidr <range>, or -ConsoleAllowAnyAddress to open it; nothing was run." }
if (-not $AllowedCidr) { $AllowedCidr = '0.0.0.0/0' }
if ($consoleAny) { Write-Host 'admin console: open to every address; Entra sign-in with AdminUi.Admin is required' }
$values = [ordered]@{ ResourceGroup = $ResourceGroup; AdminFile = $adminRel; ConfigFile = $configRel; TesterCidr = $TesterCidr
    AppRegistrationName = $AppRegistrationName; Location = $Location; FoundryResourceGroup = $FoundryResourceGroup; FoundryAccount = $FoundryAccount
    EmailDomain = $EmailDomain; AcrName = $AcrName; GatewayAppName = $GatewayAppName; EnvironmentName = $EnvironmentName; AllowedCidr = $AllowedCidr
    SignInAdmins = $SignInAdmins; DatabaseLocation = $DatabaseLocation }
foreach ($key in $values.Keys) { Assert-PlainValue $key $values[$key] }
# base grants the gateway's identity a role on the Foundry account and app points the gateway at it; deploy.mjs's own
# defaults name this project's test account, so a first install names its own.
if (($requested | Where-Object { @('preflight', 'base', 'app') -contains $_ }) -and -not ($FoundryResourceGroup -and $FoundryAccount)) {
    throw '-FoundryResourceGroup and -FoundryAccount are required for the preflight, base and app steps: the resource group and name of your Microsoft Foundry account; nothing was run.'
}
if (($requested -contains 'admin-ui') -and -not $NoSignIn -and -not $SignInAdmins) {
    throw '-SignInAdmins <upn>[,<upn>] is required for the admin-ui step: the people who may open the admin console (ADR-0011). -NoSignIn deploys it without sign-in instead; nothing was run.'
}
if ($DatabaseLocation -and $DatabaseLocation -notmatch '^[a-z0-9]+(,[a-z0-9]+)*$') { throw "-DatabaseLocation takes Azure region names such as centralus, or a comma-separated list such as eastus,centralus,westus3, not '$DatabaseLocation'; nothing was run." }

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

# Records the console's IP choice in the state file deploy.mjs keeps, after the admin-ui stage succeeded.
function Set-ConsoleAnyAddress([bool]$Value) {
    $s = if (Test-Path -LiteralPath $stateFile) { Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json -AsHashtable } else { @{} }
    $s['consoleAnyAddress'] = $Value
    if ($Value) { $s.Remove('consoleCidr') } else { $s['consoleCidr'] = $AllowedCidr }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $s | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $stateFile -Encoding utf8
}

function Invoke-Stage([string]$Name, [string]$Command, [string[]]$CommandArgs) {
    Write-Host "== $Name =="
    Write-Host "  $Command $($CommandArgs -join ' ')"
    if ($Plan -and $Name -ne 'preflight') { return }
    & $Command @CommandArgs
    # Under -Plan a preflight FAIL is reported and the rest of the plan is still printed (ADR-0018).
    if ($LASTEXITCODE -ne 0 -and $Plan) { $script:planProblem = $true; return }
    if ($LASTEXITCODE -ne 0) {
        throw "stage '$Name' failed (exit $LASTEXITCODE). See $DOC#$Name for the Azure portal or Cloud Shell steps to do this by hand, then re-run with -Steps naming '$Name' and the stages after it."
    }
}

$deployArgs = @('--resource-group', $ResourceGroup, '--app-display-name', $AppRegistrationName)
if ($Location) { $deployArgs += @('--location', $Location) }
if ($FoundryResourceGroup) { $deployArgs += @('--foundry-resource-group', $FoundryResourceGroup) }
if ($FoundryAccount) { $deployArgs += @('--foundry-account', $FoundryAccount) }
if ($EmailDomain) { $deployArgs += @('--email-domain', $EmailDomain) }
if ($UseExistingResourceGroup) { $deployArgs += '--use-existing-resource-group' }

$planProblem = $false
Push-Location $root
try {
    foreach ($step in $requested) {
        if ($step -eq 'config') {
            Invoke-Stage 'config' 'node' @($ConfigScript, '--topology', 'test', '--admin', $adminRel, '--out', $configRel)
        } elseif ($DEPLOY -contains $step) {
            $extra = if (@('preflight', 'base') -contains $step) { @('--admin', $adminRel, '--config', $configRel) + $(if ($DatabaseLocation) { @('--database-location', $DatabaseLocation) } else { @() }) } else { @() }
            if ($step -eq 'app') { $extra = @('--config', $configRel) + $(if ($DatabaseLocation) { @('--database-location', $DatabaseLocation) } else { @() }) + $(if ($ClientSecretDays) { @('--client-secret-days', "$ClientSecretDays") } else { @() }) + $(if ($RotateClientSecret) { @('--rotate-client-secret') } else { @() }) + $(if ($SignInCredential) { @('--sign-in', $SignInCredential) } else { @() }) + $(if ($CredentialValidityMonths) { @('--credential-months', "$CredentialValidityMonths") } else { @() }) }
            $range = if ($gatewayAny) { @('--any-address') } else { @('--tester-cidr', $TesterCidr) }
            Invoke-Stage $step 'node' (@($DeployScript) + $range + @('--step', $step) + $deployArgs + $extra)
        } elseif ($step -eq 'budgets') {
            Invoke-Stage 'budgets' 'node' @($BudgetsScript, '--admin', $adminRel, '--resource-group', $ResourceGroup, '--gateway-app', $GatewayAppName)
        } else {
            $signIn = if ($NoSignIn) { @() } else { @('-EnableSignIn', '-SignInAdmins', $SignInAdmins) }
            if ($consoleAny) { $signIn += '-AllowAnyAddress' }
            if ($CredentialValidityMonths) { $signIn += @('-CredentialValidityMonths', "$CredentialValidityMonths") }
            if ($ClientSecretDays) { $signIn += @('-ClientSecretDays', "$ClientSecretDays") }
            Invoke-Stage 'admin-ui' 'pwsh' (@('-NoProfile', '-File', $AdminUiScript, '-ResourceGroup', $ResourceGroup, '-EnvironmentName', $EnvironmentName,
                '-GatewayAppName', $GatewayAppName, '-AcrName', (Resolve-AcrName), '-AppRegistrationName', $AppRegistrationName, '-AdminFile', $adminRel,
                '-AllowedCidr', $AllowedCidr, '-Topology', 'test') + $signIn)
            if (-not $Plan) { Set-ConsoleAnyAddress $consoleAny }
        }
    }
} finally {
    Pop-Location
}
if ($Plan -and $planProblem) {
    Write-Host "=== plan: preflight found a problem (FAIL lines above); fix it before installing. $($requested.Count) stage(s) would run ==="
    exit 1
}
Write-Host $(if ($Plan) { "=== plan: $($requested.Count) stage(s) would run ===" } else { '=== install complete ===' })
