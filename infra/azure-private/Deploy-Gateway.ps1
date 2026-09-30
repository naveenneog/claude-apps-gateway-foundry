#Requires -Version 7.2
<#
.SYNOPSIS
    Deploys the Claude apps gateway on Azure in a network-restricted design (docs/adr/0005-network-restricted-deployment.md).
.DESCRIPTION
    Each step runs the Azure CLI commands the Learn tutorial shows (docs/learn/tutorial-deploy-network-restricted.md),
    creates what is missing, and reports what it found. -Plan reads the subscription and prints each command that would
    change it, and changes nothing. Steps, in order:
      network      resource group, VNet, subnets, NAT gateway for the developer subnet
      dns          private DNS zones of the Foundry endpoint families, linked to the VNet
      foundry      Foundry account, Claude deployments, private endpoint; public network access and keys off
      postgres     PostgreSQL Flexible Server with private access, database gateway
      registry     container registry and the gateway image, built from the signed Claude Code release
      identity     the gateway's user-assigned identity: AcrPull and Cognitive Services User
      environment  internal Container Apps environment, and the private DNS zone of its default domain
      telemetry    Application Insights on the environment's workspace, its role for the gateway identity, 30-day
                   retention, and the OpenTelemetry Collector image at its pinned digest (ADR-0007); off when the admin
                   file turns it off
      entra        app registration with the gateway's redirect URI and app roles; the operator holds a role
      app          the gateway Container App with config/gateway.azure-private.yaml; while telemetry is on, only the
                   operator may hold a role of the app registration (ADR-0007)
      devvm        a Windows 11 VM in the VNet, Azure Bastion Developer, Claude Code, VS Code and the Windows policies
      verify       name resolution, /readyz and the certificate from the VM; Foundry refuses this machine; with
                   telemetry on, the collector's answers, the metric in AppMetrics and the role holders
.EXAMPLE
    pwsh -File infra/azure-private/Deploy-Gateway.ps1 -Plan
.EXAMPLE
    pwsh -File infra/azure-private/Deploy-Gateway.ps1 -Step app
