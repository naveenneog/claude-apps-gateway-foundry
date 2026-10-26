// The Intune package for a gateway on a public address (T-120, P-39). Claude Code's /login accepts only a gateway
// whose host name resolves to private addresses (https://code.claude.com/docs/en/claude-apps-gateway#prerequisites),
// so a forced-login policy cannot work there; developers use the gateway profile (ADR-0004) instead. Intune delivers
// it as two Win32 apps (https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32):
//   1-claude-code       System context. claude.exe, pinned and checked against its release SHA-256, as the network-
//                       restricted deployment's test VM installs it (infra/azure-private/lib/Steps.Dev.psm1).
//   2-gateway-profile   User context. Install-ClaudeGatewayProfile.ps1 -NoSignIn: Intune installs silently, so the
//                       developer signs in on first use. Detected by Detect-Profile.ps1.
// The scripts run in Windows PowerShell 5.1 and hold only ASCII.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The same release infra/azure-private/Deploy-Gateway.ps1 installs; tests/intune-package.test.mjs fails if they differ.
export const CLAUDE_CODE_WINDOWS = Object.freeze({
  version: '2.1.284',
  sha256: '0416631e846f743110da5282409776fa1313e65f33a588aae066eaf8db0fda7d',
});
const releaseUrl = (version) => `https://downloads.claude.ai/claude-code-releases/${version}/win32-x64/claude.exe`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const crlf = (lines) => `${lines.join('\r\n')}\r\n`;
// Appends one dated line to $LogFile; a log that cannot be written does not change the result.
const LOG_FUNCTION = 'function Write-InstallLog([string]$Text) { try { New-Item -ItemType Directory -Path (Split-Path -Parent $LogFile) -Force | Out-Null; Add-Content -LiteralPath $LogFile -Value ("{0:u} {1}" -f (Get-Date), $Text) -Encoding ASCII } catch { } }';

function installClaudeCode(claude) {
  return crlf([
    '<#',
    '.SYNOPSIS',
    `    Installs Claude Code ${claude.version} for every user of the device, from Anthropic's release bucket, after checking`,
    '    its SHA-256. Run by Intune in System context. Exit 0: installed. Exit 1: nothing installed; the reason is on stderr and in',
    '    -LogFile, because Intune keeps neither.',
    '#>',
    '[CmdletBinding()]',
    'param(',
    `    [string]$SourceUrl = ${psQuote(releaseUrl(claude.version))},`,
    `    [string]$Sha256 = ${psQuote(claude.sha256)},`,
    "    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Anthropic\\ClaudeCode'),",
    "    [string]$LogFile = (Join-Path $InstallDir 'install-claude-code.log')",
    ')',
    LOG_FUNCTION,
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null',
    "    $exe = Join-Path $InstallDir 'claude.exe'",
    // A running claude.exe cannot be replaced; Intune retries a failed required install later.
    "    if (@(Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -ieq $exe }).Count) { throw \"Claude Code is running ($exe); this release installs when Intune retries after it is closed.\" }",
    '    $download = "$exe.download"',
    '    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '    (New-Object Net.WebClient).DownloadFile($SourceUrl, $download)',
    '    $stream = [IO.File]::OpenRead($download)',
    "    try { $hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Dispose() }",
    '    if ($hash -ne $Sha256.ToLowerInvariant()) {',
    '        Remove-Item -LiteralPath $download -Force',
    '        throw "The download has checksum $hash, not the release checksum $Sha256; nothing was installed."',
    '    }',
    '    Move-Item -LiteralPath $download -Destination $exe -Force',
    // Intune detects the release by this marker, so a package with a newer release installs over an older one.
    "    Get-ChildItem -LiteralPath $InstallDir -Filter 'claude-code-*.installed' | Remove-Item -Force",
    `    Set-Content -LiteralPath (Join-Path $InstallDir ${psQuote(`claude-code-${claude.version}.installed`)}) -Value $hash -Encoding ASCII`,
    '    Write-InstallLog "installed $exe ($hash)"',
    '    Write-Output "installed $exe ($hash)"',
    '    exit 0',
    '} catch {',
    '    Write-InstallLog "failed: $($_.Exception.Message)"',
    '    [Console]::Error.WriteLine("Install-ClaudeCode: $($_.Exception.Message)")',
    '    exit 1',
    '}',
  ]);
}

