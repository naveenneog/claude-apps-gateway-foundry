<#
.SYNOPSIS
    Checks that a machine is ready before someone follows a setup guide.

.DESCRIPTION
    Reads a JSON manifest of prerequisites and checks each one. Prints a plain
    table with a fix line under every failure. Exits 0 when the machine is ready
    and 1 when it is not, so it can gate a setup guide or run in CI.

    Check types: command, version, env, path, http, port, script.
    See references/preflight.md for every field.

.PARAMETER Manifest
    Path to the JSON manifest. Defaults to preflight.json next to this script.

.PARAMETER Json
    Print a machine-readable JSON result instead of the table.

.PARAMETER Quiet
    Only print failures and the summary line.

.PARAMETER FailFast
    Stop at the first failed check.

.EXAMPLE
    pwsh scripts\preflight.ps1
    pwsh scripts\preflight.ps1 -Manifest scripts\preflight.json -Json
#>
[CmdletBinding()]
param(
    [string] $Manifest,
    [switch] $Json,
    [switch] $Quiet,
    [switch] $FailFast
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- helpers ---

function Get-Field {
    param($Object, [string] $Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $Default }
    if ($null -eq $p.Value) { return $Default }
    return $p.Value
}

function ConvertTo-Comparable {
    # "v22.1.0-beta" -> [version] 22.1.0 ; returns $null when no version found
    param([string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $m = [regex]::Match($Text, '\d+(\.\d+){0,3}')
    if (-not $m.Success) { return $null }
    $parts = $m.Value.Split('.')
    while ($parts.Count -lt 2) { $parts += '0' }
    try { return [version]($parts -join '.') } catch { return $null }
}

function Hide-Secret {
    # Keeps the shape, hides the value: "sk-abc...wxyz" -> "sk-*********wxyz"
    param([string] $Value)
    if ([string]::IsNullOrEmpty($Value)) { return '(empty)' }
    if ($Value.Length -le 4) { return ('*' * $Value.Length) }
    $tail = $Value.Substring($Value.Length - 4)
    return (('*' * [Math]::Min(12, $Value.Length - 4)) + $tail)
}

function Invoke-Capture {
    # Runs "exe arg arg" without a shell. Returns @{ ok; text; code }
    param([string] $CommandLine, [int] $TimeoutSec = 30)
    $parts = $CommandLine.Trim() -split '\s+'
    $exe = $parts[0]
    $rest = @()
    if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
    $resolved = Get-Command $exe -ErrorAction SilentlyContinue
    if ($null -eq $resolved) {
        return @{ ok = $false; text = "'$exe' is not installed or not on PATH"; code = 127 }
    }
    try {
        $global:LASTEXITCODE = 0
        $out = & $exe @rest 2>&1 | Out-String
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        return @{ ok = ($code -eq 0); text = $out.Trim(); code = $code }
    } catch {
        return @{ ok = $false; text = $_.Exception.Message; code = 1 }
    }
}

# ------------------------------------------------------------ check types ---

function Test-CommandCheck {
    param($Check)
    $name = [string](Get-Field $Check 'command' (Get-Field $Check 'name' ''))
    $exe = ($name.Trim() -split '\s+')[0]
    $found = Get-Command $exe -ErrorAction SilentlyContinue
    if ($null -eq $found) {
        return @{ pass = $false; detail = "'$exe' was not found on PATH" }
    }
    $where = [string](Get-Field $found 'Source' $found.Name)
    return @{ pass = $true; detail = "found at $where" }
}

function Test-VersionCheck {
    param($Check)
    $cmd = [string](Get-Field $Check 'command' '')
    if ([string]::IsNullOrWhiteSpace($cmd)) {
        return @{ pass = $false; detail = "manifest error: 'command' is missing" }
    }
    $run = Invoke-Capture -CommandLine $cmd
    if (-not $run.ok -and $run.code -eq 127) {
        return @{ pass = $false; detail = $run.text }
    }
    $found = ConvertTo-Comparable $run.text
    if ($null -eq $found) {
        return @{ pass = $false; detail = "could not read a version from: $($run.text)" }
    }
    $min = [string](Get-Field $Check 'min' '')
    $max = [string](Get-Field $Check 'max' '')
    $wanted = @()
    if ($min) { $wanted += "$min or newer" }
    if ($max) { $wanted += "below $max" }
    $want = ''
    if ($wanted.Count -gt 0) { $want = ' (need ' + ($wanted -join ', ') + ')' }

    if ($min) {
        $minV = ConvertTo-Comparable $min
        if ($null -ne $minV -and $found -lt $minV) {
            return @{ pass = $false; detail = "found $found, need $min or newer" }
        }
    }
    if ($max) {
        $maxV = ConvertTo-Comparable $max
        if ($null -ne $maxV -and $found -ge $maxV) {
            return @{ pass = $false; detail = "found $found, need a version below $max" }
        }
    }
    return @{ pass = $true; detail = "$found$want" }
}

function Test-EnvCheck {
    param($Check)
    $var = [string](Get-Field $Check 'var' '')
    if ([string]::IsNullOrWhiteSpace($var)) {
        return @{ pass = $false; detail = "manifest error: 'var' is missing" }
    }
    $value = [Environment]::GetEnvironmentVariable($var)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return @{ pass = $false; detail = "$var is not set" }
    }
    $secret = [bool](Get-Field $Check 'secret' $true)
    $shown = $value
    if ($secret) { $shown = Hide-Secret $value }
    $prefix = [string](Get-Field $Check 'startsWith' '')
    if ($prefix -and -not $value.StartsWith($prefix)) {
        return @{ pass = $false; detail = "$var is set but does not start with '$prefix'" }
    }
    return @{ pass = $true; detail = "$var = $shown" }
}

function Test-PathCheck {
    param($Check)
    $path = [string](Get-Field $Check 'path' '')
    if ([string]::IsNullOrWhiteSpace($path)) {
        return @{ pass = $false; detail = "manifest error: 'path' is missing" }
    }
    $expect = [string](Get-Field $Check 'expect' 'exists')
    $exists = Test-Path -LiteralPath $path
    if ($expect -eq 'missing') {
        if ($exists) { return @{ pass = $false; detail = "$path already exists" } }
        return @{ pass = $true; detail = "$path is not there yet, good" }
    }
    if (-not $exists) { return @{ pass = $false; detail = "$path was not found" } }
    return @{ pass = $true; detail = "$path is there" }
}

function Test-HttpCheck {
    param($Check)
    $url = [string](Get-Field $Check 'url' '')
    if ([string]::IsNullOrWhiteSpace($url)) {
        return @{ pass = $false; detail = "manifest error: 'url' is missing" }
    }
    $timeout = [int](Get-Field $Check 'timeoutSec' 15)
    $want = [int](Get-Field $Check 'expectStatus' 200)
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeout -MaximumRedirection 5
        $code = [int]$resp.StatusCode
    } catch {
        $code = 0
        $r = $null
        try { $r = $_.Exception.Response } catch { $r = $null }
        if ($null -ne $r) {
            try { $code = [int]$r.StatusCode } catch { $code = 0 }
        }
        if ($code -eq 0) {
            return @{ pass = $false; detail = "could not reach $url" }
        }
    }
    if ($code -ne $want) {
        return @{ pass = $false; detail = "$url answered $code, expected $want" }
    }
    return @{ pass = $true; detail = "$url answered $code" }
}

function Test-PortCheck {
    param($Check)
    $port = [int](Get-Field $Check 'port' 0)
    if ($port -le 0) {
        return @{ pass = $false; detail = "manifest error: 'port' is missing" }
    }
    $expect = [string](Get-Field $Check 'expect' 'free')
    $inUse = $false
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
    } catch {
        $inUse = $true
    } finally {
        if ($null -ne $listener) { try { $listener.Stop() } catch { } }
    }
    if ($expect -eq 'inuse') {
        if ($inUse) { return @{ pass = $true; detail = "something is listening on port $port" } }
        return @{ pass = $false; detail = "nothing is listening on port $port" }
    }
    if ($inUse) { return @{ pass = $false; detail = "port $port is already taken" } }
    return @{ pass = $true; detail = "port $port is free" }
}

