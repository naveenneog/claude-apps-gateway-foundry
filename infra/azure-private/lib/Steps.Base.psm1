# The first steps of infra/azure-private/Deploy-Gateway.ps1 (ADR-0005): network, private DNS for Foundry, the Foundry
# account with its Claude deployments behind a private endpoint, PostgreSQL with private access, the registry and image,
# and the gateway's identity with its two roles. Each step creates what is missing and reports what it found.
Set-StrictMode -Version Latest

function Step-Network($c) {
    $rg = $c.ResourceGroup
    if (Invoke-AzRead @('group', 'show', '--name', $rg)) { Write-AzFound "resource group $rg" }
    else { Invoke-AzChange @('group', 'create', '--name', $rg, '--location', $c.Location, '--tags', 'purpose=claude-apps-gateway-private') | Out-Null }
    if (Invoke-AzRead @('network', 'vnet', 'show', '-g', $rg, '-n', $c.Vnet)) { Write-AzFound "virtual network $($c.Vnet)" }
    else { Invoke-AzChange @('network', 'vnet', 'create', '-g', $rg, '-n', $c.Vnet, '--location', $c.Location, '--address-prefixes', $c.AddressSpace) | Out-Null }
    # The developer VM's outbound traffic leaves through a NAT gateway: installers, Entra sign-in and Claude Desktop's hosts.
    if (Invoke-AzRead @('network', 'nat', 'gateway', 'show', '-g', $rg, '-n', $c.NatGateway)) { Write-AzFound "NAT gateway $($c.NatGateway)" }
    else {
        Invoke-AzChange @('network', 'public-ip', 'create', '-g', $rg, '-n', "pip-$($c.NatGateway)", '--location', $c.Location, '--sku', 'Standard') | Out-Null
        Invoke-AzChange @('network', 'nat', 'gateway', 'create', '-g', $rg, '-n', $c.NatGateway, '--location', $c.Location, '--public-ip-addresses', "pip-$($c.NatGateway)") | Out-Null
    }
    $subnets = @(
        @{ Name = 'snet-aca'; Prefix = $c.Subnets.aca; Extra = @('--delegations', 'Microsoft.App/environments') },
        @{ Name = 'snet-pe'; Prefix = $c.Subnets.pe; Extra = @() },
        @{ Name = 'snet-pg'; Prefix = $c.Subnets.pg; Extra = @('--delegations', 'Microsoft.DBforPostgreSQL/flexibleServers') },
        @{ Name = 'snet-dev'; Prefix = $c.Subnets.dev; Extra = @('--nat-gateway', $c.NatGateway) }
    )
    foreach ($s in $subnets) {
        if (Invoke-AzRead @('network', 'vnet', 'subnet', 'show', '-g', $rg, '--vnet-name', $c.Vnet, '-n', $s.Name)) { Write-AzFound "subnet $($s.Name)"; continue }
        Invoke-AzChange (@('network', 'vnet', 'subnet', 'create', '-g', $rg, '--vnet-name', $c.Vnet, '-n', $s.Name, '--address-prefixes', $s.Prefix) + $s.Extra) | Out-Null
    }
}

# A private DNS zone linked to the VNet, so names in it resolve to private addresses inside the VNet only.
function Set-PrivateZone($c, [string]$Zone) {
    $rg = $c.ResourceGroup
    if (Invoke-AzRead @('network', 'private-dns', 'zone', 'show', '-g', $rg, '-n', $Zone)) { Write-AzFound "private DNS zone $Zone" }
    else { Invoke-AzChange @('network', 'private-dns', 'zone', 'create', '-g', $rg, '-n', $Zone) | Out-Null }
    if (Invoke-AzRead @('network', 'private-dns', 'link', 'vnet', 'show', '-g', $rg, '-z', $Zone, '-n', "link-$($c.Vnet)")) { Write-AzFound "VNet link of $Zone" }
    else { Invoke-AzChange @('network', 'private-dns', 'link', 'vnet', 'create', '-g', $rg, '-z', $Zone, '-n', "link-$($c.Vnet)", '-v', $c.Vnet, '-e', 'false') | Out-Null }
}

# The three endpoint families of a Foundry account, each with its own zone
# (https://learn.microsoft.com/azure/private-link/private-endpoint-dns#commercial).
$script:FoundryZones = [ordered]@{ cognitiveservices = 'privatelink.cognitiveservices.azure.com'; openai = 'privatelink.openai.azure.com'; 'services-ai' = 'privatelink.services.ai.azure.com' }

function Step-Dns($c) { foreach ($zone in $script:FoundryZones.Values) { Set-PrivateZone $c $zone } }

