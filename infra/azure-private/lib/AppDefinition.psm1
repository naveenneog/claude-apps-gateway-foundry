# The Container App definition of the gateway for `az containerapp create|update --yaml` (ADR-0005). JSON is YAML, so
# the file is written with ConvertTo-Json. Secret values are placeholders here, __JWT__, __PG__ and __OIDC__; Step-App
# replaces them in the text it writes to a file, so no secret passes through a cmdlet.
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
                secrets = @(
                    @{ name = 'gateway-config'; value = [IO.File]::ReadAllText($c.ConfigFile) },
                    @{ name = 'oidc-client-secret'; value = '__OIDC__' },
                    @{ name = 'jwt-secret'; value = '__JWT__' },
                    @{ name = 'pg-password'; value = '__PG__' }
                )
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
                })
                volumes = @(@{ name = 'gateway-config'; storageType = 'Secret'; secrets = @(@{ secretRef = 'gateway-config'; path = 'gateway.yaml' }) })
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
