# The developer VM and the checks of infra/azure-private/Deploy-Gateway.ps1 (ADR-0005). The VM stands in for a developer
# machine on the corporate network: it sits in the gateway's VNet, is reached through Azure Bastion Developer, and gets
# Claude Code, VS Code and the managed policies an administrator deploys. The checks run on it through Run Command.
Set-StrictMode -Version Latest

# The Windows policies an administrator deploys (https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url,
# https://claude.com/docs/third-party/claude-desktop/configuration): Claude Code's login keys as the JSON value Settings
# under HKLM\SOFTWARE\Policies\ClaudeCode, and Claude Desktop's bootstrapUrl as a REG_SZ under HKLM\SOFTWARE\Policies\Claude.
function New-DevVmSetupScript($c) {
    $policy = ConvertTo-Json -Compress @{ forceLoginMethod = 'gateway'; forceLoginGatewayUrl = "https://$($c.Fqdn)"; parentSettingsBehavior = 'merge' }
    @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$dir = Join-Path `$env:ProgramFiles 'Anthropic\ClaudeCode'
New-Item -ItemType Directory -Force -Path `$dir | Out-Null
`$exe = Join-Path `$dir 'claude.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://downloads.claude.ai/claude-code-releases/$($c.ClaudeCodeVersion)/win32-x64/claude.exe' -OutFile `$exe
`$hash = (Get-FileHash -LiteralPath `$exe -Algorithm SHA256).Hash.ToLowerInvariant()
if (`$hash -ne '$($c.ClaudeCodeWindowsSha256)') { Remove-Item -LiteralPath `$exe; throw "claude.exe has checksum `$hash, not the release manifest's" }
`$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ((`$machinePath -split ';') -notcontains `$dir) { [Environment]::SetEnvironmentVariable('Path', "`$machinePath;`$dir", 'Machine') }
New-Item -Path 'HKLM:\SOFTWARE\Policies\ClaudeCode' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\ClaudeCode' -Name 'Settings' -PropertyType String -Value '$policy' -Force | Out-Null
New-Item -Path 'HKLM:\SOFTWARE\Policies\Claude' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Claude' -Name 'bootstrapUrl' -PropertyType String -Value 'https://$($c.Fqdn)/user/bootstrap' -Force | Out-Null
if (-not (Test-Path (Join-Path `$env:ProgramFiles 'Microsoft VS Code\Code.exe'))) {
    `$vscode = Join-Path `$env:TEMP 'vscode-setup.exe'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://update.code.visualstudio.com/latest/win32-x64/stable' -OutFile `$vscode
    Start-Process -FilePath `$vscode -ArgumentList '/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode,addtopath' -Wait
}
Write-Output ('claude.exe ' + `$hash)
Write-Output ('ClaudeCode policy ' + (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\ClaudeCode').Settings)
Write-Output ('Claude policy bootstrapUrl ' + (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Claude').bootstrapUrl)
Write-Output ('VS Code ' + (Test-Path (Join-Path `$env:ProgramFiles 'Microsoft VS Code\Code.exe')))
"@
}

# Saves the VM's administrator password for the operator only (DPAPI, current user), and reads it back.
function Get-DevVmPasswordPath($c) { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "ClaudeAppsGateway\private\$($c.ResourceGroup)-$($c.DevVm).bin" }
function Save-DevVmPassword($c, [string]$Password) {
    $path = Get-DevVmPasswordPath $c
    [void][IO.Directory]::CreateDirectory((Split-Path $path -Parent))
    $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Password), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllBytes($path, $blob)
}
function Read-DevVmPassword($c) {
    $path = Get-DevVmPasswordPath $c
    if (-not [IO.File]::Exists($path)) { return $null }
    [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}

function Invoke-OnDevVm($c, [string]$Name, [string]$Script) {
    $file = Get-AzWorkFile $Name
    [IO.File]::WriteAllText($file, $Script)
    $r = Invoke-AzChange @('vm', 'run-command', 'invoke', '-g', $c.ResourceGroup, '-n', $c.DevVm, '--command-id', 'RunPowerShellScript', '--scripts', "@$file")
    if (-not $r) { return $null }
    [pscustomobject]@{ Out = [string]$r.value[0].message; Err = [string]$r.value[1].message }
}

function Step-DevVm($c) {
    $rg = $c.ResourceGroup
    if (Invoke-AzRead @('vm', 'show', '-g', $rg, '-n', $c.DevVm)) { Write-AzFound "developer VM $($c.DevVm)" }
    else {
        $password = New-RandomSecret 24
        if (-not (Test-AzPlan)) { Save-DevVmPassword $c $password }
        # No public IP and no NSG of its own: the VM is reached through Bastion only.
        Invoke-AzChange @('vm', 'create', '-g', $rg, '-n', $c.DevVm, '--location', $c.Location, '--image', $c.DevVmImage, '--size', $c.DevVmSize,
            '--license-type', 'Windows_Client', '--security-type', 'TrustedLaunch', '--vnet-name', $c.Vnet, '--subnet', 'snet-dev',
            '--public-ip-address', '', '--nsg', '', '--admin-username', $c.DevVmUser, '--admin-password', (New-AzSecretArgument 'vm-password' $password)) | Out-Null
    }
    if (Invoke-AzRead @('network', 'bastion', 'show', '-g', $rg, '-n', $c.Bastion)) { Write-AzFound "Bastion $($c.Bastion)" }
    else { Invoke-AzChange @('network', 'bastion', 'create', '-g', $rg, '-n', $c.Bastion, '--location', $c.Location, '--sku', 'Developer', '--vnet-name', $c.Vnet) | Out-Null }
    $setup = Invoke-OnDevVm $c 'vm-setup.ps1' (New-DevVmSetupScript $c)
    if ($setup) { Write-Host ($setup.Out.Trim() -replace '(?m)^', '        '); if ($setup.Err.Trim()) { throw "the VM setup reported: $($setup.Err.Trim())" } }
}

# From inside the VNet: the gateway, PostgreSQL and Foundry host names resolve to private addresses and /readyz
# answers (T-16, T-69); the gateway's certificate is described for U-56. From this machine: Foundry refuses a direct
# request (T-68).
function Step-Verify($c) {
    $inside = @"
`$ErrorActionPreference = 'Continue'
`$r = [ordered]@{}
foreach (`$pair in @(@('gateway', '$($c.Fqdn)'), @('postgres', '$($c.Postgres).postgres.database.azure.com'), @('foundry', '$($c.Foundry).services.ai.azure.com'))) {
    `$r[`$pair[0]] = @(Resolve-DnsName -Name `$pair[1] -Type A -ErrorAction SilentlyContinue | Where-Object Type -eq 'A' | ForEach-Object IPAddress)
}
try { `$r.readyz = (Invoke-WebRequest -UseBasicParsing -Uri 'https://$($c.Fqdn)/readyz' -TimeoutSec 20).StatusCode } catch { `$r.readyz = `$_.Exception.Message }
try {
    `$tcp = [Net.Sockets.TcpClient]::new('$($c.Fqdn)', 443)
    `$ssl = [Net.Security.SslStream]::new(`$tcp.GetStream(), `$false, { `$true })
    `$ssl.AuthenticateAsClient('$($c.Fqdn)')
    `$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new(`$ssl.RemoteCertificate)
    `$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    `$r.certificate = [ordered]@{ subject = `$cert.Subject; issuer = `$cert.Issuer; notBefore = `$cert.NotBefore.ToString('s'); notAfter = `$cert.NotAfter.ToString('s'); sha256 = `$cert.GetCertHashString('SHA256').ToLowerInvariant(); chainValid = `$chain.Build(`$cert) }
    `$tcp.Close()
} catch { `$r.certificate = `$_.Exception.Message }
`$r | ConvertTo-Json -Compress -Depth 5
"@
    $result = Invoke-OnDevVm $c 'vm-verify.ps1' $inside
    if (-not $result) { return }
    $seen = $result.Out.Trim() | ConvertFrom-Json
    $status = Get-FoundryOutsideStatus $c
    $server = Invoke-AzRead @('postgres', 'flexible-server', 'show', '-g', $c.ResourceGroup, '-n', $c.Postgres)
    $checks = Get-VerifyChecks $seen $status $server.network.publicNetworkAccess
    foreach ($k in $checks.Keys) { Write-Host ('  {0}  {1}' -f $(if ($checks[$k]) { 'PASS' } else { 'FAIL' }), $k) }
    Write-Host "  addresses: gateway $(@($seen.gateway) -join ',') postgres $(@($seen.postgres) -join ',') foundry $(@($seen.foundry) -join ',')"
    Write-Host "  certificate: $(ConvertTo-Json -Compress $seen.certificate)"
    $failed = @($checks.Values | Where-Object { -not $_ }).Count
    # ADR-0007: the sidecar's path to Application Insights, checked from inside the gateway app (T-78, T-32).
    if ($c.Telemetry) { Test-TelemetryDelivery $c }
    if ($failed) { throw 'a check failed' }
}

# The HTTP status Foundry gives a request from this machine, outside the VNet (T-68), or 0 when it gives no answer.
function Get-FoundryOutsideStatus($c) {
    $token = Invoke-AzSecretRead @('account', 'get-access-token', '--resource', 'https://ai.azure.com', '--query', 'accessToken')
    # HttpClient rather than Invoke-WebRequest, so the token is not a cmdlet parameter that module logging records.
    $http = [Net.Http.HttpClient]::new()
    $status = 0
    try {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, "https://$($c.Foundry).services.ai.azure.com/anthropic/v1/messages")
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
        [void]$request.Headers.TryAddWithoutValidation('anthropic-version', '2023-06-01')
        $request.Content = [Net.Http.StringContent]::new('{"model":"claude-sonnet-5","max_tokens":8,"messages":[{"role":"user","content":"Hi"}]}', [Text.Encoding]::UTF8, 'application/json')
        $status = [int]$http.SendAsync($request).GetAwaiter().GetResult().StatusCode
    } catch { Write-Host "  Foundry gave no answer from this machine: $($_.Exception.InnerException.Message)" }
    finally { $http.Dispose() }
    $status
}

# RFC 1918 and carrier-grade NAT space: the addresses /login accepts without gatewayInternalNetworks
# (https://code.claude.com/docs/en/claude-apps-gateway#prerequisites).
function Test-PrivateAddress([string]$Address) {
    if ($Address -notmatch '^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$') { return $false }
    $a = [int]$Matches[1]; $b = [int]$Matches[2]
    $a -eq 10 -or ($a -eq 172 -and $b -ge 16 -and $b -le 31) -or ($a -eq 192 -and $b -eq 168) -or ($a -eq 100 -and $b -ge 64 -and $b -le 127)
}

# The verdicts of Step-Verify from what the VM saw, the status Foundry gave this machine, and PostgreSQL's setting.
function Get-VerifyChecks($Seen, [int]$FoundryStatus, [string]$PostgresAccess) {
    $private = { param($addresses) @($addresses).Count -gt 0 -and -not @($addresses | Where-Object { -not (Test-PrivateAddress $_) }).Count }
    [ordered]@{
        'gateway host resolves to private addresses only (T-16)' = (& $private $Seen.gateway)
        'gateway /readyz answers 200 inside the VNet (T-16)' = ($Seen.readyz -eq 200)
        'PostgreSQL resolves to a private address (T-69)' = (& $private $Seen.postgres)
        'Foundry resolves to the private endpoint (T-68)' = (& $private $Seen.foundry)
        "Foundry refuses a request from outside the VNet: $FoundryStatus (T-68)" = ($FoundryStatus -eq 403)
        'PostgreSQL public network access is Disabled (T-69)' = ($PostgresAccess -eq 'Disabled')
    }
}

Export-ModuleMember -Function Step-DevVm, Step-Verify, New-DevVmSetupScript, Read-DevVmPassword, Get-VerifyChecks, Test-PrivateAddress