function uninstallClaudeCode() {
  return crlf([
    '<# Removes the Claude Code folder Install-ClaudeCode.ps1 wrote. Run by Intune in System context. #>',
    '[CmdletBinding()]',
    "param([string]$InstallDir = (Join-Path $env:ProgramFiles 'Anthropic\\ClaudeCode'))",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '    if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }',
    '    exit 0',
    '} catch {',
    '    [Console]::Error.WriteLine("Uninstall-ClaudeCode: $($_.Exception.Message)")',
    '    exit 1',
    '}',
  ]);
}

function installProfile(origin, fastModel, model) {
  const fast = (fastModel ? ` -FastModel ${psQuote(fastModel)}` : '') + (model ? ` -Model ${psQuote(model)}` : '');
  return crlf([
    '<#',
    '.SYNOPSIS',
    `    Writes the Claude Code gateway profile for ${origin} for the signed-in user, without signing in: Intune`,
    '    installs silently, so the developer signs in on first use. Run by Intune in User context.',
    '#>',
    '[CmdletBinding()]',
    "param([string]$ClaudePath, [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'ClaudeAppsGateway\\install-profile.log'))",
    LOG_FUNCTION,
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '    if (-not $ClaudePath) {',
    "        $candidates = @((Join-Path $env:ProgramFiles 'Anthropic\\ClaudeCode\\claude.exe'), (Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'))",
    '        $ClaudePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1',
    '        if (-not $ClaudePath) {',
    '            $command = Get-Command -Name claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
    '            if ($command) { $ClaudePath = $command.Source }',
    '        }',
    "        if (-not $ClaudePath) { throw 'Claude Code was not found. Deploy the Claude Code app (INTUNE.txt, app 1) before this one, or install Claude Code (https://code.claude.com/docs/en/setup).' }",
    '    }',
    // A child process, so the profile script's stderr, which Intune does not keep, reaches the install log.
    "    $ErrorActionPreference = 'Continue'",
    `    $output = & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Install-ClaudeGatewayProfile.ps1') -GatewayUrl ${psQuote(origin)} -ClaudePath $ClaudePath -NoSignIn -ReplaceGateway -DisableUpdates${fast} 2>&1`,
    '    $code = $LASTEXITCODE',
    "    $ErrorActionPreference = 'Stop'",
    '    $text = @($output | ForEach-Object { "$_" })',
    '    $text | ForEach-Object { Write-Output $_ }',
    "    if ($code -ne 0) { throw ($text -join ' ') }",
    '    # sign-in.cmd: the one command the developer runs once. It calls Connect-ClaudeGateway.ps1 from the runtime folder the',
    '    # profile was installed with, whose path the apiKeyHelper command in gateway.settings.json names.',
    "    $profileDir = Join-Path $env:USERPROFILE '.claude-apps-gateway'",
    "    $helper = ([IO.File]::ReadAllText((Join-Path $profileDir 'gateway.settings.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).apiKeyHelper",
    "    $match = [regex]::Match($helper, '-File \"([^\"]+)\\\\Get-ClaudeGatewayToken\\.ps1\"')",
    "    if (-not $match.Success) { throw 'The profile has no Get-ClaudeGatewayToken.ps1 path in its apiKeyHelper; sign-in.cmd was not written.' }",
    "    $connect = Join-Path $match.Groups[1].Value 'Connect-ClaudeGateway.ps1'",
    '    # cmd reads the file in the console code page: the profile path is written as %LOCALAPPDATA%, as the launcher does,',
    '    # so a user name outside ASCII stays out of the file.',
    "    $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA.TrimEnd('\\') } else { '' }",
    "    if ($local -and $connect.StartsWith($local + '\\', [StringComparison]::OrdinalIgnoreCase)) {",
    "        $connect = '%LOCALAPPDATA%' + $connect.Substring($local.Length)",
    '    }',
    "    if ($connect -match '[^\\x20-\\x7e]') { throw \"The sign-in path $connect has characters cmd cannot read; sign-in.cmd was not written.\" }",
    `    $line = '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "' + $connect + '" -GatewayUrl ${origin}'`,
    "    [IO.File]::WriteAllText((Join-Path $profileDir 'sign-in.cmd'), \"@echo off`r`n$line`r`n\", [Text.Encoding]::ASCII)",
    '    Write-InstallLog "installed the profile for $env:USERNAME"',
    '    exit 0',
    '} catch {',
    '    Write-InstallLog "failed: $($_.Exception.Message)"',
    '    [Console]::Error.WriteLine("Install-Profile: $($_.Exception.Message)")',
    '    exit 1',
    '}',
  ]);
}

