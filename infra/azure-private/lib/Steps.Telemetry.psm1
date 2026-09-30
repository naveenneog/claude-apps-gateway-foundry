# The telemetry step of infra/azure-private/Deploy-Gateway.ps1 (ADR-0007): a workspace-based Application Insights
# component with local authentication off, Monitoring Metrics Publisher on it for the gateway identity, 30-day retention
# for the workspace and each of its App* tables (ADR-0002, T-39), and the OpenTelemetry Collector image in the registry
# at its pinned digest. Test-TelemetryDelivery is the verify step's check of the path.
Set-StrictMode -Version Latest

# The tables a workspace-based Application Insights component adds, each at 90 days by default (U-30). The step lists them
# only for the plan's preview while the workspace does not exist; with a workspace it reads every table the workspace has,
# since the component adds tables over time (AppGenAIContent, measured 2026-09-30).
$script:AppTables = @('AppAvailabilityResults', 'AppBrowserTimings', 'AppDependencies', 'AppExceptions', 'AppEvents', 'AppGenAIContent', 'AppMetrics',
    'AppPageViews', 'AppPerformanceCounters', 'AppRequests', 'AppSystemEvents', 'AppTraces')
# Tables whose retention cannot go below 90 days (U-30).
$script:FixedTables = @('Usage', 'AzureActivity')

# The component, for `az resource create --is-full-object`; the core Azure CLI creates it without an extension.
function New-ComponentDefinition($c) {
    [ordered]@{
        location = $c.Location
        kind = 'other'
        properties = [ordered]@{ Application_Type = 'other'; WorkspaceResourceId = $c.WorkspaceId; IngestionMode = 'LogAnalytics'; DisableLocalAuth = $true }
    }
}

