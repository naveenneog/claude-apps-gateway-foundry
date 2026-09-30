<#
.SYNOPSIS
    Sets up a Claude Code profile that reaches a Claude apps gateway through the developer credential helper.

.DESCRIPTION
    Installs the runtime scripts (ClaudeGateway.psm1, Connect-, Disconnect- and Get-ClaudeGatewayToken.ps1) into
    %LOCALAPPDATA%\ClaudeAppsGateway\bin\<version>, where <version> is a hash of their content, so a profile keeps the
    runtime it was installed with. Then it writes a profile directory, by default %USERPROFILE%\.claude-apps-gateway:

      settings.json          apiKeyHelper runs that runtime's Get-ClaudeGatewayToken.ps1 for this gateway. env sets
                             ANTHROPIC_BASE_URL; empties the CLAUDE_CODE_USE_* provider switches and ANTHROPIC_AUTH_TOKEN
                             and ANTHROPIC_API_KEY, which outrank apiKeyHelper; turns off fast mode, whose availability
                             check sends the token to api.anthropic.com; and sets CLAUDE_CODE_API_KEY_HELPER_TTL_MS to
                             240000, below the helper's five-minute refresh window. Other keys already in the file are kept.
      gateway.settings.json  the same apiKeyHelper and env values, which the launcher passes with --settings. That level
                             outranks a repository's .claude/settings.json and .claude/settings.local.json, so their env
                             cannot send the token to another host
                             (https://code.claude.com/docs/en/settings#settings-precedence).
      claude-gateway.cmd     starts Claude Code with CLAUDE_CONFIG_DIR set to the profile directory and
                             --settings gateway.settings.json before the arguments it is given, after clearing the calling
                             shell's ANTHROPIC_* and CLAUDE_CODE_USE_* variables (https://code.claude.com/docs/en/authentication).
                             Claude Code uses only the last --settings argument, so one given to the launcher replaces
                             gateway.settings.json.

    Both commands use absolute paths, because cmd looks for a bare command name in the current directory before
    PATH. The developer's own %USERPROFILE%\.claude directory is not read or written. A profile that already points
    at another gateway is left unchanged unless -ReplaceGateway is given. The script ends by running
    Connect-ClaudeGateway.ps1 to sign in, unless -NoSignIn is given.

    Exit code 0: the profile is written (and, without -NoSignIn, the sign-in succeeded). Exit code 1: see stderr.

.PARAMETER GatewayUrl
    The gateway origin, for example https://gateway.contoso.com. http is accepted for a loopback address only.

.PARAMETER FastModel
    A model the gateway serves, used for Claude Code's background tasks (ANTHROPIC_DEFAULT_HAIKU_MODEL). Set it when
    the gateway serves no Haiku model.

.PARAMETER ProfileDir
    The profile directory. Default: %USERPROFILE%\.claude-apps-gateway. The default Claude Code directory,
    %USERPROFILE%\.claude, is refused.

.PARAMETER ClaudePath
    The Claude Code executable (claude.exe) or npm shim (claude.cmd). Default: the first one on PATH.

.PARAMETER ReplaceGateway
    Points an existing profile at this gateway when it was installed for another one.

.PARAMETER NoBrowser
    Passed to Connect-ClaudeGateway.ps1: shows the sign-in URL without opening a browser.

.PARAMETER NoSignIn
    Writes the profile without signing in.

.EXAMPLE
    .\Install-ClaudeGatewayProfile.ps1 -GatewayUrl https://gateway.contoso.com -FastModel claude-sonnet-5

.LINK
    https://code.claude.com/docs/en/settings-reference#apikeyhelper
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GatewayUrl,
    [string]$FastModel,
    [string]$ProfileDir,
    [string]$ClaudePath,
    [switch]$ReplaceGateway,
    [switch]$NoBrowser,
    [switch]$NoSignIn
)

