# Azure CLI runner for infra/azure-private/Deploy-Gateway.ps1 (ADR-0005). Read commands always run; commands that
# change Azure run only without -Plan, and -Plan prints them instead, as the preview the charter requires.
# Secrets never appear on a command line: they reach az as @file arguments, which the Azure CLI reads from the file, and
# the files are removed when the run ends. az runs through System.Diagnostics.Process, not through cmd.exe, which would
# parse the arguments again, and its output is read as text, not through cmdlets whose parameter bindings PowerShell
# module logging records (event 4103).
Set-StrictMode -Version Latest

$script:Plan = $false
$script:Az = $null
$script:SecretDir = $null
$script:Planned = [Collections.Generic.List[string]]::new()

# The program and leading arguments that run the Azure CLI. On Windows az.cmd starts python.exe -IBm azure.cli; this runs
# that directly. Tests replace az with a fake Node.js script (CGW_AZ_COMMAND, tests/azure-private/fake-az.mjs).
function Resolve-AzInvocation {
    if ($env:CGW_AZ_COMMAND) {
        $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        return @{ File = $node; Prefix = @($env:CGW_AZ_COMMAND) }
    }
    $az = Get-Command az -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $az) { throw 'The Azure CLI (az) was not found on PATH. Install it: https://learn.microsoft.com/cli/azure/install-azure-cli' }
    $python = Join-Path (Split-Path (Split-Path $az.Source -Parent) -Parent) 'python.exe'
    if ($az.Source -like '*.cmd' -and (Test-Path -LiteralPath $python)) { return @{ File = $python; Prefix = @('-IBm', 'azure.cli') } }
    @{ File = $az.Source; Prefix = @() }
}

function Initialize-AzRunner {
    param([switch]$Plan)
    $script:Plan = [bool]$Plan
    $script:Planned.Clear()
    $script:Az = Resolve-AzInvocation
    $script:SecretDir = Join-Path ([IO.Path]::GetTempPath()) ('cgw-private-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:SecretDir)
}

function Test-AzPlan { $script:Plan }
function Set-AzPlan([bool]$On) { $script:Plan = $On }
function Get-AzPlanned { , $script:Planned.ToArray() }

# Writes a value to a file in the run's own temporary directory and returns the @file argument for az. Under -Plan the
# file is not written: the command is only shown.
function New-AzSecretArgument {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $path = Join-Path $script:SecretDir $Name
    if (-not $script:Plan) { [IO.File]::WriteAllText($path, $Value, [Text.UTF8Encoding]::new($false)) }
    "@$path"
}
function Get-AzWorkFile([string]$Name) { Join-Path $script:SecretDir $Name }

function Clear-AzSecrets {
    if ($script:SecretDir -and [IO.Directory]::Exists($script:SecretDir)) { [IO.Directory]::Delete($script:SecretDir, $true) }
}

function Format-AzCommand([string[]]$Arguments) {
    ($Arguments | ForEach-Object { if ($_ -match '[\s"*]' -or $_ -eq '') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } }) -join ' '
}

