// The admin-ui Container App (ADR-0008): a second app in the gateway's own existing Container Apps environment, so
// it shares the VNet, the private DNS zone and the environment's own cost, rather than standing up a second
// environment. Reachable the same way the gateway itself is - external ingress plus an IP restriction to the VNet's
// own range, never a public address, because the environment itself has no public endpoint (ADR-0005).
//
// This template does not grant the identity's Microsoft Graph application permissions (AppRoleAssignment.ReadWrite.All,
// Application.Read.All, User.Read.All): ARM/Bicep has no resource type for an Entra application-permission grant on a
// service principal - that is a Microsoft Graph call, not an Azure Resource Manager one. Deploy-AdminUi.ps1 makes it
// after this template finishes, and documents why those three permissions specifically (admin-ui/README.md).
// ADR-0010 adds Container Apps Contributor on the gateway app (an Azure role, assigned here), optional Container Apps
// authentication, and two more Graph permissions that Deploy-AdminUi.ps1 grants.
targetScope = 'resourceGroup'

@description('The existing Container Apps environment the gateway runs in, e.g. cae-claude-gw.')
param environmentName string

@description('The existing Azure Container Registry login server, e.g. acrclaudegwd0f9ec.azurecr.io.')
param acrLoginServer string

@description('The existing Azure Container Registry name (for the AcrPull role assignment).')
param acrName string

@description('Image reference in that registry, e.g. admin-ui:2026-10-16 or admin-ui@sha256:... . Deploy-AdminUi.ps1 passes a digest reference, not a mutable tag, so a same-day rebuild actually updates the running container (a tag alone does not force Container Apps to re-pull - live-found 2026-10-16).')
param imageTag string

@description('Name for the admin-ui Container App.')
param appName string = 'ca-admin-ui'

@description('The gateway\'s own public URL, e.g. https://ca-claude-gw.politebush-4e216865.northcentralus.azurecontainerapps.io.')
param gatewayUrl string

@description('The gateway\'s Entra service principal object ID (its enterprise application), read live, never hardcoded.')
param gatewayServicePrincipalId string

@description('The Entra app manifest\'s appRoles, as JSON: [{id, value}, ...] (infra/azure-test/entra-app.json).')
param gatewayAppRolesJson string

@description('The rendered admin file\'s content (config/gateway-admin.azure-private.json) - the same file new-gateway-config.mjs renders the gateway\'s own config from.')
@secure()
param gatewayAdminFileJson string

@description('The gateway\'s own admin.write_keys value (ADR-0008) - the same secret the gateway container holds as GATEWAY_ADMIN_WRITE_KEY, read from it, not freshly generated, so both sides match.')
@secure()
param gatewayAdminWriteKey string

@description('Location; defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('CIDR this admin-ui is reachable from, matching the gateway\'s own restriction for this environment: the VNet\'s range for a network-restricted deployment (ADR-0005), or a developer\'s own tester CIDR for the ADR-0003 test topology, which has no VNet to be internal to.')
param allowedCidr string = '10.40.0.0/16'

@description('ADR-0017: no IP rule, so the console is reached from any address; it then relies on Entra sign-in with AdminUi.Admin, which Deploy-AdminUi.ps1 requires with this switch.')
param allowAnyAddress bool = false

@description('The gateway Container App admin-ui reads and writes the configuration of (ADR-0010).')
param gatewayAppName string = 'ca-claude-gw'

@description('The topology the gateway\'s configuration is rendered for, as new-gateway-config.mjs --topology.')
@allowed([ 'test', 'private' ])
param gatewayTopology string = 'private'

@description('The admin file\'s repository path, as new-gateway-config.mjs names it in the rendered gateway.yaml header.')
param gatewayAdminFilePath string = 'config/gateway-admin.azure-private.json'

@description('Turns on Container Apps authentication with Microsoft Entra ID; admin-ui then accepts changes only from users holding the AdminUi.Admin app role of signInClientId (ADR-0010, U-87).')
param enableSignIn bool = false

@description('Application (client) ID of admin-ui\'s own sign-in app registration (not the gateway\'s). Required when enableSignIn is true.')
param signInClientId string = ''

