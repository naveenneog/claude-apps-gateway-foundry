# Shared functions for the Claude apps gateway developer scripts (docs/adr/0004-operator-and-developer-tooling.md).
# Windows PowerShell 5.1 compatible, and ASCII only: Windows PowerShell 5.1 reads a file that has no byte order
# mark as ANSI.
#
# A session is a JSON object {gateway, tokenEndpoint, accessToken, expiresAt, refreshToken, email}, handled as an ordered
# dictionary and stored in
# %LOCALAPPDATA%\ClaudeAppsGateway\sessions\<host>-<hash>.bin, encrypted with DPAPI for the current Windows user
# (System.Security.Cryptography.ProtectedData, CurrentUser scope) with the entropy
# 'claude-apps-gateway/v1 <origin>'. expiresAt is in Unix seconds.

Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Net.Http

$script:DeviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'

# JSON that holds a token is parsed and written with .NET methods inside the function that holds it, and travels
# between functions only as a dictionary: PowerShell module logging (event 4103) records every parameter value of a
# logged command, a PSCustomObject or a byte array with its content, and a dictionary by its type name only (measured
# 2026-09-28 in Windows PowerShell 5.1). ConvertFrom-Json and ConvertTo-Json are not used on such JSON.
$script:Desktop = $PSVersionTable.PSEdition -ne 'Core'
if ($script:Desktop) {
    Add-Type -AssemblyName System.Web.Extensions
    $script:Serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
}

function ConvertFrom-GatewayJson {
    # The JSON object in $Holder.Text as a dictionary, with nested objects as dictionaries and arrays as lists, or $null.
    # The text arrives inside a hashtable, which module logging records by type name.
    param([Parameter(Mandatory = $true)][hashtable]$Holder)
    $text = [string]$Holder['Text']
    if (-not $text) { return $null }
    try {
        if ($script:Desktop) {
            $value = $script:Serializer.DeserializeObject($text)
        } else {
            # Newtonsoft parses nested objects as JObject, whose ToString() is its JSON text, so the tree is converted
            # here with a work queue rather than recursion, and no JToken is passed to a command. Date-like strings stay strings.
            $reader = [Newtonsoft.Json.JsonTextReader]::new([IO.StringReader]::new($text))
            $reader.DateParseHandling = [Newtonsoft.Json.DateParseHandling]::None
            $top = [Collections.Generic.List[object]]::new()
            $top.Add($null)
            $pending = [Collections.Generic.Queue[object]]::new()
            $pending.Enqueue(@([Newtonsoft.Json.Linq.JToken]::ReadFrom($reader), $top, 0))
            while ($pending.Count -gt 0) {
                $item = $pending.Dequeue()
                $token = $item[0]
                if ($token -is [Newtonsoft.Json.Linq.JObject]) {
                    $converted = [Collections.Generic.Dictionary[string, object]]::new()
                    foreach ($property in $token.Properties()) { $pending.Enqueue(@($property.Value, $converted, $property.Name)) }
                } elseif ($token -is [Newtonsoft.Json.Linq.JArray]) {
                    $converted = [Collections.Generic.List[object]]::new()
                    for ($i = 0; $i -lt $token.Count; $i++) { $converted.Add($null); $pending.Enqueue(@($token[$i], $converted, $i)) }
                } else {
                    $converted = $token.Value
                }
                $item[1][$item[2]] = $converted
            }
            $value = $top[0]
        }
    } catch {
        return $null
    }
    if ($value -is [Collections.IDictionary]) { return $value }
    return $null
}

function ConvertTo-GatewayJson {
    # -Indented writes one value per line, for a file a person may edit. ConvertTo-Json receives only the dictionary,
    # which module logging records by type name.
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$Value, [switch]$Indented)
    if (-not $script:Desktop) {
        $format = [Newtonsoft.Json.Formatting]::None
        if ($Indented) { $format = [Newtonsoft.Json.Formatting]::Indented }
        return [Newtonsoft.Json.JsonConvert]::SerializeObject($Value, $format)
    }
    if ($Indented) { return ConvertTo-Json -InputObject $Value -Depth 100 }
    return $script:Serializer.Serialize($Value)
}

