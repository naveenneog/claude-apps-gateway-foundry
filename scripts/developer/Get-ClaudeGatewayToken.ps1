<#
.SYNOPSIS
    Prints a Claude apps gateway access token on stdout, and nothing else, for Claude Code's apiKeyHelper.

.DESCRIPTION
    Serves the access token that Connect-ClaudeGateway.ps1 saved while more than five minutes of its lifetime
    remain. Otherwise it refreshes the token with the refresh grant and saves the new tokens. A lock file makes
    concurrent runs share one refresh, because a refresh can rotate the refresh token (U-48).

    Claude Code runs this command through cmd, sends its output as the Authorization: Bearer and X-Api-Key
    headers, and runs it again after five minutes, after a 401 or 403, and when the token it holds has expired
    (https://code.claude.com/docs/en/settings-reference#apikeyhelper).

    Exit code 0: the token is on stdout. Exit code 1: no token; stderr names the sign-in command when a new
    sign-in is needed. A refresh refused with invalid_grant deletes the saved session. Any other refresh failure
    keeps it, and the current token is still served while it is valid.

.PARAMETER GatewayUrl
    The gateway origin that Connect-ClaudeGateway.ps1 signed in to.

.PARAMETER ExpectedBaseUrl
    The origin ANTHROPIC_BASE_URL may name instead of the gateway, such as a loopback relay a test puts in front of it.
    The helper prints the token only when ANTHROPIC_BASE_URL names the gateway, or this origin: Claude Code sends the
    token to ANTHROPIC_BASE_URL, or to https://api.anthropic.com when it is empty or unset, and passes its settings env
    to the helper. To run the helper by hand, set ANTHROPIC_BASE_URL to the gateway first.

.EXAMPLE
    $env:ANTHROPIC_BASE_URL = 'https://gateway.contoso.com'; .\Get-ClaudeGatewayToken.ps1 -GatewayUrl https://gateway.contoso.com

.LINK
    https://code.claude.com/docs/en/settings-reference#apikeyhelper
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$GatewayUrl, [string]$ExpectedBaseUrl)

$ErrorActionPreference = 'Stop'
$refreshBelowSeconds = 300
$servableAboveSeconds = 30

function Write-Diagnostic([string]$Message) { [Console]::Error.WriteLine("Get-ClaudeGatewayToken: $Message") }