@description('ADR-0018: the gateway app\'s purpose and runId tags, which Deploy-AdminUi.ps1 reads, so an install into an existing resource group can tell the console\'s resources from the customer\'s, and teardown removes them with the gateway.')
param ownTags object = {}

@description('ADR-0016: the object ID of the gateway\'s app registration, whose sign-in certificate or client secret job-signin-renewer renews. Empty: no job.')
param gatewayApplicationObjectId string = ''

@description('ADR-0016: validity of a certificate job-signin-renewer issues, in months.')
@minValue(1)
@maxValue(24)
param signInCertificateMonths int = 12

@description('ADR-0016: lifetime of a client secret job-signin-renewer issues, in days.')
@minValue(1)
@maxValue(365)
param signInSecretDays int = 365

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }

resource gatewayApp 'Microsoft.App/containerApps@2024-03-01' existing = { name: gatewayAppName }


// A separate identity from the gateway's own (least privilege, ADR-0008): this one needs Microsoft Graph
// application permissions the gateway's identity must not also hold, since the gateway identity's blast radius is
// scoped to Foundry/PostgreSQL/the telemetry collector only.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-admin-ui'
  location: location
  tags: ownTags
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = { name: acrName }

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d') // AcrPull
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ADR-0010: reading and writing the gateway's configuration needs containerApps/read, /write and
// /listSecrets/action. Container Apps Contributor, scoped to the gateway app alone, is the built-in role with those;
// it also lets admin-ui read the gateway's other secret values, which the API never returns (ADR-0010 Consequences).
resource gatewayConfigWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(gatewayApp.id, identity.id, 'ContainerAppsContributor')
  scope: gatewayApp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '358470bc-b998-42bd-ab17-a7e34c199c0f') // Container Apps Contributor
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: ownTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      // external: true, restricted by ipSecurityRestrictions to allowedCidr - not internal-only ingress. For the
      // network-restricted deployment (ADR-0005) the environment itself has no public endpoint, so this is still
      // unreachable from the internet; it matches the gateway's own ca-claude-gw pattern (external ingress + an IP
      // allowlist) rather than Container Apps' internal-only ingress, because internal-only ingress hit a live,
      // reproducible, still-open Azure platform bug here: the internal load balancer returned 404 "This Container
      // App is stopped or does not exist" for a replica whose own readiness probes were passing the whole time
      // (live-found 2026-10-16; tracked upstream at https://github.com/microsoft/azure-container-apps/issues/1714,
      // open since 2026-05, same symptom, same confirmed workaround - flip to external + an IP restriction). For the
      // ADR-0003 test topology, which has no VNet at all, allowedCidr is the operator's own tester CIDR instead.
      // transport: http (not the 'auto' default) - matches the gateway's own ingress and is required for protocol
      // detection to work against a plain node:http server, which speaks HTTP/1.1 only (no ALPN/h2c).
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        ipSecurityRestrictions: allowAnyAddress ? [] : [
          { name: 'allowed-cidr', description: 'Matches the gateway\'s own restriction for this environment (gateway.yaml access_control.allow_cidrs)', ipAddressRange: allowedCidr, action: 'Allow' }
        ]
      }
      registries: [{ server: acrLoginServer, identity: identity.id }]
      secrets: [
        { name: 'gateway-admin-write-key', value: gatewayAdminWriteKey }
        { name: 'gateway-admin-file-json', value: gatewayAdminFileJson }
      ]
    }
    template: {
      containers: [
        {
          name: 'admin-ui'
          image: '${acrLoginServer}/${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'PORT', value: '8080' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'GATEWAY_URL', value: gatewayUrl }
            { name: 'GATEWAY_ADMIN_WRITE_KEY', secretRef: 'gateway-admin-write-key' }
            { name: 'GATEWAY_SERVICE_PRINCIPAL_ID', value: gatewayServicePrincipalId }
            { name: 'GATEWAY_APP_ROLES', value: gatewayAppRolesJson }
            { name: 'GATEWAY_ADMIN_FILE_JSON', secretRef: 'gateway-admin-file-json' }
            { name: 'GATEWAY_RESOURCE_ID', value: gatewayApp.id }
            { name: 'GATEWAY_TOPOLOGY', value: gatewayTopology }
            { name: 'GATEWAY_APPLICATION_OBJECT_ID', value: gatewayApplicationObjectId }
            { name: 'SIGNIN_CERTIFICATE_MONTHS', value: string(signInCertificateMonths) }
            { name: 'SIGNIN_SECRET_DAYS', value: string(signInSecretDays) }
            { name: 'GATEWAY_ADMIN_FILE_PATH', value: gatewayAdminFilePath }
            { name: 'ADMIN_UI_SIGN_IN', value: enableSignIn ? 'required' : 'off' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
          ]
        }
      ]
      // minReplicas: 0 - an admin dashboard is used sporadically, not continuously like the gateway itself
      // (ca-claude-gw: minReplicas 2, always warm for real developer traffic). At 0.25 vCPU/0.5Gi, minReplicas 1
      // would idle-bill roughly $6/month around the clock for a tool nobody is looking at most of the time (live
      // Azure Retail Prices, northcentralus, 2026-10-16: vCPU idle $0.000003/vCPU-s, memory idle $0.000003/GiB-s);
      // scale-to-zero trades that for a several-second cold start on the first request after idle.
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
  dependsOn: [acrPull, gatewayConfigWriter]
}