function Get-JsonValue {
    # A value of a parsed JSON object (a dictionary, or a PSCustomObject from ConvertFrom-Json), or $null.
    param($Object, [Parameter(Mandatory = $true)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.Specialized.OrderedDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] }; return $null }
    if ($Object -is [Collections.IDictionary]) { if ($Object.ContainsKey($Name)) { return $Object[$Name] }; return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-PositiveNumber {
    # True for a JSON number above zero; false for a string, a boolean, null, zero or a negative number.
    param($Value)
    $isNumber = $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [single]
    return $isNumber -and [double]$Value -gt 0 -and -not [double]::IsInfinity([double]$Value)
}

function Get-UriOrigin {
    # scheme://host[:port], with an IPv6 host in its RFC 5952 short form: Uri.GetLeftPart writes [::1] as
    # [0000:0000:0000:0000:0000:0000:0000:0001] in Windows PowerShell 5.1 and as [::1] in PowerShell 7, and a session
    # saved by one must be found by the other.
    param([Parameter(Mandatory = $true)][Uri]$Uri)
    $hostPart = $Uri.Host.ToLowerInvariant()
    if ($Uri.HostNameType -eq [UriHostNameType]::IPv6) { $hostPart = '[' + [Net.IPAddress]::Parse($Uri.DnsSafeHost).ToString() + ']' }
    $origin = $Uri.Scheme + '://' + $hostPart
    if (-not $Uri.IsDefaultPort) { $origin += ':' + $Uri.Port }
    return $origin
}

function ConvertTo-GatewayOrigin {
    # The origin of a gateway URL: https://host[:port]. http is accepted for a loopback host only.
    param([Parameter(Mandatory = $true)][string]$Url)
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { throw "The gateway URL '$Url' is not an absolute URL." }
    if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) {
        throw "The gateway URL must use https; http is accepted only for a loopback address. Got '$Url'."
    }
    if ($uri.UserInfo) { throw 'The gateway URL must not contain a user name or password.' }
    if ($uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
        throw "The gateway URL must be an origin, with no path, query or fragment. Got '$Url'."
    }
    $origin = Get-UriOrigin -Uri $uri
    # The origin is written into a cmd command line (Install-ClaudeGatewayProfile.ps1), so only host characters pass.
    if ($origin -notmatch '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?$') {
        throw "The gateway URL '$Url' has a host this script does not accept: ASCII letters, digits, dots, hyphens and underscores, or an IP address. Write an internationalised name in its xn-- form."
    }
    return $origin
}

function Assert-GatewayOrigin {
    # Stops unless Url is an absolute URL on Origin (the protocol requires same-origin endpoints).
    param([string]$Url, [Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$Name)
    $uri = $null
    if (-not $Url -or -not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or (Get-UriOrigin -Uri $uri) -ne $Origin) {
        throw "The gateway's $Name '$Url' is not on the gateway origin $Origin; stopping."
    }
}
function Invoke-GatewayRequest {
    # One request, never following a redirect. Returns Status, Json (or $null) and Text.
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Form,
        [int]$TimeoutSeconds = 30
    )
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    try {
        $request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList (New-Object System.Net.Http.HttpMethod -ArgumentList $Method), $Uri
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json')
        [void]$request.Headers.TryAddWithoutValidation('User-Agent', 'claude-apps-gateway-helper/1')
        if ($null -ne $Form) {
            $pairs = New-Object 'System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string,string]]'
            foreach ($key in $Form.Keys) {
                $pairs.Add([System.Collections.Generic.KeyValuePair[string, string]]::new($key, [string]$Form[$key]))
            }
            $request.Content = [System.Net.Http.FormUrlEncodedContent]::new($pairs)
        }
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
        } catch {
            $cause = $_.Exception
            while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
            throw "Could not reach $Uri`: $($cause.Message) The scripts connect directly or through the Windows proxy settings (Internet Options); they do not read HTTPS_PROXY."
        }
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return @{ Status = [int]$response.StatusCode; Json = (ConvertFrom-GatewayJson -Holder @{ Text = $text }) }
    } finally {
        $client.Dispose()
    }
}

function Get-GatewayMetadata {
    # RFC 8414 metadata. The device, token and, when advertised, revocation endpoints must be on the gateway origin.
    param([Parameter(Mandatory = $true)][string]$Origin)
    $url = "$Origin/.well-known/oauth-authorization-server"
    $r = Invoke-GatewayRequest -Method GET -Uri $url
    if ($r.Status -ne 200 -or $null -eq $r.Json) { throw "Discovery at $url returned HTTP $($r.Status)." }
    $device = [string](Get-JsonValue $r.Json 'device_authorization_endpoint')
    $token = [string](Get-JsonValue $r.Json 'token_endpoint')
    $revocation = [string](Get-JsonValue $r.Json 'revocation_endpoint')
    Assert-GatewayOrigin -Url $device -Origin $Origin -Name 'device_authorization_endpoint'
    Assert-GatewayOrigin -Url $token -Origin $Origin -Name 'token_endpoint'
    if ($revocation) { Assert-GatewayOrigin -Url $revocation -Origin $Origin -Name 'revocation_endpoint' }
    return [pscustomobject]@{ DeviceEndpoint = $device; TokenEndpoint = $token; RevocationEndpoint = $revocation }
}