$exitCode = 1
$lock = $null
$signIn = $null
# What the message of a failure adds. The sign-in command is set only by the failures a new sign-in fixes: no session,
# an unreadable one, an expired one without a refresh token, and a refused refresh token. A failure to save the session
# gets none, because the sign-in saves the same way (UX review, round 4; Architect and Coder review, round 5).
$recovery = $null
try {
    Import-Module (Join-Path $PSScriptRoot 'ClaudeGateway.psm1') -DisableNameChecking
    $origin = ConvertTo-GatewayOrigin -Url $GatewayUrl
    $allowed = $origin
    if ($ExpectedBaseUrl) { $allowed = ConvertTo-GatewayOrigin -Url $ExpectedBaseUrl }
    # Claude Code sends the token to ANTHROPIC_BASE_URL, or to https://api.anthropic.com when it is empty or unset, and
    # a repository's .claude/settings.json or .claude/settings.local.json can set it to either.
    $advice = "Start Claude Code with the profile's claude-gateway.cmd and no --settings argument of your own: its settings file sets ANTHROPIC_BASE_URL to $allowed and outranks a repository's .claude/settings.json and .claude/settings.local.json."
    if (-not $env:ANTHROPIC_BASE_URL) {
        throw "ANTHROPIC_BASE_URL is empty or not set, so Claude Code would send the token to https://api.anthropic.com, and it is not printed. $advice"
    }
    $target = $null
    try { $target = ConvertTo-GatewayOrigin -Url $env:ANTHROPIC_BASE_URL } catch { $target = $null }
    if ($target -ne $allowed) {
        throw "ANTHROPIC_BASE_URL is $($env:ANTHROPIC_BASE_URL), not $allowed, so the token is not printed: Claude Code would send it there. $advice"
    }
    # A provider switch sends the token to that provider's base URL instead; its skip-auth and base URL variables take
    # effect only with the switch on (https://code.claude.com/docs/en/env-vars). Any value but an empty one counts.
    foreach ($switch in @('CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE')) {
        if ([Environment]::GetEnvironmentVariable($switch)) {
            throw "$switch is set, so Claude Code would send the token to that provider's endpoint, and it is not printed. $advice"
        }
    }
    $signIn = "To sign in again, run: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'Connect-ClaudeGateway.ps1')`" -GatewayUrl $origin"

    try { $session = Read-GatewaySession -Origin $origin } catch { $recovery = $signIn; throw }
    $token = $null
    if ($null -ne $session -and (Get-GatewayTokenLifetime -Session $session) -le $refreshBelowSeconds) {
        try {
            $lock = Enter-GatewayLock -Origin $origin
        } catch {
            $left = Get-GatewayTokenLifetime -Session $session
            if ($left -le $servableAboveSeconds) {
                $recovery = 'Wait for the other Claude Code or helper process to finish, or close it, then run the command again.'
                throw
            }
            Write-Diagnostic "$($_.Exception.Message) Serving the current token, which expires in $left seconds."
            $token = [string](Get-JsonValue $session 'accessToken')
        }
        # Another process may have refreshed while this one waited for the lock, so the session is read again.
        if ($null -ne $lock) { try { $session = Read-GatewaySession -Origin $origin } catch { $recovery = $signIn; throw } }
    }
    if ($null -eq $token) {
        if ($null -eq $session) { $recovery = $signIn; throw "No saved session for $origin." }
        $left = Get-GatewayTokenLifetime -Session $session
        $current = [string](Get-JsonValue $session 'accessToken')
        $refreshToken = [string](Get-JsonValue $session 'refreshToken')
        $tokenEndpoint = [string](Get-JsonValue $session 'tokenEndpoint')
        if ($left -gt $refreshBelowSeconds) {
            $token = $current
        } elseif (-not $refreshToken) {
            if ($left -le $servableAboveSeconds) {
                Remove-GatewaySession -Origin $origin
                $recovery = $signIn
                throw "The session for $origin has expired and holds no refresh token."
            }
            Write-Diagnostic "The session holds no refresh token and expires in $left seconds. $signIn"
            $token = $current
        } else {
            $status = 'no answer'
            $answer = $null
            try {
                $answer = Invoke-GatewayRequest -Method POST -Uri $tokenEndpoint -Form @{ grant_type = 'refresh_token'; refresh_token = $refreshToken }
                $status = "HTTP $($answer.Status)"
            } catch {
                $status = $_.Exception.Message
            }
            # A refusal is an HTTP 4xx answer other than 429; an invalid_grant body with another status is not one (UX review, round 6).
            $refused = $null -ne $answer -and $answer.Status -ge 400 -and $answer.Status -lt 500 -and $answer.Status -ne 429
            if ($null -ne $answer -and $answer.Status -eq 200 -and (Test-GatewayTokenAnswer $answer.Json)) {
                $renewed = New-GatewaySession -Origin $origin -TokenEndpoint $tokenEndpoint -TokenResponse $answer.Json -Previous $session
                Save-GatewaySession -Origin $origin -Session $renewed
                $token = $renewed.accessToken
            } elseif ($refused -and (Get-JsonValue $answer.Json 'error') -eq 'invalid_grant') {
                Remove-GatewaySession -Origin $origin
                $recovery = $signIn
                throw "The gateway refused the refresh token ($status invalid_grant), so the saved session was deleted."
            } else {
                # No answer, another error, or a 200 without a token the helper can use. The session is kept. A new
                # sign-in is not the fix when the gateway, or the way to it, fails (UX review, rounds 4 and 5).
                if ($null -ne $answer -and $answer.Status -eq 200) { $status = 'HTTP 200 without an access token and a valid expires_in' }
                if ($left -gt $servableAboveSeconds) {
                    Write-Diagnostic "The refresh failed ($status); serving the current token, which expires in $left seconds."
                    $token = $current
                } elseif ($null -eq $answer) {
                    throw "The refresh failed ($status) and the saved token has expired. The session is kept: run the command again when the gateway answers."
                } elseif ($refused) {
                    # Another refusal than invalid_grant. How the gateway refuses a dead refresh token is open (U-48), so
                    # the message names the sign-in command (Coder review, round 5).
                    $recovery = $signIn
                    throw "The gateway refused the refresh token ($status) and the saved token has expired. The session is kept."
                } else {
                    throw "The refresh failed ($status) and the saved token has expired. The session is kept: run the command again, and ask the gateway operator to check the gateway's log when it repeats."
                }
            }
        }
    }
    [Console]::Out.Write($token)
    $exitCode = 0
} catch {
    $message = $_.Exception.Message
    if ($recovery -and -not $message.Contains('Connect-ClaudeGateway.ps1')) { $message = "$message $recovery" }
    Write-Diagnostic $message
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
exit $exitCode