function uninstallProfile(origin) {
  return crlf([
    '<#',
    '.SYNOPSIS',
    '    Signs the user out when a session exists, then removes the gateway profile folder, as START-HERE.txt describes.',
    '    Run by Intune in User context.',
    '#>',
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "    $sessions = Join-Path $env:LOCALAPPDATA 'ClaudeAppsGateway\\sessions'",
    "    if ((Test-Path -LiteralPath $sessions) -and @(Get-ChildItem -LiteralPath $sessions -Filter '*.bin').Count) {",
    `        try { & (Join-Path $PSScriptRoot 'Disconnect-ClaudeGateway.ps1') -GatewayUrl ${psQuote(origin)} } catch { [Console]::Error.WriteLine("Uninstall-Profile: sign-out failed: $($_.Exception.Message)") }`,
    '    }',
    "    $profileDir = Join-Path $env:USERPROFILE '.claude-apps-gateway'",
    '    if (Test-Path -LiteralPath $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force }',
    '    exit 0',
    '} catch {',
    '    [Console]::Error.WriteLine("Uninstall-Profile: $($_.Exception.Message)")',
    '    exit 1',
    '}',
  ]);
}

// Intune reads an app as installed when the detection script exits 0 and writes to STDOUT
// (https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32#step-4-detection-rules).
function detectProfile(origin) {
  return crlf([
    `<# Writes "installed" when the signed-in user has the gateway profile for ${origin}; writes nothing otherwise. #>`,
    "$profileDir = Join-Path $env:USERPROFILE '.claude-apps-gateway'",
    "$settings = Join-Path $profileDir 'gateway.settings.json'",
    "if ((Test-Path -LiteralPath (Join-Path $profileDir 'claude-gateway.cmd')) -and (Test-Path -LiteralPath $settings)) {",
    `    if ((Get-Content -LiteralPath $settings -Raw).Contains(${psQuote(origin)})) { Write-Output 'installed' }`,
    '}',
    'exit 0',
  ]);
}