function Test-GatewayTokenAnswer {
    # A token answer the scripts can store: a non-empty access_token and a positive expires_in.
    param($Json)
    $token = Get-JsonValue $Json 'access_token'
    return ($token -is [string]) -and $token.Length -gt 0 -and (Test-PositiveNumber (Get-JsonValue $Json 'expires_in'))
}

function Wait-GatewayDeviceToken {
    # Polls the token endpoint (RFC 8628 section 3.4) until a token or a terminal error.
    param([Parameter(Mandatory = $true)][string]$TokenEndpoint, [Parameter(Mandatory = $true)]$Device)
    $interval = 5
    $offered = Get-JsonValue $Device 'interval'
    if (Test-PositiveNumber $offered) { $interval = [double]$offered }
    $lifetime = Get-JsonValue $Device 'expires_in'
    if (-not (Test-PositiveNumber $lifetime)) { throw 'The gateway''s device authorization answer has no valid expires_in.' }
    $deadline = [DateTime]::UtcNow.AddSeconds([double]$lifetime)
    $form = @{ grant_type = $script:DeviceGrant; device_code = [string](Get-JsonValue $Device 'device_code') }
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds ([int]($interval * 1000))
        $r = Invoke-GatewayRequest -Method POST -Uri $TokenEndpoint -Form $form
        if ($r.Status -eq 200) {
            if (Test-GatewayTokenAnswer $r.Json) { return $r.Json }
            throw 'The gateway''s token answer has no access_token or no valid expires_in, so the session was not saved.'
        }
        $code = Get-JsonValue $r.Json 'error'
        if ($code -eq 'authorization_pending') { continue }
        if ($code -eq 'slow_down') { $interval += 5; continue }
        if ($code -eq 'access_denied') {
            throw 'The sign-in was declined (access_denied): the code was refused in the browser, or the gateway refused this account. If it is refused again, ask the gateway operator whether your account holds a gateway role.'
        }
        if ($code -eq 'expired_token') { throw 'The sign-in code expired before it was confirmed (expired_token).' }
        throw "The gateway ended the sign-in with HTTP $($r.Status) $code."
    }
    throw 'The sign-in code expired before it was confirmed (expired_token).'
}

function New-GatewaySession {
    # A session from a token answer that passed Test-GatewayTokenAnswer; a refresh answer without refresh_token or
    # email keeps the previous one.
    param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)][string]$TokenEndpoint,
        [Parameter(Mandatory = $true)]$TokenResponse, $Previous)
    $refresh = Get-JsonValue $TokenResponse 'refresh_token'
    if (-not $refresh) { $refresh = Get-JsonValue $Previous 'refreshToken' }
    $email = Get-JsonValue $TokenResponse 'email'
    if (-not $email) { $email = Get-JsonValue $Previous 'email' }
    return [ordered]@{
        gateway       = $Origin
        tokenEndpoint = $TokenEndpoint
        accessToken   = [string](Get-JsonValue $TokenResponse 'access_token')
        expiresAt     = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + [int64][Math]::Floor([double](Get-JsonValue $TokenResponse 'expires_in'))
        refreshToken  = $refresh
        email         = $email
    }
}
function Get-GatewayTokenLifetime {
    # Seconds until the session's access token expires; negative once it has.
    param([Parameter(Mandatory = $true)]$Session)
    return [int64](Get-JsonValue $Session 'expiresAt') - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}

function Get-GatewaySessionPath {
    param([Parameter(Mandatory = $true)][string]$Origin)
    $root = $env:LOCALAPPDATA
    if (-not $root) { $root = [Environment]::GetFolderPath('LocalApplicationData') }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Origin)) } finally { $sha.Dispose() }
    $hash = -join ($digest[0..5] | ForEach-Object { $_.ToString('x2') })
    # Named from the canonical origin string, not a re-parsed Uri, so both PowerShell versions pick the same file.
    $name = (($Origin -replace '^https?://', '') -replace '[^A-Za-z0-9.-]', '_') + '-' + $hash + '.bin'
    return [IO.Path]::Combine($root, 'ClaudeAppsGateway', 'sessions', $name)
}