function Invoke-AzProcess([string[]]$Arguments) {
    $psi = [Diagnostics.ProcessStartInfo]::new($script:Az.File)
    foreach ($a in @($script:Az.Prefix) + $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    $err = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    [pscustomobject]@{ Code = $p.ExitCode; Out = $out; Err = $err.Result }
}

$script:NotFound = 'ResourceNotFound|ResourceGroupNotFound|ParentResourceNotFound|NotFound|not found|could not be found|does not exist|Code: 404|\(404\)'
# The Azure CLI's answer for a Container App secret the app does not have (measured 2026-09-30).
$script:SecretNotFound = 'does not have a secret assigned with name'

# A command that opens a session, such as az containerapp exec: standard input is closed, so the session ends with its
# command, and a session that outlasts the timeout is stopped.
function Invoke-AzSession {
    param([Parameter(Mandatory)][string[]]$Arguments, [int]$TimeoutSeconds = 180)
    $psi = [Diagnostics.ProcessStartInfo]::new($script:Az.File)
    foreach ($a in @($script:Az.Prefix) + $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) { $p.Kill($true); throw "az $($Arguments[0..1] -join ' ') did not end within $TimeoutSeconds seconds" }
    [pscustomobject]@{ Code = $p.ExitCode; Out = $out.Result; Err = $err.Result }
}

# A read: the parsed JSON, or $null when az reports that the resource does not exist. Some show commands answer a
# missing child resource with {} and exit code 0, such as az network private-endpoint dns-zone-group show; an object
# without properties counts as missing too. With -Required, an answer that the resource does not exist is a failure.
function Invoke-AzRead {
    param([Parameter(Mandatory)][AllowEmptyString()][string[]]$Arguments, [switch]$Required)
    $r = Invoke-AzProcess ($Arguments + @('--output', 'json'))
    if ($r.Code -ne 0) {
        if (-not $Required -and $r.Err -match $script:NotFound) { return $null }
        throw "az $(Format-AzCommand $Arguments) failed ($($r.Code)): $($r.Err.Trim())"
    }
    if (-not $r.Out.Trim()) { return $null }
    $value = ConvertFrom-Json -InputObject $r.Out -Depth 64
    if ($value -is [Management.Automation.PSCustomObject] -and -not @($value.PSObject.Properties).Count) { return $null }
    $value
}

# A read whose output holds a secret: the text, which the caller keeps in a variable and writes only to a file. With
# -AllowMissing, a resource or secret that does not exist is $null; any other failure, such as a service that is
# unavailable, still stops the caller, so a secret is never replaced because a read failed.
function Invoke-AzSecretRead {
    param([Parameter(Mandatory)][AllowEmptyString()][string[]]$Arguments, [switch]$AllowMissing)
    $r = Invoke-AzProcess ($Arguments + @('--output', 'tsv'))
    if ($r.Code -ne 0) {
        if ($AllowMissing -and ($r.Err -match $script:NotFound -or $r.Err -match $script:SecretNotFound)) { return $null }
        throw "az $(Format-AzCommand $Arguments) failed ($($r.Code)): $($r.Err.Trim())"
    }
    $r.Out.Trim()
}

# A change: printed under -Plan, run otherwise. -Secret returns the output as text, for a command that returns a secret.
function Invoke-AzChange {
    param([Parameter(Mandatory)][AllowEmptyString()][string[]]$Arguments, [switch]$Secret)
    $shown = Format-AzCommand $Arguments
    if ($script:Plan) {
        $script:Planned.Add("az $shown")
        Write-Host "  PLAN  az $shown"
        return $null
    }
    Write-Host "  RUN   az $shown"
    $r = Invoke-AzProcess ($Arguments + @('--output', $(if ($Secret) { 'tsv' } else { 'json' })))
    if ($r.Code -ne 0) { throw "az $shown failed ($($r.Code)): $($r.Err.Trim())" }
    if ($Secret) { return $r.Out.Trim() }
    if (-not $r.Out.Trim()) { return $null }
    ConvertFrom-Json -InputObject $r.Out -Depth 64
}

# Reports a resource the step found and left alone, so a re-run shows what it did not change.
function Write-AzFound([string]$What) { Write-Host "  FOUND $What" }

# A property of an Azure CLI answer, or $null when the answer or the property is missing (strict mode refuses to read a
# property an object does not have).
function Get-AzValue($object, [string]$Name) {
    if ($null -ne $object -and $object.PSObject.Properties[$Name]) { $object.PSObject.Properties[$Name].Value } else { $null }
}

Export-ModuleMember -Function Initialize-AzRunner, Test-AzPlan, Set-AzPlan, Get-AzPlanned, New-AzSecretArgument, Get-AzWorkFile, Clear-AzSecrets,
    Invoke-AzRead, Invoke-AzSecretRead, Invoke-AzChange, Invoke-AzSession, Write-AzFound, Format-AzCommand, Get-AzValue