$ErrorActionPreference = 'Stop'
$runtime = @('ClaudeGateway.psm1', 'Connect-ClaudeGateway.ps1', 'Disconnect-ClaudeGateway.ps1', 'Get-ClaudeGatewayToken.ps1')
# Each selects a provider other than ANTHROPIC_BASE_URL (https://code.claude.com/docs/en/env-vars).
$providerSwitches = @('CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE')

# A path written into a cmd command line: cmd expands %NAME% even inside quotes, and a path cannot hold a quote.
function Assert-CmdSafePath([string]$Path) {
    if ($Path.Contains('%') -or $Path.Contains('"')) { throw "The path '$Path' contains % or a quote, which cmd would change." }
}

function Resolve-ClaudeCode([string]$Requested) {
    if ($Requested) {
        if (-not (Test-Path -LiteralPath $Requested -PathType Leaf)) { throw "ClaudePath '$Requested' does not exist." }
        $found = (Resolve-Path -LiteralPath $Requested).ProviderPath
    } else {
        # PowerShell's command lookup, unlike cmd's, does not search the current directory.
        $command = Get-Command -Name claude -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -eq '.exe' -or $_.Extension -eq '.cmd' } | Select-Object -First 1
        if ($null -eq $command) { throw 'Claude Code was not found on PATH. Install it (https://code.claude.com/docs/en/setup), or pass -ClaudePath.' }
        $found = $command.Source
    }
    if ([IO.Path]::GetExtension($found) -notmatch '^\.(exe|cmd)$') { throw "ClaudePath '$found' is not a .exe or .cmd file." }
    # npm's claude.cmd runs this native executable; starting it directly keeps the shim's endlocal from undoing the
    # launcher's environment. Older packages have no native executable, and the launcher then uses call.
    if ([IO.Path]::GetExtension($found) -eq '.cmd') {
        $native = [IO.Path]::Combine([IO.Path]::GetDirectoryName($found), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
        if (Test-Path -LiteralPath $native -PathType Leaf) { return $native }
    }
    return $found
}

# cmd reads the launcher in the console code page, so a path under %LOCALAPPDATA%, %APPDATA% or %USERPROFILE% is
# written relative to that variable, which cmd expands at run time; any other character outside ASCII is refused.
function ConvertTo-LauncherPath([string]$Path) {
    foreach ($name in @('LOCALAPPDATA', 'APPDATA', 'USERPROFILE')) {
        $value = [string][Environment]::GetEnvironmentVariable($name)
        if ($value) {
            $prefix = $value.TrimEnd('\') + '\'
            if ($Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $Path = "%$name%\" + $Path.Substring($prefix.Length); break }
        }
    }
    if ($Path -match '[^\x20-\x7e]') { throw "The path '$Path' has characters outside ASCII that cmd cannot read from the launcher; pass -ClaudePath with an ASCII path." }
    return $Path
}

# Installs the runtime into bin\<hash of its content>: copied to a temporary directory, then renamed in one step, so
# a profile never points at a partly copied runtime, and installing a newer version leaves older profiles on theirs.
function Install-Runtime([string]$BinRoot) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = New-Object System.Collections.Generic.List[byte]
        foreach ($file in $runtime) {
            $bytes.AddRange([Text.Encoding]::UTF8.GetBytes("$file`n"))
            $bytes.AddRange([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $file)))
        }
        $version = -join ($sha.ComputeHash($bytes.ToArray())[0..5] | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
    $target = Join-Path $BinRoot $version
    if (Test-Path -LiteralPath (Join-Path $target 'Get-ClaudeGatewayToken.ps1')) { return $target }
    $temp = "$target.$PID.tmp"
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    foreach ($file in $runtime) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $temp $file) -Force }
    try { [IO.Directory]::Move($temp, $target) } catch {
        # Another installer placed the same version first; its copy is identical.
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath (Join-Path $target 'Get-ClaudeGatewayToken.ps1'))) { throw }
    }
    return $target
}