function Get-GatewayEntropy {
    param([Parameter(Mandatory = $true)][string]$Origin)
    return [Text.Encoding]::UTF8.GetBytes("claude-apps-gateway/v1 $Origin")
}

function Save-GatewaySession {
    # Encrypts the session for the current Windows user and replaces the file in one step.
    param([Parameter(Mandatory = $true)][string]$Origin, [Parameter(Mandatory = $true)]$Session)
    $path = Get-GatewaySessionPath -Origin $Origin
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-GatewayJson -Value $Session))
    $blob = [Security.Cryptography.ProtectedData]::Protect($bytes, (Get-GatewayEntropy -Origin $Origin), [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $dir = [IO.Path]::GetDirectoryName($path)
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $temp = "$path.$PID.tmp"
    [IO.File]::WriteAllBytes($temp, $blob)
    # A reader in another process can hold the file for a moment; the replace is retried rather than losing a refresh
    # token the gateway has already rotated. [NullString]::Value: PowerShell passes $null to a string parameter as an
    # empty string, which Replace refuses.
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ($true) {
        try {
            if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temp, $path, [NullString]::Value) } else { [IO.File]::Move($temp, $path) }
            return
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue; throw }
            Start-Sleep -Milliseconds 100
        }
    }}

function Read-SharedBytes {
    # Reads a file opened with FileShare ReadWrite and Delete, so a concurrent save can replace it meanwhile.
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $buffer = New-Object byte[] $stream.Length
        $read = 0
        while ($read -lt $buffer.Length) {
            $n = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        # The comma keeps PowerShell from unrolling the array into single bytes.
        return , $buffer
    } finally {
        $stream.Dispose()
    }
}
function Read-GatewaySession {
    # The saved session for Origin, or $null when there is none.
    param([Parameter(Mandatory = $true)][string]$Origin)
    $path = Get-GatewaySessionPath -Origin $Origin
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect((Read-SharedBytes -Path $path), (Get-GatewayEntropy -Origin $Origin), [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $session = ConvertFrom-GatewayJson -Holder @{ Text = [Text.Encoding]::UTF8.GetString($bytes) }
        if ($null -eq $session) { throw 'it holds no JSON object' }
        return $session
    } catch [IO.FileNotFoundException] {
        # Deleted by another run (invalid_grant or sign-out) after the check above.
        return $null
    } catch {
        throw "The saved session $path cannot be read by this Windows user ($($_.Exception.Message)). Signing in again replaces it."
    }
}

function Remove-GatewaySession {
    param([Parameter(Mandatory = $true)][string]$Origin)
    $path = Get-GatewaySessionPath -Origin $Origin
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function Enter-GatewayLock {
    # Opens the session's lock file for exclusive use. The open handle is the lock; Dispose or process exit frees it.
    param([Parameter(Mandatory = $true)][string]$Origin, [int]$TimeoutSeconds = 0)
    if ($TimeoutSeconds -le 0) {
        # CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS shortens the wait, for tests and for impatient callers.
        $TimeoutSeconds = 60
        $configured = 0
        if ([int]::TryParse([string]$env:CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS, [ref]$configured) -and $configured -gt 0) { $TimeoutSeconds = $configured }
    }
    $path = (Get-GatewaySessionPath -Origin $Origin) + '.lock'
    $dir = [IO.Path]::GetDirectoryName($path)
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $waiting = $false
    while ($true) {
        try {
            return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Another process has held $path for $TimeoutSeconds seconds." }
            if (-not $waiting) { [Console]::Error.WriteLine("Waiting for the session lock $path, which another process holds."); $waiting = $true }
            Start-Sleep -Milliseconds 200
        }
    }
}

Export-ModuleMember -Function ConvertFrom-GatewayJson, ConvertTo-GatewayJson, Get-JsonValue, Test-PositiveNumber, Get-UriOrigin, ConvertTo-GatewayOrigin,
    Assert-GatewayOrigin, Invoke-GatewayRequest, Get-GatewayMetadata, Test-GatewayTokenAnswer, Wait-GatewayDeviceToken, New-GatewaySession,
    Get-GatewayTokenLifetime, Get-GatewaySessionPath, Save-GatewaySession, Read-GatewaySession, Remove-GatewaySession, Enter-GatewayLock