function Test-ScriptCheck {
    param($Check)
    $run = [string](Get-Field $Check 'run' '')
    if ([string]::IsNullOrWhiteSpace($run)) {
        return @{ pass = $false; detail = "manifest error: 'run' is missing" }
    }
    $contains = [string](Get-Field $Check 'contains' '')
    try {
        $global:LASTEXITCODE = 0
        $out = (Invoke-Expression $run 2>&1 | Out-String).Trim()
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    } catch {
        return @{ pass = $false; detail = $_.Exception.Message }
    }
    $first = ($out -split "`n")[0].Trim()
    if ($first.Length -gt 90) { $first = $first.Substring(0, 90) + '...' }
    if ($code -ne 0) {
        if ([string]::IsNullOrWhiteSpace($first)) { $first = 'no output' }
        return @{ pass = $false; detail = "command failed (exit $code): $first" }
    }
    if ($contains -and ($out -notmatch [regex]::Escape($contains))) {
        return @{ pass = $false; detail = "output did not contain '$contains'" }
    }
    if ([string]::IsNullOrWhiteSpace($first)) { $first = 'ok' }
    return @{ pass = $true; detail = $first }
}

# -------------------------------------------------------------------- run ---

if ([string]::IsNullOrWhiteSpace($Manifest)) {
    $Manifest = Join-Path $PSScriptRoot 'preflight.json'
}
if (-not (Test-Path -LiteralPath $Manifest)) {
    Write-Host "Cannot find the manifest: $Manifest" -ForegroundColor Red
    Write-Host "Copy templates\preflight.json next to this script and fill it in."
    exit 2
}