function Step-Telemetry($c) {
    if (-not $c.Telemetry) { Write-Host '  telemetry is off in config/gateway-admin.azure-private.json (deployment.telemetry)'; return }
    $rg = $c.ResourceGroup
    $provider = "/subscriptions/$($c.SubscriptionId)/resourceGroups/$rg/providers"
    # The collector release is pinned by the digest of its manifest list, as the gateway image is checked against its
    # signed manifest. A tag in the registry at another digest stops the step before it changes anything.
    $tag = "opentelemetry-collector-contrib:$($c.CollectorVersion)"
    $image = Invoke-AzRead @('acr', 'repository', 'show', '-n', $c.Acr, '--image', $tag)
    if ($image -and (Get-AzValue $image 'digest') -ne $c.CollectorDigest) {
        throw ("The image $tag in $($c.Acr) has digest $(Get-AzValue $image 'digest'), not the pinned $($c.CollectorDigest). " +
            "Remove the tag, and the step imports the pinned release: az acr repository untag -n $($c.Acr) --image $tag")
    }

    $workspace = Invoke-AzRead @('monitor', 'log-analytics', 'workspace', 'show', '-g', $rg, '-n', $c.Workspace)
    $c.WorkspaceId = if ($workspace) { $workspace.id } else { "$provider/Microsoft.OperationalInsights/workspaces/$($c.Workspace)" }
    $retention = Get-AzValue $workspace 'retentionInDays'
    $features = Get-AzValue $workspace 'features'
    if ($retention -eq 30 -and (Get-AzValue $features 'immediatePurgeDataOn30Days') -eq $true -and (Get-AzValue $features 'enableLogAccessUsingOnlyResourcePermissions') -eq $false) {
        Write-AzFound "workspace $($c.Workspace): retention $retention days, purge at 30 days, workspace permissions required"
    } else {
        Invoke-AzChange @('resource', 'update', '--ids', $c.WorkspaceId, '--set', 'properties.retentionInDays=30', 'properties.features.immediatePurgeDataOn30Days=true',
            'properties.features.enableLogAccessUsingOnlyResourcePermissions=false') | Out-Null
    }

    $componentId = "$provider/Microsoft.Insights/components/$($c.AppInsights)"
    $component = Invoke-AzRead @('resource', 'show', '--ids', $componentId)
    if ($component) {
        $properties = Get-AzValue $component 'properties'
        $linked = Get-AzValue $properties 'WorkspaceResourceId'
        if ($linked -and $workspace -and $linked -ne $c.WorkspaceId) { throw "Application Insights $($c.AppInsights) sends to $linked, not to $($c.WorkspaceId); move it or remove it first." }
        if ((Get-AzValue $properties 'DisableLocalAuth') -eq $true) { Write-AzFound "Application Insights $($c.AppInsights) with local authentication off" }
        else { Invoke-AzChange @('resource', 'update', '--ids', $component.id, '--set', 'properties.DisableLocalAuth=true') | Out-Null }
        $componentId = $component.id
    } else {
        $file = Get-AzWorkFile 'appinsights.json'
        [IO.File]::WriteAllText($file, (ConvertTo-Json -Depth 10 -InputObject (New-ComponentDefinition $c)))
        $component = Invoke-AzChange @('resource', 'create', '-g', $rg, '-n', $c.AppInsights, '--resource-type', 'Microsoft.Insights/components',
            '--api-version', '2020-02-02', '--is-full-object', '--properties', "@$file")
    }
    $c.AppInsightsConnection = Get-AzValue (Get-AzValue $component 'properties') 'ConnectionString'
    if (-not $c.AppInsightsConnection) { $c.AppInsightsConnection = '<connection string of the component>' }

    $role = 'Monitoring Metrics Publisher'
    $assigned = @($(if ($c.IdentityPrincipalId -notlike '<*') { Invoke-AzRead @('role', 'assignment', 'list', '--assignee', $c.IdentityPrincipalId, '--role', $role, '--scope', $componentId) }) | Where-Object { $_ })
    if ($assigned.Count) { Write-AzFound "$role for $($c.Identity)" }
    else {
        Invoke-AzChange @('role', 'assignment', 'create', '--assignee-object-id', $c.IdentityPrincipalId, '--assignee-principal-type', 'ServicePrincipal',
            '--role', $role, '--scope', $componentId) | Out-Null
    }

    $tables = if ($workspace) { @(Invoke-AzRead @('monitor', 'log-analytics', 'workspace', 'table', 'list', '-g', $rg, '--workspace-name', $c.Workspace) | Where-Object { $_ }) }
    else { @($script:AppTables | ForEach-Object { [pscustomobject]@{ name = $_; retentionInDays = 90; totalRetentionInDays = 90 } }) }
    $kept = 0
    foreach ($table in $tables) {
        if ($script:FixedTables -contains $table.name) { continue }
        $days = Get-AzValue $table 'retentionInDays'
        $total = Get-AzValue $table 'totalRetentionInDays'
        if ($null -ne $days -and $null -ne $total -and $days -le 30 -and $total -le 30) { $kept++; continue }
        Invoke-AzChange @('monitor', 'log-analytics', 'workspace', 'table', 'update', '-g', $rg, '--workspace-name', $c.Workspace, '-n', $table.name,
            '--retention-time', '30', '--total-retention-time', '30') | Out-Null
    }
    if ($kept) { Write-AzFound "$kept table(s) at 30 days or less; Usage and AzureActivity keep their 90-day minimum" }

    # The app references the image by the pinned digest; while the image is not in the registry the reference is a
    # placeholder, which the app step refuses to deploy.
    $reference = "$($c.Acr).azurecr.io/opentelemetry-collector-contrib@$($c.CollectorDigest)"
    $inRegistry = [bool]$image
    if ($inRegistry) { Write-AzFound "image $tag at the pinned digest" }
    else {
        Invoke-AzChange @('acr', 'import', '-n', $c.Acr, '--source', "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@$($c.CollectorDigest)",
            '--image', $tag) | Out-Null
        if (-not (Test-AzPlan)) {
            $digest = Get-AzValue (Invoke-AzRead @('acr', 'repository', 'show', '-n', $c.Acr, '--image', $tag)) 'digest'
            if ($digest -ne $c.CollectorDigest) { throw "After the import, the image $tag in $($c.Acr) has digest $(if ($digest) { $digest } else { 'none' }), not the pinned $($c.CollectorDigest)." }
            $inRegistry = $true
        }
    }
    $c.CollectorImage = if ($inRegistry) { $reference } else { "<$reference, after its import>" }
}