function Step-Foundry($c) {
    $rg = $c.ResourceGroup
    $id = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$rg/providers/Microsoft.CognitiveServices/accounts/$($c.Foundry)"
    $account = Invoke-AzRead @('cognitiveservices', 'account', 'show', '-g', $rg, '-n', $c.Foundry)
    if ($account) { Write-AzFound "Foundry account $($c.Foundry)" }
    else { Invoke-AzChange @('cognitiveservices', 'account', 'create', '-g', $rg, '-n', $c.Foundry, '--location', $c.FoundryLocation, '--kind', 'AIServices', '--sku', 'S0', '--custom-domain', $c.Foundry, '--yes') | Out-Null }
    # Only the gateway's identity calls the models: no keys, and no answer outside the private endpoint.
    if ($account -and $account.properties.publicNetworkAccess -eq 'Disabled' -and $account.properties.disableLocalAuth) { Write-AzFound 'public network access and local authentication disabled' }
    else { Invoke-AzChange @('resource', 'update', '--ids', $id, '--set', 'properties.publicNetworkAccess=Disabled', 'properties.disableLocalAuth=true') | Out-Null }
    foreach ($m in $c.Models) {
        if (Invoke-AzRead @('cognitiveservices', 'account', 'deployment', 'show', '-g', $rg, '-n', $c.Foundry, '--deployment-name', $m.Name)) { Write-AzFound "deployment $($m.Name)"; continue }
        # An Anthropic deployment carries the organization's attestation, which accepts the Azure Marketplace offer for
        # Claude (https://learn.microsoft.com/azure/developer/ai/how-to/deploy-claude-foundry#terms-of-use). The Azure CLI's
        # deployment create has no option for it, so the deployment is written through Azure Resource Manager.
        if (-not $c.ClaudeOrganizationName -and -not (Test-AzPlan)) { throw 'Creating a Claude deployment needs -ClaudeOrganizationName, the legal name of the organization that accepts the Anthropic offer.' }
        $organization = if ($c.ClaudeOrganizationName) { $c.ClaudeOrganizationName } else { '<organization name>' }
        $body = Get-AzWorkFile "deployment-$($m.Name).json"
        [IO.File]::WriteAllText($body, (ConvertTo-Json -Depth 5 -InputObject @{
            sku = @{ name = $m.Sku; capacity = $m.Capacity }
            properties = @{ model = @{ format = 'Anthropic'; name = $m.Name; version = $m.Version }
                modelProviderData = @{ organizationName = $organization; countryCode = $c.ClaudeCountryCode; industry = $c.ClaudeIndustry } }
        }))
        Invoke-AzChange @('rest', '--method', 'put', '--url', "https://management.azure.com$id/deployments/$($m.Name)?api-version=2025-10-01-preview", '--body', "@$body") | Out-Null
    }
    if (Invoke-AzRead @('network', 'private-endpoint', 'show', '-g', $rg, '-n', 'pe-foundry')) { Write-AzFound 'private endpoint pe-foundry' }
    else {
        Invoke-AzChange @('network', 'private-endpoint', 'create', '-g', $rg, '-n', 'pe-foundry', '--location', $c.Location, '--vnet-name', $c.Vnet, '--subnet', 'snet-pe',
            '--private-connection-resource-id', $id, '--group-id', 'account', '--connection-name', 'foundry') | Out-Null
    }
    $group = Invoke-AzRead @('network', 'private-endpoint', 'dns-zone-group', 'show', '-g', $rg, '--endpoint-name', 'pe-foundry', '-n', 'foundry')
    $present = if ($group) { @($group.privateDnsZoneConfigs | ForEach-Object { $_.name }) } else { @() }
    $verb = if ($group) { 'add' } else { 'create' }
    foreach ($entry in $script:FoundryZones.GetEnumerator()) {
        if ($present -contains $entry.Key) { Write-AzFound "DNS zone group entry $($entry.Key)"; continue }
        Invoke-AzChange @('network', 'private-endpoint', 'dns-zone-group', $verb, '-g', $rg, '--endpoint-name', 'pe-foundry', '-n', 'foundry',
            '--private-dns-zone', $entry.Value, '--zone-name', $entry.Key) | Out-Null
        $verb = 'add'
    }
}

