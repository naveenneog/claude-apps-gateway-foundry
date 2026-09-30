<#
.SYNOPSIS
    Signs out of a Claude apps gateway: revokes the saved tokens when the gateway supports it, then deletes the session.

.DESCRIPTION
    When the gateway's metadata advertises a revocation_endpoint, the access token and then the refresh token are sent
    to it (RFC 7009, best effort, as Claude Code does at sign-out). The session file is deleted in every case, under
    the same lock Get-ClaudeGatewayToken.ps1 uses. A session that cannot be read is deleted without revocation.

    Exit code 0: no session remains for the gateway. Exit code 1: see stderr.

.PARAMETER GatewayUrl
    The gateway origin that Connect-ClaudeGateway.ps1 signed in to.

.EXAMPLE
    .\Disconnect-ClaudeGateway.ps1 -GatewayUrl https://gateway.contoso.com

.LINK
    https://code.claude.com/docs/en/claude-apps-gateway
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$GatewayUrl)

$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'ClaudeGateway.psm1') -DisableNameChecking
    $origin = ConvertTo-GatewayOrigin -Url $GatewayUrl
    if (-not (Test-Path -LiteralPath (Get-GatewaySessionPath -Origin $origin))) {
        [Console]::Out.WriteLine("No saved session for $origin.")
        exit 0
    }
    $lock = Enter-GatewayLock -Origin $origin
    try {
        $session = $null
        try { $session = Read-GatewaySession -Origin $origin } catch { [Console]::Error.WriteLine("Disconnect-ClaudeGateway: $($_.Exception.Message) It is deleted without revocation.") }
        if ($null -ne $session) {
            try {
                $revocation = (Get-GatewayMetadata -Origin $origin).RevocationEndpoint
                if ($revocation) {
                    $refresh = [string](Get-JsonValue $session 'refreshToken')
                    [void](Invoke-GatewayRequest -Method POST -Uri $revocation -Form @{ token = [string](Get-JsonValue $session 'accessToken') })
                    if ($refresh) { [void](Invoke-GatewayRequest -Method POST -Uri $revocation -Form @{ token = $refresh; token_type_hint = 'refresh_token' }) }
                }
            } catch {
                [Console]::Error.WriteLine("Disconnect-ClaudeGateway: the tokens could not be revoked ($($_.Exception.Message)); the session is deleted anyway.")
            }
        }
        Remove-GatewaySession -Origin $origin
    } finally {
        $lock.Dispose()
    }
    [Console]::Out.WriteLine("Signed out of $origin; the saved session is deleted.")
    exit 0
} catch {
    [Console]::Error.WriteLine("Disconnect-ClaudeGateway: $($_.Exception.Message)")
    exit 1
}