try {
    $doc = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
} catch {
    Write-Host "The manifest is not valid JSON: $Manifest" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 2
}

$title = [string](Get-Field $doc 'title' 'Preflight check')
$checks = @(Get-Field $doc 'checks' @())
if ($checks.Count -eq 0) {
    Write-Host "The manifest has no checks." -ForegroundColor Red
    exit 2
}

if (-not $Json -and -not $Quiet) {
    Write-Host ''
    Write-Host "$title - preflight check"
    Write-Host ('=' * ($title.Length + 18))
    Write-Host ''
}

$results = @()
$pass = 0; $fail = 0; $warn = 0
$stopped = $false

foreach ($check in $checks) {
    $name = [string](Get-Field $check 'name' '(unnamed)')
    $type = ([string](Get-Field $check 'type' 'command')).ToLowerInvariant()
    $optional = [bool](Get-Field $check 'optional' $false)
    $fix = [string](Get-Field $check 'fix' '')

    if ($stopped) {
        $results += [pscustomobject]@{ name = $name; type = $type; status = 'skipped'; detail = 'not run'; fix = $fix }
        continue
    }

    switch ($type) {
        'command' { $r = Test-CommandCheck $check }
        'version' { $r = Test-VersionCheck $check }
        'env'     { $r = Test-EnvCheck     $check }
        'path'    { $r = Test-PathCheck    $check }
        'http'    { $r = Test-HttpCheck    $check }
        'port'    { $r = Test-PortCheck    $check }
        'script'  { $r = Test-ScriptCheck  $check }
        default   { $r = @{ pass = $false; detail = "unknown check type '$type'" } }
    }

    $status = 'ok'
    if (-not $r.pass) { if ($optional) { $status = 'warn' } else { $status = 'fail' } }

    if ($status -eq 'ok') { $pass++ } elseif ($status -eq 'warn') { $warn++ } else { $fail++ }

    $results += [pscustomobject]@{ name = $name; type = $type; status = $status; detail = [string]$r.detail; fix = $fix }

    if (-not $Json) {
        $label = '[ OK ]'; $color = 'Green'
        if ($status -eq 'warn') { $label = '[WARN]'; $color = 'Yellow' }
        if ($status -eq 'fail') { $label = '[FAIL]'; $color = 'Red' }
        if (-not ($Quiet -and $status -eq 'ok')) {
            $padded = $name.PadRight(24)
            Write-Host "$label " -ForegroundColor $color -NoNewline
            Write-Host "$padded $($r.detail)"
            if ($status -ne 'ok' -and $fix) {
                Write-Host "       Fix: $fix" -ForegroundColor Cyan
            }
        }
    }

    if ($FailFast -and $status -eq 'fail') { $stopped = $true }
}

$ready = ($fail -eq 0)

if ($Json) {
    [pscustomobject]@{
        title   = $title
        ready   = $ready
        passed  = $pass
        failed  = $fail
        warned  = $warn
        checks  = $results
    } | ConvertTo-Json -Depth 6
} else {
    Write-Host ''
    Write-Host "$pass passed, $fail failed, $warn warning(s)."
    if ($ready) {
        Write-Host 'Ready. You can start at Step 1.' -ForegroundColor Green
    } else {
        Write-Host 'Not ready. Fix each [FAIL] line above, then run this again.' -ForegroundColor Red
    }
    Write-Host ''
}

if ($ready) { exit 0 } else { exit 1 }
