# The gateway steps of infra/azure-private/Deploy-Gateway.ps1 (ADR-0005): the internal Container Apps environment and
# the private DNS zone of its default domain, the Entra app registration, and the gateway Container App.
Set-StrictMode -Version Latest

function Step-Environment($c) {
    $rg = $c.ResourceGroup
    $workspace = Invoke-AzRead @('monitor', 'log-analytics', 'workspace', 'show', '-g', $rg, '-n', $c.Workspace)
    if ($workspace) { Write-AzFound "Log Analytics workspace $($c.Workspace)" }
    else { $workspace = Invoke-AzChange @('monitor', 'log-analytics', 'workspace', 'create', '-g', $rg, '-n', $c.Workspace, '--location', $c.Location, '--retention-time', '30') }
    $environment = Invoke-AzRead @('containerapp', 'env', 'show', '-g', $rg, '-n', $c.Environment)
    if ($environment) { Write-AzFound "Container Apps environment $($c.Environment)" }
    else {
        $key = if ($workspace) { New-AzSecretArgument 'workspace-key' (Invoke-AzSecretRead @('monitor', 'log-analytics', 'workspace', 'get-shared-keys', '-g', $rg, '-n', $c.Workspace, '--query', 'primarySharedKey')) } else { '@<workspace key file>' }
        $customer = if ($workspace) { $workspace.customerId } else { '<workspace customer ID>' }
        # Internal: the environment's only address is a static IP in the subnet, with no public endpoint.
        $arguments = @('containerapp', 'env', 'create', '-g', $rg, '-n', $c.Environment, '--location', $c.Location, '--enable-workload-profiles', 'true',
            '--infrastructure-subnet-resource-id', "$($c.VnetId)/subnets/snet-aca", '--internal-only', 'true',
            '--logs-destination', 'log-analytics', '--logs-workspace-id', $customer, '--logs-workspace-key', $key)
        if ($c.ZoneRedundant) { $arguments += '--zone-redundant' }
        $environment = Invoke-AzChange $arguments
    }
    $c.EnvironmentId = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$rg/providers/Microsoft.App/managedEnvironments/$($c.Environment)"
    $c.DefaultDomain = if ($environment) { $environment.properties.defaultDomain } else { '<default domain>' }
    $c.StaticIp = if ($environment) { $environment.properties.staticIp } else { '<static IP>' }
    $c.Fqdn = "$($c.App).$($c.DefaultDomain)"
    # The platform's pattern: a zone named after the default domain, with a wildcard record for the static IP
    # (https://learn.microsoft.com/azure/container-apps/vnet-custom#deploy-with-a-private-dns).
    if (-not $environment) {
        Invoke-AzChange @('network', 'private-dns', 'zone', 'create', '-g', $rg, '-n', $c.DefaultDomain) | Out-Null
        Invoke-AzChange @('network', 'private-dns', 'link', 'vnet', 'create', '-g', $rg, '-z', $c.DefaultDomain, '-n', "link-$($c.Vnet)", '-v', $c.Vnet, '-e', 'false') | Out-Null
        Invoke-AzChange @('network', 'private-dns', 'record-set', 'a', 'add-record', '-g', $rg, '-z', $c.DefaultDomain, '-n', '*', '-a', $c.StaticIp) | Out-Null
        return
    }
    Set-PrivateZone $c $c.DefaultDomain
    $record = Invoke-AzRead @('network', 'private-dns', 'record-set', 'a', 'show', '-g', $rg, '-z', $c.DefaultDomain, '-n', '*')
    if ($record -and @($record.aRecords | ForEach-Object { $_.ipv4Address }) -contains $c.StaticIp) { Write-AzFound "record * -> $($c.StaticIp)" }
    else { Invoke-AzChange @('network', 'private-dns', 'record-set', 'a', 'add-record', '-g', $rg, '-z', $c.DefaultDomain, '-n', '*', '-a', $c.StaticIp) | Out-Null }
}

