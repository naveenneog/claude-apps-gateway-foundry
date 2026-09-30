# The Container App definition of the gateway for `az containerapp create|update --yaml` (ADR-0005). JSON is YAML, so
# the file is written with ConvertTo-Json. Secret values are placeholders here, __JWT__, __PG__, __OIDC__ and
# __APPINSIGHTS__; Step-App replaces them in the text it writes to a file, so no secret passes through a cmdlet. With
# telemetry on, an OpenTelemetry Collector sidecar shares the gateway's loopback (ADR-0007).
Set-StrictMode -Version Latest

function New-AppDefinition($c) {
    $secretEnv = @(
        @{ name = 'OIDC_CLIENT_SECRET'; secretRef = 'oidc-client-secret' },
        @{ name = 'GATEWAY_JWT_SECRET'; secretRef = 'jwt-secret' },
        @{ name = 'GATEWAY_PG_PASSWORD'; secretRef = 'pg-password' }
    )
    $plainEnv = [ordered]@{
        CLAUDE_GATEWAY_LOG_LEVEL = 'info'
        # DefaultAzureCredential picks the user-assigned identity by its client ID (U-11).
        AZURE_CLIENT_ID = $c.IdentityClientId
        GATEWAY_PUBLIC_URL = "https://$($c.Fqdn)"
        OIDC_ISSUER = "https://login.microsoftonline.com/$($c.TenantId)/v2.0"
        OIDC_CLIENT_ID = $c.AppId
        ALLOWED_EMAIL_DOMAIN = $c.AllowedEmailDomain
        GATEWAY_PG_USER = $c.PostgresUser
        GATEWAY_PG_HOST = "$($c.Postgres).postgres.database.azure.com"
        FOUNDRY_RESOURCE = $c.Foundry
        # Requests one replica sends upstream at once; a streaming response holds its slot until it ends
        # (https://code.claude.com/docs/en/claude-apps-gateway-deploy#concurrent-upstream-requests).
        BUN_CONFIG_MAX_HTTP_REQUESTS = "$($c.MaxUpstreamRequests)"
        # Streams in flight get two minutes to finish when a replica stops; the grace period below is longer
        # (https://code.claude.com/docs/en/claude-apps-gateway-deploy#upgrades).
        CLAUDE_GATEWAY_DRAIN_TIMEOUT_MS = '120000'
        # The configuration is a secret, which reaches no running revision when it changes; its hash here makes a
        # configuration change deploy a new revision. It is the file's SHA-256, not the hash the config.load event logs.
        GATEWAY_CONFIG_SHA256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($c.ConfigFile))).ToLowerInvariant()
    }
    $env = @($plainEnv.GetEnumerator() | ForEach-Object { @{ name = $_.Key; value = [string]$_.Value } }) + $secretEnv
    $secrets = @(
        @{ name = 'gateway-config'; value = [IO.File]::ReadAllText($c.ConfigFile) },
        @{ name = 'oidc-client-secret'; value = '__OIDC__' },
        @{ name = 'jwt-secret'; value = '__JWT__' },
        @{ name = 'pg-password'; value = '__PG__' }
    )
    $volumes = @(@{ name = 'gateway-config'; storageType = 'Secret'; secrets = @(@{ secretRef = 'gateway-config'; path = 'gateway.yaml' }) })
    $sidecars = @()
    if ($c.Telemetry) {
        # ADR-0007: the gateway sends client metrics to the collector on the shared loopback, which it refuses without this.
        $env += @{ name = 'CLAUDE_GATEWAY_ALLOW_LOOPBACK'; value = '1' }
        $collectorConfig = [IO.File]::ReadAllText($c.CollectorConfigFile)
        # The connection string is replaced like the other placeholders, so the definition printed by -Plan holds none.
        $secrets += @(@{ name = 'otel-config'; value = $collectorConfig }, @{ name = 'appinsights-connection'; value = '__APPINSIGHTS__' })
        $volumes += @{ name = 'otel-config'; storageType = 'Secret'; secrets = @(@{ secretRef = 'otel-config'; path = 'config.yaml' }) }
        $sidecars += [ordered]@{
            name = 'otel-collector'
            image = $c.CollectorImage
            args = @('--config=/etc/otelcol/config.yaml')
            resources = @{ cpu = 0.25; memory = '0.5Gi' }
            env = @(
                @{ name = 'AZURE_CLIENT_ID'; value = $c.IdentityClientId },
                @{ name = 'APPLICATIONINSIGHTS_CONNECTION_STRING'; secretRef = 'appinsights-connection' },
                # As for the gateway's configuration: a changed secret reaches no running revision, a changed hash does.
                @{ name = 'OTEL_CONFIG_SHA256'; value = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($c.CollectorConfigFile))).ToLowerInvariant() }
            )
            volumeMounts = @(@{ volumeName = 'otel-config'; mountPath = '/etc/otelcol' })
        }
    }
    $probe = {
        param($type, $path, $extra)
        $p = [ordered]@{ type = $type; httpGet = @{ path = $path; port = 8080 }; periodSeconds = 10; timeoutSeconds = 3; failureThreshold = 3 }
        foreach ($k in $extra.Keys) { $p[$k] = $extra[$k] }
        $p
    }
    [ordered]@{
        location = $c.Location
        identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $c.IdentityId = @{} } }
        properties = [ordered]@{
            environmentId = $c.EnvironmentId
            workloadProfileName = 'Consumption'
            configuration = [ordered]@{
                activeRevisionsMode = 'Single'
                # In an internal environment, external ingress is reachable from the VNet only.
                ingress = [ordered]@{ external = $true; targetPort = 8080; transport = 'http'; allowInsecure = $false }
                registries = @(@{ server = "$($c.Acr).azurecr.io"; identity = $c.IdentityId })
                secrets = $secrets
            }
            template = [ordered]@{
                terminationGracePeriodSeconds = 130
                containers = @([ordered]@{
                    name = 'gateway'
                    image = $c.Image
                    # The image's own entry point waits for a PostgreSQL sidecar (ADR-0003); this deployment has none.
                    command = @('/usr/local/bin/claude')
                    args = @('gateway', '--config', '/etc/claude/gateway.yaml')
                    resources = @{ cpu = [double]$c.Cpu; memory = $c.Memory }
                    env = $env
                    probes = @(
                        (& $probe 'Startup' '/healthz' @{ initialDelaySeconds = 5; failureThreshold = 30 }),
                        (& $probe 'Liveness' '/healthz' @{ periodSeconds = 15 }),
                        (& $probe 'Readiness' '/readyz' @{})
                    )
                    volumeMounts = @(@{ volumeName = 'gateway-config'; mountPath = '/etc/claude' })
                }) + $sidecars
                volumes = $volumes
                scale = [ordered]@{
                    minReplicas = $c.MinReplicas
                    maxReplicas = $c.MaxReplicas
                    # Scale out before a replica's upstream slots fill: a replica at its limit queues requests (P-28).
                    rules = @(@{ name = 'http-concurrency'; http = @{ metadata = @{ concurrentRequests = "$($c.ConcurrentRequests)" } } })
                }
            }
        }
    }
}

Export-ModuleMember -Function New-AppDefinition