# T-78 and T-32: from inside the gateway container, posts a metric with user.email, model and type, a log record and a
# trace record to the collector on the shared loopback, then waits up to $c.TelemetryWaitMinutes for the metric in
# AppMetrics. Each record travels base64-encoded, so no shell parses it on the way.
function Test-TelemetryDelivery($c) {
    $rg = $c.ResourceGroup
    $name = "cgw_verify_$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000
    $resource = @{ attributes = @(@{ key = 'service.name'; value = @{ stringValue = 'cgw-verify' } }) }
    $scope = @{ name = 'cgw-verify' }
    $attributes = @(foreach ($pair in @(@('user.email', 'verify@contoso.example'), @('model', 'claude-sonnet-5'), @('type', 'input'))) { @{ key = $pair[0]; value = @{ stringValue = $pair[1] } } })
    $bodies = [ordered]@{
        metrics = @{ resourceMetrics = @(@{ resource = $resource; scopeMetrics = @(@{ scope = $scope; metrics = @(@{ name = $name; sum = @{ aggregationTemporality = 1; isMonotonic = $true
            dataPoints = @(@{ asInt = '1'; startTimeUnixNano = "$($now - 60000000000)"; timeUnixNano = "$now"; attributes = $attributes }) } }) }) }) }
        logs = @{ resourceLogs = @(@{ resource = $resource; scopeLogs = @(@{ scope = $scope; logRecords = @(@{ timeUnixNano = "$now"; body = @{ stringValue = 'cgw-verify' } }) }) }) }
        traces = @{ resourceSpans = @(@{ resource = $resource; scopeSpans = @(@{ scope = $scope; spans = @(@{ traceId = [Guid]::NewGuid().ToString('N'); spanId = [Guid]::NewGuid().ToString('N').Substring(0, 16)
            name = 'cgw-verify'; kind = 1; startTimeUnixNano = "$now"; endTimeUnixNano = "$now" }) }) }) }
    }
    $base64 = { param([string]$Text) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)) }
    # One session per record: the exec endpoint refuses a long command (a 2,500-character command got 404 at the WebSocket
    # handshake on 2026-09-30), and a command that ends before the session attaches is reported as a container that is not
    # running, so each command waits a second first, and a session that returns no status is tried again.
    $posted = @{ metrics = 0; logs = 0; traces = 0 }
    $notes = @{}
    foreach ($signal in $bodies.Keys) {
        $body = & $base64 (ConvertTo-Json -Depth 20 -Compress -InputObject $bodies[$signal])
        $command = "bash -c `"sleep 1; echo $body | base64 -d | curl -s -o /dev/null -w '$signal %{http_code}' -H 'Content-Type: application/json' --data-binary @- http://localhost:4318/v1/$signal`""
        for ($try = 1; $try -le 3 -and -not $posted[$signal]; $try++) {
            $session = Invoke-AzSession @('containerapp', 'exec', '-g', $rg, '-n', $c.App, '--container', 'gateway', '--command', $command)
            $m = [regex]::Match($session.Out, "$signal (\d{3})")
            if ($m.Success) { $posted[$signal] = [int]$m.Groups[1].Value }
        }
        if (-not $posted[$signal]) {
            # The exec proxy prints its errors on standard output and the Azure CLI its own on standard error, each as "ERROR: ...".
            $lines = @("$($session.Err)`n$($session.Out)" -split '\r?\n' | ForEach-Object Trim | Where-Object { $_ })
            $reason = @($lines | Where-Object { $_ -like 'ERROR*' }) + $lines + 'no output' | Select-Object -First 1
            $notes[$signal] = "no HTTP response (exec exit $($session.Code): $reason)"
        }
    }

    $properties = $null
    if ($posted.metrics -eq 200) {
        $workspace = Invoke-AzRead @('monitor', 'log-analytics', 'workspace', 'show', '-g', $rg, '-n', $c.Workspace)
        $query = Get-AzWorkFile 'telemetry-query.json'
        [IO.File]::WriteAllText($query, (ConvertTo-Json -Compress -InputObject @{ query = "AppMetrics | where TimeGenerated > ago(1h) and Name == '$name' | take 1 | project Properties" }))
        Write-Host "  waiting up to $($c.TelemetryWaitMinutes) minutes for $name in AppMetrics of $($c.Workspace)"
        $deadline = [DateTime]::UtcNow.AddMinutes($c.TelemetryWaitMinutes)
        do {
            $answer = Invoke-AzRead @('rest', '--method', 'post', '--url', "https://api.loganalytics.io/v1/workspaces/$($workspace.customerId)/query",
                '--resource', 'https://api.loganalytics.io', '--body', "@$query")
            $row = @($answer.tables[0].rows) | Select-Object -First 1
            if ($row) { $properties = $row[0] | ConvertFrom-Json; break }
            if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Seconds $c.TelemetryPollSeconds }
        } while ([DateTime]::UtcNow -lt $deadline)
    }
    $component = Invoke-AzRead @('resource', 'show', '-g', $rg, '-n', $c.AppInsights, '--resource-type', 'Microsoft.Insights/components')
    $observed = @{ Posted = $posted; Notes = $notes; Properties = $properties; WaitMinutes = $c.TelemetryWaitMinutes
        LocalAuthDisabled = ((Get-AzValue (Get-AzValue $component 'properties') 'DisableLocalAuth') -eq $true); OtherRoleHolders = (Get-OtherRoleHolders $c) }
    $checks = Get-TelemetryChecks $observed
    foreach ($k in $checks.Keys) { Write-Host ('  {0}  {1}' -f $(if ($checks[$k]) { 'PASS' } else { 'FAIL' }), $k) }
    Write-Host "  metric: $name"
    if (@($checks.Values | Where-Object { -not $_ }).Count) { throw 'a telemetry check failed' }
}