# The app registration: redirect URI on the gateway's host, app roles, the email claim and v2 tokens
# (https://code.claude.com/docs/en/claude-apps-gateway-deploy#identity-provider-setup); the operator holds one role.
function Step-Entra($c) {
    $manifest = [IO.File]::ReadAllText($c.EntraManifest) | ConvertFrom-Json -Depth 20
    $redirect = "https://$($c.Fqdn)/oauth/callback"
    $app = @(Invoke-AzRead @('ad', 'app', 'list', '--display-name', $c.AppRegistration)) | Where-Object { $_ -and $_.displayName -eq $c.AppRegistration } | Select-Object -First 1
    if ($app) {
        Write-AzFound "app registration $($c.AppRegistration) ($($app.appId))"
        if (@($app.web.redirectUris) -notcontains $redirect) { Invoke-AzChange @('ad', 'app', 'update', '--id', $app.appId, '--web-redirect-uris', $redirect) | Out-Null }
    } else {
        $files = @{}
        foreach ($part in @(@('app-roles.json', $manifest.appRoles), @('optional-claims.json', $manifest.optionalClaims), @('graph-access.json', $manifest.requiredResourceAccess))) {
            $files[$part[0]] = Get-AzWorkFile $part[0]
            [IO.File]::WriteAllText($files[$part[0]], (ConvertTo-Json -InputObject $part[1] -Depth 20))
        }
        $app = Invoke-AzChange @('ad', 'app', 'create', '--display-name', $c.AppRegistration, '--sign-in-audience', 'AzureADMyOrg', '--web-redirect-uris', $redirect,
            '--app-roles', "@$($files['app-roles.json'])", '--optional-claims', "@$($files['optional-claims.json'])", '--required-resource-accesses', "@$($files['graph-access.json'])")
    }
    $c.AppId = if ($app) { $app.appId } else { "<application ID of $($c.AppRegistration)>" }
    if (-not $app -or $app.api.requestedAccessTokenVersion -ne 2) { Invoke-AzChange @('ad', 'app', 'update', '--id', $c.AppId, '--set', 'api.requestedAccessTokenVersion=2') | Out-Null }
    $sp = if ($app) { Invoke-AzRead @('ad', 'sp', 'show', '--id', $c.AppId) } else { $null }
    if ($sp) { Write-AzFound "service principal $($sp.id)" } else { $sp = Invoke-AzChange @('ad', 'sp', 'create', '--id', $c.AppId) }
    $spId = if ($sp) { $sp.id } else { '<service principal ID>' }
    $me = Invoke-AzRead @('ad', 'signed-in-user', 'show')
    $roleId = ($manifest.appRoles | Where-Object { $_.value -eq $c.OperatorRole }).id
    $assigned = @($(if ($sp) { (Invoke-AzRead @('rest', '--method', 'GET', '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo")).value }) | Where-Object { $_ })
    if (@($assigned | Where-Object { $_.principalId -eq $me.id -and $_.appRoleId -eq $roleId }).Count) { Write-AzFound "$($c.OperatorRole) for $($me.userPrincipalName)"; return }
    $body = Get-AzWorkFile 'role-assignment.json'
    [IO.File]::WriteAllText($body, (ConvertTo-Json @{ principalId = $me.id; resourceId = $spId; appRoleId = $roleId }))
    # A new service principal can take seconds to reach every Graph replica.
    for ($try = 1; ; $try++) {
        try { Invoke-AzChange @('rest', '--method', 'POST', '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo", '--body', "@$body", '--headers', 'Content-Type=application/json') | Out-Null; break }
        catch { if ($try -ge 6) { throw }; Start-Sleep -Seconds 10 }
    }
}

# The value of a Container App secret, or $null when the app or the secret does not exist.
function Get-AppSecret($c, [string]$Name) {
    try { Invoke-AzSecretRead @('containerapp', 'secret', 'show', '-g', $c.ResourceGroup, '-n', $c.App, '--secret-name', $Name, '--query', 'value') } catch { $null }
}

function Step-App($c) {
    $rg = $c.ResourceGroup
    if (-not (Test-AzPlan)) {
        # A name an earlier step could not learn is a placeholder such as <default domain>; deploying with it would fail later.
        $missing = @('Image', 'IdentityClientId', 'AppId', 'DefaultDomain') | Where-Object { [string]$c[$_] -like '<*' }
        if ($missing) { throw "The app step needs $($missing -join ', ') from earlier steps; run: pwsh -File infra/azure-private/Deploy-Gateway.ps1 -Step all" }
    }
    # The configuration deployed is the checked-in rendering of the admin file, and must be current.
    & node $c.ConfigTool --topology private --check | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'config/gateway.azure-private.yaml is not the rendering of its admin file; run node scripts/admin/new-gateway-config.mjs --topology private' }
    $existing = Invoke-AzRead @('containerapp', 'show', '-g', $rg, '-n', $c.App)
    $secret = @{ jwt = '__JWT__'; pg = '__PG__'; oidc = '__OIDC__' }
    # A secret whose value this run sets reaches an existing app only when its revision restarts (manage-secrets).
    $secretsChanged = [bool]($existing -and (Test-AzPlan) -and $c.RotateClientSecret)
    if (-not (Test-AzPlan)) {
        $jwt = if ($existing) { Get-AppSecret $c 'jwt-secret' }; if (-not $jwt) { $jwt = New-RandomSecret 48; $secretsChanged = [bool]$existing }
        $pg = if ($c.Secrets.PgPassword) { $c.Secrets.PgPassword } elseif ($existing) { Get-AppSecret $c 'pg-password' } else { $null }
        if (-not $pg) {
            # The server exists but its password is not known here: set a new one.
            $pg = New-RandomSecret
            Invoke-AzChange @('postgres', 'flexible-server', 'update', '-g', $rg, '-n', $c.Postgres, '--admin-password', (New-AzSecretArgument 'pg-password' $pg)) | Out-Null
            $secretsChanged = [bool]$existing
        }
        $oidc = if ($existing -and -not $c.RotateClientSecret) { Get-AppSecret $c 'oidc-client-secret' } else { $null }
        if (-not $oidc) {
            $end = [DateTime]::UtcNow.AddDays($c.ClientSecretDays).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $oidc = Invoke-AzChange @('ad', 'app', 'credential', 'reset', '--id', $c.AppId, '--append', '--display-name', "gateway $([DateTime]::UtcNow.ToString('yyyy-MM-dd'))", '--end-date', $end, '--query', 'password') -Secret
            $secretsChanged = [bool]$existing
        }
    }
    $definition = New-AppDefinition $c
    $json = ConvertTo-Json -InputObject $definition -Depth 20
    $file = Get-AzWorkFile 'containerapp.json'
    if (-not (Test-AzPlan)) { $json = $json.Replace('__JWT__', $jwt).Replace('__PG__', $pg).Replace('__OIDC__', $oidc) }
    [IO.File]::WriteAllText($file, $json)
    $verb = if ($existing) { 'update' } else { 'create' }
    Invoke-AzChange @('containerapp', $verb, '-g', $rg, '-n', $c.App, '--yaml', $file) | Out-Null
    if ($secretsChanged) {
        $latest = if (Test-AzPlan) { '<latest revision>' } else { (Invoke-AzRead @('containerapp', 'show', '-g', $rg, '-n', $c.App)).properties.latestRevisionName }
        Invoke-AzChange @('containerapp', 'revision', 'restart', '-g', $rg, '-n', $c.App, '--revision', $latest) | Out-Null
    }
    if (Test-AzPlan) { return }
    Wait-AppReady $c
}

function Wait-AppReady($c) {
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    while ($true) {
        $app = Invoke-AzRead @('containerapp', 'show', '-g', $c.ResourceGroup, '-n', $c.App)
        $latest = $app.properties.latestRevisionName
        if ($latest -and $latest -eq $app.properties.latestReadyRevisionName) { Write-Host "  READY revision $latest at https://$($app.properties.configuration.ingress.fqdn)"; return }
        if ([DateTime]::UtcNow -gt $deadline) { throw "revision $latest was not ready within 15 minutes; read its log with: az containerapp logs show -g $($c.ResourceGroup) -n $($c.App) --type system" }
        Start-Sleep -Seconds 15
    }
}

Export-ModuleMember -Function Step-Environment, Step-Entra, Step-App, Wait-AppReady
