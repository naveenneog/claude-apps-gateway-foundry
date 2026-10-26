// Claude Desktop's machine policy for a Claude apps gateway (P-41, T-124): the bootstrapUrl value under
// HKLM\SOFTWARE\Policies\Claude (https://claude.com/docs/third-party/claude-desktop/mdm#4-deploy-the-configuration), as a
// .reg file, as an Intune platform script, and DESKTOP.txt saying how to deploy either. new-client-policy.mjs writes
// them to the desktop folder; the admin console serves the same files (admin-ui/server/client-kit.mjs).

export const desktopBootstrapUrl = (origin) => `${origin}/user/bootstrap`;

// UTF-16LE with a byte order mark and CRLF line breaks, as regedit exports a key.
export function desktopRegistryFile(origin) {
  const text = ['Windows Registry Editor Version 5.00', '', '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude]',
    `"bootstrapUrl"="${desktopBootstrapUrl(origin)}"`, ''].join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

// A 32-bit PowerShell on 64-bit Windows writes HKLM\SOFTWARE under WOW6432Node, where Desktop does not look
// (https://learn.microsoft.com/en-us/windows/win32/winprog64/registry-redirector), so the script refuses to run there (U-111).
// New-Item -Force would recreate an existing key and drop its other values, so the key is created only when missing.
// origin has passed new-client-policy.mjs's gatewayOrigin: https, a host of letters, digits, dots and hyphens.
export function desktopPolicyScript(origin) {
  const url = desktopBootstrapUrl(origin);
  return [
    '<#',
    '.SYNOPSIS',
    `    Sets Claude Desktop's bootstrapUrl machine policy to ${url}.`,
    '.DESCRIPTION',
    '    Intune: Devices > Scripts and remediations > Platform scripts, with "Run this script using the logged on',
    '    credentials" No and "Run script in 64-bit PowerShell host" Yes (DESKTOP.txt). By hand: an administrator',
    '    Windows PowerShell. Other values under the key are kept. Exit 0: set; 1: refused or failed.',
    '#>',
    'param([string]$Key = \'HKLM:\\SOFTWARE\\Policies\\Claude\')',
    '$ErrorActionPreference = \'Stop\'',
    'if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {',
    '    [Console]::Error.WriteLine(\'Set-ClaudeDesktopPolicy: this is 32-bit PowerShell on 64-bit Windows, which writes the policy under WOW6432Node, where Claude Desktop does not read it. In Intune, set "Run script in 64-bit PowerShell host" to Yes.\')',
    '    exit 1',
    '}',
    'try {',
    '    if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }',
    `    New-ItemProperty -LiteralPath $Key -Name bootstrapUrl -PropertyType String -Value '${url}' -Force | Out-Null`,
    '} catch {',
    '    [Console]::Error.WriteLine("Set-ClaudeDesktopPolicy: $($_.Exception.Message)")',
    '    exit 1',
    '}',
    `Write-Output "Set-ClaudeDesktopPolicy: bootstrapUrl is ${url}"`,
    'exit 0',
    '',
  ].join('\r\n');
}

export function desktopText(origin) {
  const url = desktopBootstrapUrl(origin);
  return [
    `Claude Desktop through the Claude apps gateway at ${origin}`,
    '',
    `Claude Desktop reads one machine policy: bootstrapUrl = ${url}, a REG_SZ value under`,
    'HKLM\\SOFTWARE\\Policies\\Claude. Desktop then signs in to the gateway with a device code. The developer\'s gateway',
    'role must have Claude Desktop turned on (admin console > Access & models); otherwise the gateway answers 404.',
    'Desktop reads the policy when it starts, so quit and reopen it after the policy arrives.',
    '',
    'Option 1, Intune platform script (many machines)',
    '  Intune admin center > Devices > Scripts and remediations > Platform scripts > Add > Windows 10 and later.',
    '  Script location: Set-ClaudeDesktopPolicy.ps1 from this folder.',
    '  Run this script using the logged on credentials: No',
    '  Enforce script signature check: No',
    '  Run script in 64-bit PowerShell host: Yes',
    '  Assignments: the device or user group of the developers. The script reports "bootstrapUrl is ..." on success.',
    '  https://learn.microsoft.com/en-us/intune/device-management/tools/run-powershell-scripts-windows',
    '',
    'Option 2, one machine',
    '  Double-click ClaudeDesktop-HKLM.reg and accept the prompts, or in an administrator Windows PowerShell:',
    '    powershell -NoProfile -ExecutionPolicy Bypass -File .\\Set-ClaudeDesktopPolicy.ps1',
    '',
    'Check: in Windows PowerShell,',
    '  (Get-ItemProperty HKLM:\\SOFTWARE\\Policies\\Claude).bootstrapUrl',
    `prints ${url}.`,
    '',
    'Reference: https://claude.com/docs/third-party/claude-desktop/mdm',
    '',
  ].join('\r\n');
}