function Get-LauncherText([string]$Claude) {
    $path = ConvertTo-LauncherPath $Claude
    # The pinned settings come before the developer's arguments, so a --settings argument of their own replaces them:
    # Claude Code uses only the last --settings (U-50).
    $pinned = '--settings "%CLAUDE_CONFIG_DIR%\gateway.settings.json"'
    # A .cmd run without call never returns, and its own endlocal would end this launcher's setlocal.
    $run = "`"$path`" $pinned %*"
    if ($Claude.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) { $run = "call `"$path`" $pinned %*" }
    return @(
        '@echo off'
        'rem Starts Claude Code with the Claude apps gateway profile in this directory. Written by'
        'rem Install-ClaudeGatewayProfile.ps1; run that script again to change it.'
        'setlocal'
        'rem These variables outrank apiKeyHelper or select another provider.'
        'for /f "delims==" %%v in (''set ANTHROPIC_ 2^>nul'') do set "%%v="'
        'for /f "delims==" %%v in (''set CLAUDE_CODE_USE_ 2^>nul'') do set "%%v="'
        'for %%d in ("%~dp0.") do set "CLAUDE_CONFIG_DIR=%%~fd"'
        'if not exist "%CLAUDE_CONFIG_DIR%\gateway.settings.json" goto nosettings'
        "if not exist `"$path`" goto missing"
        $run
        'exit /b %ERRORLEVEL%'
        ':nosettings'
        'echo This profile has no gateway.settings.json. Run Install-ClaudeGatewayProfile.ps1 again. 1>&2'
        'exit /b 1'
        ':missing'
        "echo Claude Code is not at `"$path`". Run Install-ClaudeGatewayProfile.ps1 again. 1>&2"
        'exit /b 1'
    ) -join "`r`n"
}

