<#
.SYNOPSIS
    Signs in to a Claude apps gateway with the device flow and saves the session for Get-ClaudeGatewayToken.ps1.

.DESCRIPTION
    Reads the gateway's OAuth metadata (RFC 8414), shows a sign-in code and opens the gateway's verification page,
    then polls the token endpoint until the code is confirmed (RFC 8628). The session, which holds the refresh token,
    is saved encrypted with DPAPI for the current Windows user under %LOCALAPPDATA%\ClaudeAppsGateway\sessions.
    When the gateway names the account that confirmed the code, the script asks to confirm it before saving, as
    Claude Code does.

    Exit code 0: signed in. Exit code 1: not signed in; the message on stderr says why.

.PARAMETER GatewayUrl
    The gateway origin, for example https://gateway.contoso.com. http is accepted for a loopback address only.

.PARAMETER NoBrowser
    Shows the verification URL without opening a browser.

.PARAMETER Force
    Saves the session without asking to confirm the account the gateway names.

.EXAMPLE
    .\Connect-ClaudeGateway.ps1 -GatewayUrl https://gateway.contoso.com

.LINK
    https://code.claude.com/docs/en/claude-apps-gateway
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GatewayUrl,
    [switch]$NoBrowser,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$retry = $null
try {
    Import-Module (Join-Path $PSScriptRoot 'ClaudeGateway.psm1') -DisableNameChecking
    $origin = ConvertTo-GatewayOrigin -Url $GatewayUrl
    $retry = "To sign in, run: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -GatewayUrl $origin"
    $metadata = Get-GatewayMetadata -Origin $origin
    $device = Invoke-GatewayRequest -Method POST -Uri $metadata.DeviceEndpoint -Form @{}
    if ($device.Status -ne 200 -or -not (Get-JsonValue $device.Json 'device_code')) {
        throw "Device authorization at $($metadata.DeviceEndpoint) returned HTTP $($device.Status)."
    }
    $verification = [string](Get-JsonValue $device.Json 'verification_uri_complete')
    if (-not $verification) { $verification = [string](Get-JsonValue $device.Json 'verification_uri') }
    Assert-GatewayOrigin -Url $verification -Origin $origin -Name 'verification URL'
    # The parsed form is shown and opened, never the raw string the gateway sent.
    $verification = ([Uri]$verification).AbsoluteUri

    [Console]::Out.WriteLine("To sign in, open $verification and confirm the code $(Get-JsonValue $device.Json 'user_code').")
    if (-not $NoBrowser) {
        try { Start-Process -FilePath $verification } catch { [Console]::Error.WriteLine("Could not open a browser: $($_.Exception.Message)") }
    }

    $token = Wait-GatewayDeviceToken -TokenEndpoint $metadata.TokenEndpoint -Device $device.Json
    $email = Get-JsonValue $token 'email'
    if ($email -and -not $Force) {
        $confirmed = $false
        try {
            $confirmed = $PSCmdlet.ShouldContinue("The gateway signed you in as $email. Save this session?", 'Confirm the account')
        } catch {
            throw "The gateway signed you in as $email, and this session cannot ask to confirm it. Run the script interactively, or with -Force."
        }
        if (-not $confirmed) { throw "Not saved: the account $email was not confirmed." }
    }

    # Under the session lock, so a helper that is refreshing the previous session cannot overwrite or delete this one.
    $lock = Enter-GatewayLock -Origin $origin
    try {
        Save-GatewaySession -Origin $origin -Session (New-GatewaySession -Origin $origin -TokenEndpoint $metadata.TokenEndpoint -TokenResponse $token)
    } finally {
        $lock.Dispose()
    }
    $who = ''
    if ($email) { $who = " as $email" }
    [Console]::Out.WriteLine("Signed in to $origin$who. Get-ClaudeGatewayToken.ps1 now serves tokens for this gateway.")
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($retry) { $message = "$message $retry" }
    [Console]::Error.WriteLine("Connect-ClaudeGateway: $message")
    exit 1
}