function intuneText(origin, claude) {
  const ps = '%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File';
  return crlf([
    `Intune package: Claude Code through the Claude apps gateway at ${origin}`,
    '',
    'Two Win32 apps. App 2 depends on app 1. Guide: docs/learn/tutorial-first-install.md, "Onboard developers".',
    'Microsoft documents each field: https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32',
    '',
    '1. Package each folder with the Microsoft Win32 Content Prep Tool (https://go.microsoft.com/fwlink/?linkid=2065730),',
    '   kept outside this folder. From the repository, scripts/admin/New-IntunePackage.ps1 runs both commands:',
    '   pwsh -File scripts/admin/New-IntunePackage.ps1 -PolicyFolder <the folder above this one> -ToolPath <IntuneWinAppUtil.exe>',
    '   or, by hand:',
    '   IntuneWinAppUtil.exe -c <this folder>\\1-claude-code -s Install-ClaudeCode.ps1 -o <output folder> -q',
    '   IntuneWinAppUtil.exe -c <this folder>\\2-gateway-profile -s Install-Profile.ps1 -o <output folder> -q',
    '',
    '2. Intune admin center > Apps > All Apps > Create > Windows app (Win32), once per .intunewin file.',
    '',
    `App 1: Claude Code ${claude.version}`,
    '   App package file:     Install-ClaudeCode.intunewin',
    '   Name / Publisher:     Claude Code / Anthropic',
    `   Install command:      ${ps} .\\Install-ClaudeCode.ps1`,
    `   Uninstall command:    ${ps} .\\Uninstall-ClaudeCode.ps1`,
    '   Install behavior: System',
    '   Detection rules:      Manually configure > File',
    `                         Path: %ProgramFiles%\\Anthropic\\ClaudeCode   File or folder: claude-code-${claude.version}.installed   Detection method: File or folder exists   Associated with a 32-bit app on 64-bit clients: No`,
    '   Requirements:         Operating system architecture x64; Minimum operating system Windows 10 1809',
    '                         (Claude Code needs Windows 10 1809 or later: https://code.claude.com/docs/en/setup)',
    '   Network:              the device reaches https://downloads.claude.ai during the install',
    '',
    `App 2: Claude Code gateway profile (${origin})`,
    '   App package file:     Install-Profile.intunewin',
    '   Name / Publisher:     Claude Code gateway profile / your organization',
    `   Install command:      ${ps} .\\Install-Profile.ps1`,
    `   Uninstall command:    ${ps} .\\Uninstall-Profile.ps1`,
    '   Install behavior: User',
    '   Detection rules:      Use a custom detection script > Detect-Profile.ps1 (from the 2-gateway-profile folder)',
    '   Requirements:         Operating system architecture x64; Minimum operating system Windows 10 1809',
    '   Dependencies:         App 1, Automatically install: Yes',
    '',
    '3. Assign both apps as Required to an Entra security group of developers: a small pilot group first, then the group',
    '   of every developer who holds a gateway role. Intune assigns apps to groups; the gateway role is given separately.',
    '',
    'What the developer does once, in Windows PowerShell:',
    '   & "$env:USERPROFILE\\.claude-apps-gateway\\sign-in.cmd"',
    'It opens the browser for Microsoft Entra sign-in. From then on, this starts Claude Code through the gateway:',
    '   & "$env:USERPROFILE\\.claude-apps-gateway\\claude-gateway.cmd"',
  ]);
}

/** Every file of the intune folder, relative path -> content, for a gateway origin new-client-policy.mjs has checked. */
// claude: the Claude Code release to package, { version, sha256 } from its manifest.json win32-x64 entry; the pin by default.
export function intuneFiles({ origin, fastModel, model, claude = CLAUDE_CODE_WINDOWS }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(claude.version))) throw new Error(`Claude Code version ${JSON.stringify(claude.version)} is not of the form 2.1.284`);
  if (!/^[0-9a-f]{64}$/.test(String(claude.sha256))) throw new Error(`Claude Code SHA-256 ${JSON.stringify(claude.sha256)} is not 64 lower-case hex digits`);
  const files = {
    '1-claude-code/Install-ClaudeCode.ps1': installClaudeCode(claude),
    '1-claude-code/Uninstall-ClaudeCode.ps1': uninstallClaudeCode(),
    '2-gateway-profile/Install-Profile.ps1': installProfile(origin, fastModel, model),
    '2-gateway-profile/Uninstall-Profile.ps1': uninstallProfile(origin),
    '2-gateway-profile/Detect-Profile.ps1': detectProfile(origin),
    'INTUNE.txt': intuneText(origin, claude),
  };
  const developer = path.join(root, 'scripts', 'developer');
  for (const f of fs.readdirSync(developer).filter((n) => /\.(ps1|psm1)$/.test(n)).sort()) {
    files[`2-gateway-profile/${f}`] = fs.readFileSync(path.join(developer, f));
  }
  return files;
}