try {
    Import-Module (Join-Path $PSScriptRoot 'ClaudeGateway.psm1') -DisableNameChecking
    $origin = ConvertTo-GatewayOrigin -Url $GatewayUrl
    if ($FastModel -and $FastModel -notmatch '^[A-Za-z0-9._:@/-]+$') { throw "The model ID '$FastModel' has characters that model IDs do not use." }

    $userHome = $env:USERPROFILE
    if (-not $ProfileDir) { $ProfileDir = Join-Path $userHome '.claude-apps-gateway' }
    # Resolved from the PowerShell location, which Set-Location changes and the process directory does not follow, then
    # through GetFullPath as the default directory is, which expands 8.3 short names such as C:\Users\RUNNER~1 (U-55).
    $ProfileDir = [IO.Path]::GetFullPath($PSCmdlet.GetUnresolvedProviderPathFromPSPath($ProfileDir)).TrimEnd('\')
    $defaultConfig = [IO.Path]::GetFullPath((Join-Path $userHome '.claude')).TrimEnd('\')
    if ($ProfileDir -eq $defaultConfig) {
        throw "The profile directory must not be $defaultConfig, the default Claude Code directory, which this script leaves alone."
    }
    $localRoot = $env:LOCALAPPDATA
    if (-not $localRoot) { $localRoot = [Environment]::GetFolderPath('LocalApplicationData') }
    $binRoot = [IO.Path]::Combine($localRoot, 'ClaudeAppsGateway', 'bin')
    $powershell = [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (-not (Test-Path -LiteralPath $powershell)) { throw "Windows PowerShell was not found at $powershell." }
    $claude = Resolve-ClaudeCode -Requested $ClaudePath
    foreach ($path in @($powershell, $binRoot, $ProfileDir, $claude)) { Assert-CmdSafePath $path }

    $settingsPath = Join-Path $ProfileDir 'settings.json'
    # The file can already hold credentials, so it is parsed into dictionaries, which module logging records by type
    # name only, and is never passed to a command as text or as a PSCustomObject (ClaudeGateway.psm1).
    $settings = [Collections.Generic.Dictionary[string, object]]::new()
    if (Test-Path -LiteralPath $settingsPath) {
        $holder = @{ Text = [IO.File]::ReadAllText($settingsPath) }
        if ($holder['Text'].Trim()) {
            $settings = ConvertFrom-GatewayJson -Holder $holder
            if ($null -eq $settings) { throw "$settingsPath does not hold a JSON object. Correct or remove it, then run this script again." }
        }
    }
    $envBlock = Get-JsonValue $settings 'env'
    if ($null -eq $envBlock) { $envBlock = [Collections.Generic.Dictionary[string, object]]::new(); $settings['env'] = $envBlock }
    if ($envBlock -isnot [Collections.IDictionary]) { throw "env in $settingsPath is not a JSON object. Correct it, then run this script again." }
    $previous = Get-JsonValue $envBlock 'ANTHROPIC_BASE_URL'
    if ($previous -and $previous -ne $origin -and -not $ReplaceGateway) {
        $suggested = Join-Path $userHome ('.claude-apps-gateway-' + (($origin -replace '^https?://', '') -replace '[^A-Za-z0-9.-]', '_'))
        throw "The profile $ProfileDir is for $previous. To keep it, install $origin into its own profile with -ProfileDir `"$suggested`". To point this profile at $origin instead, add -ReplaceGateway."
    }

    $bin = Install-Runtime -BinRoot $binRoot
    $helper = Join-Path $bin 'Get-ClaudeGatewayToken.ps1'
    $apiKeyHelper = "`"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`" -GatewayUrl $origin"
    # The values that decide where Claude Code sends the token and which credential it sends.
    $pinnedEnv = [ordered]@{ ANTHROPIC_BASE_URL = $origin }
    # Empty rather than absent: an empty env value cancels the same variable exported by the shell or set at a lower
    # settings level (https://code.claude.com/docs/en/settings-reference#env).
    foreach ($name in @('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY') + $providerSwitches) { $pinnedEnv[$name] = '' }
    # The fast mode check goes to api.anthropic.com with the apiKeyHelper token (https://code.claude.com/docs/en/fast-mode).
    $pinnedEnv['CLAUDE_CODE_DISABLE_FAST_MODE'] = '1'
    $pinnedEnv['CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK'] = '1'
    $pinnedEnv['CLAUDE_CODE_API_KEY_HELPER_TTL_MS'] = '240000'
    $settings['apiKeyHelper'] = $apiKeyHelper
    foreach ($name in $pinnedEnv.Keys) { $envBlock[$name] = $pinnedEnv[$name] }
    if ($FastModel) { $envBlock['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = $FastModel }

    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    $utf8 = New-Object Text.UTF8Encoding -ArgumentList $false
    [IO.File]::WriteAllText($settingsPath, (ConvertTo-GatewayJson -Value $settings -Indented), $utf8)
    # Written in full on every run: the launcher passes it with --settings, above a repository's settings.
    $pinned = [ordered]@{ apiKeyHelper = $apiKeyHelper; env = $pinnedEnv }
    [IO.File]::WriteAllText((Join-Path $ProfileDir 'gateway.settings.json'), (ConvertTo-GatewayJson -Value $pinned -Indented), $utf8)
    $launcher = Join-Path $ProfileDir 'claude-gateway.cmd'
    [IO.File]::WriteAllText($launcher, (Get-LauncherText -Claude $claude) + "`r`n", (New-Object Text.ASCIIEncoding))

    [Console]::Out.WriteLine("Profile for $origin written to $ProfileDir.")
    [Console]::Out.WriteLine('Start Claude Code through the gateway from PowerShell with:')
    [Console]::Out.WriteLine("  & `"$launcher`"")
    [Console]::Out.WriteLine('or from cmd with:')
    [Console]::Out.WriteLine("  `"$launcher`"")
    if ($NoSignIn) { exit 0 }
    & (Join-Path $bin 'Connect-ClaudeGateway.ps1') -GatewayUrl $origin -NoBrowser:$NoBrowser
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("Install-ClaudeGatewayProfile: $($_.Exception.Message)")
    exit 1
}