#>
[CmdletBinding()]
param(
    # One or more of the steps below, or all; a comma-separated list also works from pwsh -File.
    [string[]]$Step = 'all',
    [string]$ResourceGroup = 'rg-claude-gw-internal',
    # The network, the gateway, PostgreSQL and the developer VM. The region needs capacity for a new Container Apps
    # environment, PostgreSQL Flexible Server and Bastion Developer: for the test subscription, Central US refused the
    # environment (AKSCapacityHeavyUsage) and East US 2 restricts PostgreSQL (docs/UNKNOWNS.md, U-63).
    [string]$Location = 'northcentralus',
    # The Foundry account, where the subscription holds Claude quota; the private endpoint reaches it across regions.
    [string]$FoundryLocation = 'eastus2',
    [switch]$Plan,
    [ValidateRange(0, 300)][int]$MinReplicas = 2,
    # Twice replicas × store.max_connections, for the old and new revisions of a rollout, stays within the PostgreSQL
    # size's user connections: Burstable B1ms has 35
    # (https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits), so 2 × 3 × 5 = 30.
    [ValidateRange(1, 1000)][int]$MaxReplicas = 3,
    [ValidateRange(1, 10000)][int]$ConcurrentRequests = 150,
    [ValidateRange(1, 65535)][int]$MaxUpstreamRequests = 256,
    [string]$Cpu = '1.0',
    [string]$Memory = '2Gi',
    [string]$PostgresSku = 'Standard_B1ms',
    [string]$PostgresTier = 'Burstable',
    [ValidateSet('Disabled', 'Enabled')][string]$PostgresZonalResiliency = 'Disabled',
    [switch]$ZoneRedundant,
    [string]$OperatorRole = 'Gateway.Premium',
    [ValidateRange(1, 730)][int]$ClientSecretDays = 7,
    [switch]$RotateClientSecret,
    [string]$AllowedEmailDomain,
    # The attestation an Anthropic deployment carries: the legal entity name, its two-letter country code and industry.
    [string]$ClaudeOrganizationName,
    [ValidatePattern('^[A-Z]{2}$')][string]$ClaudeCountryCode = 'US',
    [string]$ClaudeIndustry = 'technology',
    [switch]$ShowDevVmPassword
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
foreach ($m in 'Az', 'Steps.Base', 'AppDefinition', 'Steps.App', 'Steps.Telemetry', 'Steps.Dev') { Import-Module (Join-Path $PSScriptRoot "lib\$m.psm1") -Force -DisableNameChecking }

Initialize-AzRunner -Plan:$Plan
try {
    $account = Invoke-AzRead @('account', 'show')
    if (-not $account) { throw 'The Azure CLI is not signed in. Run az login.' }
    # Globally unique names end in six hexadecimal digits derived from the subscription and resource group.
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("$($account.id)/$ResourceGroup"))
    $suffix = [Convert]::ToHexString($hash).Substring(0, 6).ToLowerInvariant()
    if (-not $AllowedEmailDomain) {
        $me = Invoke-AzRead @('ad', 'signed-in-user', 'show')
        $mail = if ($me.mail) { $me.mail } else { $me.userPrincipalName }
        $AllowedEmailDomain = ($mail -split '@')[-1]
    }
    $adminDeployment = ([IO.File]::ReadAllText((Join-Path $root 'config\gateway-admin.azure-private.json')) | ConvertFrom-Json).deployment
    $telemetry = [bool]($adminDeployment.PSObject.Properties['telemetry'] -and $adminDeployment.telemetry -eq $true)
    $c = @{
        SubscriptionId = $account.id; TenantId = $account.tenantId; ResourceGroup = $ResourceGroup; Location = $Location; FoundryLocation = $FoundryLocation
        Vnet = 'vnet-claude-gw'; AddressSpace = '10.40.0.0/16'
        Subnets = @{ aca = '10.40.0.0/23'; pe = '10.40.2.0/24'; pg = '10.40.3.0/27'; dev = '10.40.3.32/27' }
        NatGateway = 'ng-dev'; Foundry = "ai-claude-gw-$suffix"; Postgres = "psql-claude-gw-$suffix"; PostgresUser = 'gatewayadmin'
        PostgresSku = $PostgresSku; PostgresTier = $PostgresTier; PostgresVersion = '16'; PostgresZonalResiliency = $PostgresZonalResiliency
        Acr = "acrclaudegw$suffix"; Identity = 'id-claude-gw'; Workspace = 'log-claude-gw'; Environment = 'cae-claude-gw'; App = 'ca-claude-gw'
        AppRegistration = "claude-apps-gateway-private-$suffix"; OperatorRole = $OperatorRole; ClientSecretDays = $ClientSecretDays
        RotateClientSecret = [bool]$RotateClientSecret; AllowedEmailDomain = $AllowedEmailDomain
        ClaudeOrganizationName = $ClaudeOrganizationName; ClaudeCountryCode = $ClaudeCountryCode; ClaudeIndustry = $ClaudeIndustry
        # East US 2 quota in this subscription: Opus 5 has Data Zone Standard units free, Sonnet 5 Global Standard units (ADR-0005).
        Models = @(
            @{ Name = 'claude-sonnet-5'; Version = '2'; Sku = 'GlobalStandard'; Capacity = 10 },
            @{ Name = 'claude-opus-5'; Version = '2'; Sku = 'DataZoneStandard'; Capacity = 10 }
        )
        ClaudeCodeVersion = '2.1.284'
        ClaudeCodeSha256 = '5cd90aabd83f8a15136c35aa37bb1d92b348993573316643dc3fe4e04afbf88f'
        ClaudeCodeWindowsSha256 = '0416631e846f743110da5282409776fa1313e65f33a588aae066eaf8db0fda7d'
        ImageDir = Join-Path $root 'infra\azure-test\image'
        EntraManifest = Join-Path $root 'infra\azure-test\entra-app.json'
        ConfigFile = Join-Path $root 'config\gateway.azure-private.yaml'
        ConfigTool = Join-Path $root 'scripts\admin\new-gateway-config.mjs'
        # ADR-0007: the admin file turns telemetry on; the collector release is pinned by its manifest list digest.
        Telemetry = $telemetry
        AppInsights = 'appi-claude-gw'; CollectorVersion = '0.161.0'
        CollectorDigest = 'sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1'
        CollectorConfigFile = Join-Path $root 'config\otel-collector.azure-private.json'
        # The verify step's wait for its metric in AppMetrics, which took about 2 minutes on 2026-09-30.
        TelemetryWaitMinutes = 10; TelemetryPollSeconds = 30
        MinReplicas = $MinReplicas; MaxReplicas = $MaxReplicas; ConcurrentRequests = $ConcurrentRequests; MaxUpstreamRequests = $MaxUpstreamRequests
        Cpu = $Cpu; Memory = $Memory; ZoneRedundant = [bool]$ZoneRedundant
        DevVm = 'vm-dev'; DevVmUser = 'devadmin'; DevVmSize = 'Standard_D4s_v5'; DevVmImage = 'MicrosoftWindowsDesktop:windows-11:win11-25h2-ent:latest'
        Bastion = 'bas-claude-gw'; Secrets = @{ PgPassword = $null }
    }
    $c.VnetId = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$ResourceGroup/providers/Microsoft.Network/virtualNetworks/$($c.Vnet)"
    if ($ShowDevVmPassword) {
        $saved = Read-DevVmPassword $c
        if (-not $saved) { throw "No password was saved on this machine for $($c.DevVm) in $ResourceGroup." }
        [Console]::Out.WriteLine("$($c.DevVmUser) $saved")
        return
    }
    $order = 'network', 'dns', 'foundry', 'postgres', 'registry', 'identity', 'environment', 'telemetry', 'entra', 'app', 'devvm', 'verify'
    $Step = @($Step | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $unknown = @($Step | Where-Object { $_ -ne 'all' -and $order -notcontains $_ })
    if ($unknown.Count) { throw "Unknown step $($unknown -join ', '); the steps are all, $($order -join ', ')." }
    $selected = if ($Step -contains 'all') { $order } else { $order | Where-Object { $Step -contains $_ } }
    # Later steps need names that earlier steps learn: the image, the identity, the environment's domain, the app ID,
    # the workspace, the component's connection string and the collector image, and the holders of the app's roles.
    $needs = @{ app = @('registry', 'identity', 'environment', 'telemetry', 'entra'); telemetry = @('registry', 'identity', 'environment'); entra = @('environment'); devvm = @('environment'); verify = @('environment', 'entra') }
    $quiet = @($selected | ForEach-Object { $needs[$_] } | Where-Object { $_ -and $selected -notcontains $_ } | Select-Object -Unique)
    foreach ($s in $order) {
        if ($selected -notcontains $s -and $quiet -notcontains $s) { continue }
        if ($quiet -contains $s) { Write-Host "== $s (read only, for the names later steps use)" } else { Write-Host "== $s" }
        $function = 'Step-' + (Get-Culture).TextInfo.ToTitleCase($s).Replace('Devvm', 'DevVm')
        $wasPlan = Test-AzPlan
        if ($quiet -contains $s) { Set-AzPlan $true }
        try { & $function $c } finally { Set-AzPlan $wasPlan }
    }
    if (Test-AzPlan) { Write-Host "Plan: $((Get-AzPlanned).Count) command(s) would change the subscription; nothing was changed." }
    elseif ($c.ContainsKey('Fqdn')) { Write-Host "Gateway: https://$($c.Fqdn) (private; resolves inside $($c.Vnet) only)" }
} finally {
    Clear-AzSecrets
}
