<#
.SYNOPSIS
    A stand-in for admin-ui/infra/Deploy-AdminUi.ps1, for tests/install-orchestrator.test.mjs (T-91): logs its own
    bound parameters to CGW_FAKE_LOG as one JSON line, and exits 1 when CGW_FAKE_FAIL_STEP is "admin-ui".
#>
param(
    [string]$ResourceGroup,
    [string]$EnvironmentName,
    [string]$GatewayAppName,
    [string]$AcrName,
    [string]$AppRegistrationName,
    [string]$AdminFile,
    [string]$AllowedCidr,
    [string]$Topology,
    [switch]$EnableSignIn,
    [switch]$AllowAnyAddress,
    [int]$CredentialValidityMonths,
    [int]$ClientSecretDays,
    [string[]]$SignInAdmins = @(),
    [switch]$Plan
)
$entry = @{ step = 'admin-ui'; args = @('-ResourceGroup', $ResourceGroup, '-EnvironmentName', $EnvironmentName, '-GatewayAppName', $GatewayAppName,
    '-AcrName', $AcrName, '-AppRegistrationName', $AppRegistrationName, '-AdminFile', $AdminFile, '-AllowedCidr', $AllowedCidr, '-Topology', $Topology)
    enableSignIn = [bool]$EnableSignIn; allowAnyAddress = [bool]$AllowAnyAddress; credentialMonths = $CredentialValidityMonths; secretDays = $ClientSecretDays; signInAdmins = @($SignInAdmins) }
Add-Content -Path $env:CGW_FAKE_LOG -Value (ConvertTo-Json -Compress $entry)
if ($env:CGW_FAKE_FAIL_STEP -eq 'admin-ui') {
    Write-Error 'fake-adminui: admin-ui failed on purpose'
    exit 1
}