// ADR-0014: the spend pacer. A scheduled job rather than a timer in admin-ui, which scales to zero; same image and
// identity as admin-ui. It reads the admin file and the gateway's admin keys from the gateway app's secrets through
// the Container Apps Contributor role above, so no key is passed to it here. Container Apps cron is in UTC.
resource pacerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-spend-pacer'
  location: location
  tags: ownTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 120
      replicaRetryLimit: 0
      scheduleTriggerConfig: { cronExpression: '*/5 * * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrLoginServer, identity: identity.id }]
      secrets: [
        { name: 'gateway-admin-file-json', value: gatewayAdminFileJson }
      ]
    }
    template: {
      containers: [
        {
          name: 'spend-pacer'
          image: '${acrLoginServer}/${imageTag}'
          command: [ 'node', 'server/pacer-job.mjs' ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'GATEWAY_URL', value: gatewayUrl }
            { name: 'GATEWAY_RESOURCE_ID', value: gatewayApp.id }
            { name: 'GATEWAY_ADMIN_FILE_JSON', secretRef: 'gateway-admin-file-json' }
          ]
        }
      ]
    }
  }
  dependsOn: [acrPull, gatewayConfigWriter]
}

// ADR-0016 (amended 2026-11-03): renews the gateway's Entra sign-in certificate or client secret 30 days before it ends,
// daily, with admin-ui's identity (an owner of the gateway's app registration, Container Apps Contributor on the gateway).
resource renewerJob 'Microsoft.App/jobs@2024-03-01' = if (!empty(gatewayApplicationObjectId)) {
  name: 'job-signin-renewer'
  location: location
  tags: ownTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      scheduleTriggerConfig: { cronExpression: '17 3 * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrLoginServer, identity: identity.id }]
    }
    template: {
      containers: [
        {
          name: 'signin-renewer'
          image: '${acrLoginServer}/${imageTag}'
          command: [ 'node', 'server/signin-renewer.mjs' ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'GATEWAY_RESOURCE_ID', value: gatewayApp.id }
            { name: 'GATEWAY_APPLICATION_OBJECT_ID', value: gatewayApplicationObjectId }
            { name: 'SIGNIN_CERTIFICATE_MONTHS', value: string(signInCertificateMonths) }
            { name: 'SIGNIN_SECRET_DAYS', value: string(signInSecretDays) }
          ]
        }
      ]
    }
  }
  dependsOn: [acrPull, gatewayConfigWriter]
}
// Container Apps authentication (U-87): the platform signs users in and sets X-MS-CLIENT-PRINCIPAL, removing any copy
// an external caller sends. No client secret: sign-in uses ID tokens, which carry the roles claim of the app roles
// assigned to the user (https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra, "Client secret (optional)").
resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (enableSignIn) {
  parent: app
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [ '/api/health' ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: signInClientId
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
        validation: { allowedAudiences: [ signInClientId, 'api://${signInClientId}' ] }
      }
    }
  }
}

@description('The admin-ui\'s managed identity principal ID - grant it Microsoft Graph application permissions with this (Deploy-AdminUi.ps1 does it after this template finishes).')
output identityPrincipalId string = identity.properties.principalId
output fqdn string = app.properties.configuration.ingress.fqdn