function New-RandomSecret([int]$Bytes = 32) {
    $buffer = [byte[]]::new($Bytes)
    [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
    # Letters and digits plus a fixed tail, so the value meets PostgreSQL's and Windows' complexity rules.
    ([Convert]::ToBase64String($buffer) -replace '[+/=]', '') + 'Aa1!'
}

function Step-Postgres($c) {
    $rg = $c.ResourceGroup
    if (Invoke-AzRead @('postgres', 'flexible-server', 'show', '-g', $rg, '-n', $c.Postgres)) { Write-AzFound "PostgreSQL server $($c.Postgres)" }
    else {
        $c.Secrets.PgPassword = New-RandomSecret
        Invoke-AzChange @('postgres', 'flexible-server', 'create', '-g', $rg, '-n', $c.Postgres, '--location', $c.Location, '--tier', $c.PostgresTier,
            '--sku-name', $c.PostgresSku, '--version', $c.PostgresVersion, '--storage-size', '32', '--zonal-resiliency', $c.PostgresZonalResiliency,
            '--vnet', $c.Vnet, '--subnet', 'snet-pg', '--private-dns-zone', "$($c.Postgres).private.postgres.database.azure.com",
            '--admin-user', $c.PostgresUser, '--admin-password', (New-AzSecretArgument 'pg-password' $c.Secrets.PgPassword), '--yes') | Out-Null
    }
    if (Invoke-AzRead @('postgres', 'flexible-server', 'db', 'show', '-g', $rg, '-s', $c.Postgres, '-d', 'gateway')) { Write-AzFound 'database gateway' }
    else { Invoke-AzChange @('postgres', 'flexible-server', 'db', 'create', '-g', $rg, '-s', $c.Postgres, '-d', 'gateway') | Out-Null }
}

function Step-Registry($c) {
    $rg = $c.ResourceGroup
    if (Invoke-AzRead @('acr', 'show', '-g', $rg, '-n', $c.Acr)) { Write-AzFound "registry $($c.Acr)" }
    else { Invoke-AzChange @('acr', 'create', '-g', $rg, '-n', $c.Acr, '--location', $c.Location, '--sku', 'Basic', '--admin-enabled', 'false') | Out-Null }
    $tag = "claude-gateway:$($c.ClaudeCodeVersion)"
    $image = Invoke-AzRead @('acr', 'repository', 'show', '-n', $c.Acr, '--image', $tag)
    if ($image) { Write-AzFound "image $tag" }
    else {
        # The Dockerfile checks the release against its signed manifest and the pinned checksum (ADR-0003). Without --no-logs
        # the Azure CLI streams the build log, which is not JSON; with it, the CLI waits for the run and returns it.
        $build = Invoke-AzChange @('acr', 'build', '--registry', $c.Acr, '--image', $tag, '--build-arg', "CLAUDE_VERSION=$($c.ClaudeCodeVersion)",
            '--build-arg', "CLAUDE_SHA256=$($c.ClaudeCodeSha256)", '--no-logs', $c.ImageDir)
        if ($build -and $build.status -ne 'Succeeded') {
            throw "The image build $($build.runId) ended with status $($build.status); az acr task logs --registry $($c.Acr) --run-id $($build.runId) prints its log."
        }
        $image = Invoke-AzRead @('acr', 'repository', 'show', '-n', $c.Acr, '--image', $tag)
        if (-not $image -and -not (Test-AzPlan)) { throw "The image $tag is not in $($c.Acr) after the build." }
    }
    $c.Image = if ($image) { "$($c.Acr).azurecr.io/claude-gateway@$($image.digest)" } else { "$($c.Acr).azurecr.io/$tag" }
}

function Step-Identity($c) {
    $rg = $c.ResourceGroup
    $identity = Invoke-AzRead @('identity', 'show', '-g', $rg, '-n', $c.Identity)
    if ($identity) { Write-AzFound "identity $($c.Identity)" }
    else { $identity = Invoke-AzChange @('identity', 'create', '-g', $rg, '-n', $c.Identity, '--location', $c.Location) }
    $c.IdentityId = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$($c.Identity)"
    $principal = if ($identity) { $identity.principalId } else { "<principal ID of $($c.Identity)>" }
    $c.IdentityClientId = if ($identity) { $identity.clientId } else { "<client ID of $($c.Identity)>" }
    $scopes = @(
        @{ Role = 'AcrPull'; Scope = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$rg/providers/Microsoft.ContainerRegistry/registries/$($c.Acr)" },
        @{ Role = 'Cognitive Services User'; Scope = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$rg/providers/Microsoft.CognitiveServices/accounts/$($c.Foundry)" }
    )
    foreach ($a in $scopes) {
        $existing = @($(if ($identity) { Invoke-AzRead @('role', 'assignment', 'list', '--assignee', $principal, '--role', $a.Role, '--scope', $a.Scope) }) | Where-Object { $_ })
        if ($existing.Count) { Write-AzFound "$($a.Role) for $($c.Identity)"; continue }
        Invoke-AzChange @('role', 'assignment', 'create', '--assignee-object-id', $principal, '--assignee-principal-type', 'ServicePrincipal',
            '--role', $a.Role, '--scope', $a.Scope) | Out-Null
    }
}

Export-ModuleMember -Function Step-Network, Step-Dns, Set-PrivateZone, Step-Foundry, Step-Postgres, Step-Registry, Step-Identity, New-RandomSecret
