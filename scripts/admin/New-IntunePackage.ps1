<#
.SYNOPSIS
    Packages the two Intune Win32 apps that scripts/admin/new-client-policy.mjs writes into <policy folder>\intune, with
    the Microsoft Win32 Content Prep Tool (P-39, T-120).

.DESCRIPTION
    Runs IntuneWinAppUtil.exe once for 1-claude-code (setup file Install-ClaudeCode.ps1) and once for 2-gateway-profile
    (setup file Install-Profile.ps1), quietly, then checks that both .intunewin files exist and prints their paths. The
    tool zips every file in a folder it packages, so it is kept outside the policy folder
    (https://learn.microsoft.com/en-us/intune/app-management/deployment/create-win32-package). The Intune field values
    for each app are in <policy folder>\intune\INTUNE.txt.

.PARAMETER PolicyFolder
    The folder new-client-policy.mjs wrote. Default: .\client-policy.

.PARAMETER ToolPath
    IntuneWinAppUtil.exe, from https://go.microsoft.com/fwlink/?linkid=2065730.

.PARAMETER OutputFolder
    Where the .intunewin files go. Default: .\intunewin, created when missing.

.EXAMPLE
    pwsh -File scripts/admin/New-IntunePackage.ps1 -ToolPath C:\tools\prep\IntuneWinAppUtil.exe
#>
[CmdletBinding()]
param(
    [string]$PolicyFolder = '.\client-policy',
    [Parameter(Mandatory = $true)][string]$ToolPath,
    [string]$OutputFolder = '.\intunewin'
)
$ErrorActionPreference = 'Stop'
$intune = Join-Path $PolicyFolder 'intune'
if (-not (Test-Path -LiteralPath (Join-Path $intune 'INTUNE.txt'))) {
    throw "$intune has no INTUNE.txt. Write it first: node scripts/admin/new-client-policy.mjs --gateway-url <gateway URL> --out $PolicyFolder"
}
if (-not (Test-Path -LiteralPath $ToolPath -PathType Leaf)) { throw "IntuneWinAppUtil.exe was not found at $ToolPath. Download it from https://go.microsoft.com/fwlink/?linkid=2065730." }
New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
$output = (Resolve-Path -LiteralPath $OutputFolder).Path
$apps = @(@{ Folder = '1-claude-code'; Setup = 'Install-ClaudeCode.ps1' }, @{ Folder = '2-gateway-profile'; Setup = 'Install-Profile.ps1' })
foreach ($app in $apps) {
    $source = (Resolve-Path -LiteralPath (Join-Path $intune $app.Folder)).Path
    & $ToolPath -c $source -s $app.Setup -o $output -q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "IntuneWinAppUtil.exe failed for $($app.Folder) (exit $LASTEXITCODE)." }
    $file = Join-Path $output ([IO.Path]::GetFileNameWithoutExtension($app.Setup) + '.intunewin')
    if (-not (Test-Path -LiteralPath $file)) { throw "IntuneWinAppUtil.exe wrote no $file." }
    Write-Output $file
}