# The verdicts of Test-TelemetryDelivery from what it observed: the collector's HTTP status for each signal (Posted, 0 for
# no answer) and a note for each signal without one (Notes), the Properties of the metric's row in AppMetrics ($null when it
# did not arrive), the component's DisableLocalAuth (LocalAuthDisabled), the holders of the app registration's roles other
# than the operator (OtherRoleHolders, $null when they were not read), and the minutes the step waited (WaitMinutes).
function Get-TelemetryChecks($Observed) {
    $answer = { param($signal) if ($Observed.Posted[$signal]) { "HTTP $($Observed.Posted[$signal])" } else { $Observed.Notes[$signal] } }
    $p = $Observed.Properties
    $others = $Observed.OtherRoleHolders
    $holders = if ($null -eq $others) { 'not read' } elseif (@($others).Count) { @($others) -join '; ' } else { 'none' }
    [ordered]@{
        "the collector accepts a metric: $(& $answer 'metrics') (T-78)" = ($Observed.Posted.metrics -eq 200)
        # The collector answers 404 on the path of a signal it has no pipeline for (measured 2026-09-30); another answer,
        # another refusal included, does not show that the pipeline is absent.
        "the collector has no pipeline for logs or traces: $(& $answer 'logs') and $(& $answer 'traces') (T-32)" = ($Observed.Posted.logs -eq 404 -and $Observed.Posted.traces -eq 404)
        "the metric reaches AppMetrics within $($Observed.WaitMinutes) minutes (T-78)" = ($null -ne $p)
        'the metric keeps its user.email, model and type (T-78, U-70)' = ((Get-AzValue $p 'user.email') -eq 'verify@contoso.example' -and
            (Get-AzValue $p 'model') -eq 'claude-sonnet-5' -and (Get-AzValue $p 'type') -eq 'input')
        'the component''s local authentication is off (T-78, U-69)' = ($Observed.LocalAuthDisabled -eq $true)
        "role holders other than the operator: $holders (ADR-0007)" = ($null -ne $others -and $others.Count -eq 0)
    }
}

Export-ModuleMember -Function Step-Telemetry, New-ComponentDefinition, Test-TelemetryDelivery, Get-TelemetryChecks
