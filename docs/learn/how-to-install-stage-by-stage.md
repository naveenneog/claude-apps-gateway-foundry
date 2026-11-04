---
title: Install the Claude apps gateway, stage by stage
description: Run infra/azure-test/Install-ClaudeGateway.ps1's seven stages, the Azure portal or Cloud Shell steps that do any one of them by hand when the script stops, and how the installer picks up after a manual step.
author: naveenneog
ms.date: 10/21/2026
ms.topic: how-to
---

# Install the Claude apps gateway, stage by stage

This article installs the Claude apps gateway into one Azure resource group for evaluation. The result is a gateway
on Azure Container Apps that accepts connections only from one public address range, signs developers in with
Microsoft Entra ID, serves Claude models from an existing Microsoft Foundry account, enforces spend caps, and,
optionally, the admin console (ADR-0003, docs/adr/0003-azure-test-deployment-with-restricted-ingress.md:1). The
reader is an Azure administrator; the one step that needs a directory role, the admin console's Microsoft Graph
grant, is marked in [Prerequisites](#prerequisites). A gateway with no public endpoint is the subject of the
[network-restricted tutorial](tutorial-deploy-network-restricted.md). Terms are defined in the
[glossary](glossary.md).

`infra/azure-test/Install-ClaudeGateway.ps1` (ADR-0009) runs seven stages in a fixed order, `config`, `base`, `entra`,
`image`, `app`, `budgets`, `admin-ui` (infra/azure-test/Install-ClaudeGateway.ps1:129), and stops at the first one
that fails, naming its section of this article (infra/azure-test/Install-ClaudeGateway.ps1:209-222). `config`
touches no Azure resource, so an admin file with a mistake stops the install before anything is created. `admin-ui`
runs last because its final step, the Microsoft Graph permission grant, needs a directory role that this project's installs
activated through Privileged Identity Management for the grant (docs/UNKNOWNS.md, U-75); a refusal there leaves every other stage done.
Each section below gives the stage's own command, the Azure portal or Cloud Shell steps that do the same thing by
hand, and what the installer does with that manual result when it runs again. A first install from start to finish,
with the tools, the expected output of each step and developer onboarding with Intune, is
[Tutorial: install the gateway and onboard developers](tutorial-first-install.md).

The `base`, `entra`, `image` and `app` stages build the single-tenant test topology of ADR-0003. A deployment whose
Foundry account is in another Entra tenant, such as the Contoso gateway (docs/UNKNOWNS.md, U-80), holds a credential
added by hand, and the `app` stage stops rather than delete it (infra/azure-test/lib/credentials.mjs:39-44); against such a
deployment only `budgets` and `admin-ui` apply.

## Prerequisites

| Task | Needs |
|---|---|
| Every stage | PowerShell 7, Node.js 22 or later, this repository, and the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) signed in to the tenant and subscription of the deployment: `az login`, then `az account set --subscription "<name or ID>"`; `az account show` names the subscription the stages use |
| `base`, `app` | Owner on the subscription: `base` grants the gateway's identity a role on the Foundry account, which may be in another resource group (infra/azure-test/gateway-test.json:107-143) |
| `entra` | An account that may register applications in the tenant (docs/UNKNOWNS.md, U-1) |
| `budgets` | The gateway deployed with `deployment.adminApi: true`; the `app` stage creates the key it reads (infra/azure-test/lib/credentials.mjs:46-48) |
| `admin-ui`'s Graph grant | Privileged Role Administrator, or Global Administrator: Microsoft names Privileged Role Administrator for granting Microsoft Graph permissions to a managed identity ([grant API permissions to managed identities](https://learn.microsoft.com/en-us/powershell/entra-powershell/grant-api-permissions-managed-identity)) |

## The admin file

The **admin file** is a JSON file in `config/` that lists the gateway's admitted roles, its models, which models each
role may use, and spend caps; the scripts render it into `gateway.yaml`, the configuration the gateway reads
([gateway configuration](https://code.claude.com/docs/en/claude-apps-gateway-config)). The **state file**
`infra/azure-test/.state/<resource group>.json` is different: the installer writes it, with the names, IDs and address
range of what it created, and later stages and scripts read it.

The installer reads one admin file, the same one `new-gateway-config.mjs`, `set-developer.mjs` and
`bootstrap-budgets.mjs` read ([configure models, roles and developer access](how-to-admin-configure.md)). Besides
`roles`, `models` and `policies`, the installer needs `deployment.adminApi: true` when it runs `admin-ui`, or `budgets`
with budgets declared, and refuses to start without it (infra/azure-test/Install-ClaudeGateway.ps1:190-195).
`deployment.emailClaim: preferred_username` is for a tenant whose accounts have no mail address (docs/UNKNOWNS.md,
U-81). Each `budgets` row is a spend cap ([script reference](reference-scripts.md#bootstrap-budgetsmjs)). The commands in
this article use this example. `config/gateway-admin.example.json` is a valid starting point that also sets the
managed database (tests/admin-config.test.mjs, T-118); `Copy-Item config/gateway-admin.example.json
config/gateway-admin.azure-eval.json` creates the file the commands name, and each `deployment` value then becomes a
Claude deployment name in the Foundry account. The example below is a smaller file, with one model and a daily cap;
the tutorial uses `config/gateway-admin.example.json`:

```json
{
  "roles": ["Gateway.Standard", "Gateway.Premium"],
  "models": [{ "id": "claude-sonnet-5", "label": "Claude Sonnet 5", "deployment": "claude-sonnet-5" }],
  "policies": [
    { "role": "Gateway.Premium", "models": ["claude-sonnet-5"], "desktop": true },
    { "role": "Gateway.Standard", "models": ["claude-sonnet-5"] }
  ],
  "deployment": { "adminApi": true },
  "budgets": [
    { "scope": { "type": "organization" }, "amountUsd": 100, "period": "monthly" },
    { "scope": { "type": "rbac_group", "rbac_group_id": "Gateway.Standard" }, "amountUsd": 20, "period": "daily" }
  ]
}
```

## Choose the database

The admin file's `deployment.database` chooses where the gateway keeps sessions, spend, caps and the audit trail
(docs/adr/0012-test-topology-database-choice.md).

| Value | Where | What a new revision does | Cost |
|---|---|---|---|
| `"sidecar"` (default) | PostgreSQL in the gateway app, on an `EmptyDir` volume | Starts with an empty database: spend, caps and the audit trail reset | None beyond the app |
| `"managed"` | Azure Database for PostgreSQL flexible server, Burstable B1ms, PostgreSQL 16, 35-day backups | Keeps everything; the server restores to any point in the last 35 days | B1ms compute $0.02 an hour (Azure Retail Prices API, 2026-10-25), plus storage |

A configuration save from the admin console, a client secret rotation and an image update each start a new revision
([Container Apps revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions)), so the chargeback
report for the month restarts with the sidecar. The managed server backs up automatically and restores to any point in
its retention window
([backup and restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore)).

With `"managed"`, the `app` stage registers `Microsoft.DBforPostgreSQL` on the subscription when needed, creates the
server and the `gateway` database, and sets the server firewall to the gateway app's outbound addresses. The server
has a public endpoint limited by that firewall and a password; the network-restricted deployment uses private access
instead. Container Apps outbound addresses can change
([networking](https://learn.microsoft.com/en-us/azure/container-apps/networking)); after a change,
`node scripts/admin/sync-database-firewall.mjs --resource-group <group>` sets the firewall again
([script reference](reference-scripts.md#sync-database-firewallmjs)).

B1ms can be refused in a region with `SkuNotAvailable`
([resolve capacity errors](https://learn.microsoft.com/en-us/azure/postgresql/troubleshoot/how-to-resolve-capacity-errors)).
`-DatabaseLocation` on the installer takes one region or a comma-separated list, such as `eastus2,centralus,westus3`.
The `preflight` stage skips a region that does not offer the server to the subscription, and the `base` stage creates the
server first, in the first region that accepts it, before anything else (infra/azure-test/lib/database.mjs:89). Later
runs keep the server's region (docs/UNKNOWNS.md, U-105 and U-135).

An existing sidecar deployment moves with `move-to-managed-database.mjs`
([script reference](reference-scripts.md#move-to-managed-databasemjs)). The move starts one revision with an empty
database; set the caps again afterwards with `bootstrap-budgets.mjs`.

## Run the installer

The gateway and the admin console accept connections from any network by default; the gateway admits only people signed
in with Microsoft Entra ID who hold a gateway role, and the console only its administrators
(infra/azure-test/Install-ClaudeGateway.ps1:191). `-TesterCidr <block>` limits the gateway, and `-AllowedCidr <block>`
the console, to one public address block in CIDR notation ([RFC 4632](https://www.rfc-editor.org/rfc/rfc4632)), `/24`
or narrower; the installer refuses a wider block and a private range (infra/azure-test/lib/plan.mjs:43-54). A caller
outside a block gets HTTP 403 with the body `RBAC: access denied`
([IP restrictions](https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions)). `203.0.113.0/26` is a documentation range ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)) that no machine connects
from, used in the README and the scripts' help.

The commands in this article read three PowerShell variables: `$admins`, who may open the admin console, as user
principal names separated by commas; and `$foundryRg` and `$foundry`, the resource group and name of the Microsoft
Foundry account, which the installer requires for the `preflight`, `base` and `app` stages. The admin console is
admin-only: the installer refuses the `admin-ui` stage without `-SignInAdmins`, and `-NoSignIn` deploys it without
sign-in, which then requires `-AllowedCidr`.

```powershell
$admins = az account show --query user.name -o tsv
$foundryRg = '<Foundry resource group>'
$foundry = '<Foundry account name>'
```

A later run keeps the address choice the state file records; `-TesterCidr` or `-AllowedCidr` on a later run replaces it,
and `-GatewayAllowAnyAddress` or `-ConsoleAllowAnyAddress` opens the app to every address again. `-UseExistingResourceGroup`
installs into a group that already exists, such as the one that holds the Foundry account: the installer adds its
resources next to what is there, stops if one there is named like a resource it creates, and teardown removes only the
resources tagged with this install's `runId` (infra/azure-test/lib/existing-group.mjs:31).

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -SignInAdmins $admins -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -Plan
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -SignInAdmins $admins -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval
```

`-Plan` runs the read-only `preflight` stage and prints every other stage's command line without running it. In a subscription other than the original test one,
`-FoundryResourceGroup` and `-FoundryAccount` name the Foundry account the gateway serves from, and `-EmailDomain`
is needed when the signed-in account has no mail address (infra/azure-test/deploy.mjs:215-216). `-Steps` runs a subset,
always in the order above; asking for `app` also runs `config`, so a stale rendering is never deployed
(infra/azure-test/Install-ClaudeGateway.ps1:146). With `-TesterCidr`, the block must hold this machine's egress address, which can change between requests
(docs/UNKNOWNS.md, U-33). On 2026-10-21 one run of all seven stages into an empty resource
group completed the first six in about eight minutes and stopped at the Graph grant, refused with
`Authorization_RequestDenied`; a second run of `app` and `budgets` changed no secret and replaced both caps in place
(docs/TEST-PLAN.md, T-91, T-95).

## Resume after a manual step

Only the scripts write `infra/azure-test/.state/<resource group>.json`, the record `entra`, `image` and `app` read
from earlier stages (infra/azure-test/deploy.mjs:42-49), so after a step done by hand the stage runs again to
record it, or the record is completed by hand where the table says so.

| Stage | After a manual step |
|---|---|
| `config` | Run it again; it only writes the rendering |
| `base` | Deploy the same template by hand, then run the stage again: it finds every resource in place and records their names |
| `entra` | Add the registration's identifiers to the state file before running it again; otherwise it registers a second application (infra/azure-test/deploy.mjs:224-226) |
| `image` | Run it again; it imports PostgreSQL when the registry lacks it, builds the gateway image again and records both digests, which `app` deploys (infra/azure-test/deploy.mjs:267-289); an image built by hand is not used |
| `app` | Run it again; it keeps the live app's JWT secret, database password and admin key (infra/azure-test/lib/credentials.mjs:46-48) |
| `budgets` | Nothing to record; the gateway keeps the caps |
| `admin-ui` | Run it again; a Graph permission already granted is reported and not granted twice |

## config

**The rendering of the admin file into `gateway.yaml`, which `app` deploys.**

Performed by: anyone with this repository; the stage makes no Azure call.

```powershell
node scripts/admin/new-gateway-config.mjs --topology test --admin config/gateway-admin.azure-eval.json --out config/gateway.azure-eval.yaml
```

The rendering is a local file and has no portal equivalent. A refused admin file is reported field by field, and
nothing is written (scripts/admin/new-gateway-config.mjs:31-85).

## preflight

**Read-only checks before anything is created ([ADR-0018](../adr/0018-existing-resource-group-preflight-and-database-first.md)).**

Performed by: the account that runs the install. Nothing in Azure or Entra changes, and `-Plan` runs this stage too.

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -DatabaseLocation eastus,centralus -Plan
```

Each check prints one line, `PASS`, `WARN` or `FAIL` (infra/azure-test/lib/preflight.mjs:59):

| Check | `FAIL` when |
|---|---|
| Tools | Node.js is older than 22, the Azure CLI older than 2.60 or missing, or its `containerapp` extension is missing |
| Azure role | The signed-in account cannot create the resource group, or cannot assign roles in it (Owner, or Contributor and User Access Administrator) |
| Foundry account access | The signed-in account cannot assign the gateway's identity a role on the account; or the account's public network access is off, or its endpoint subdomain is not its name |
| Entra | The signed-in account may not register applications (Application Administrator, Cloud Application Administrator, or the tenant's user setting). Without an active Privileged Role Administrator or Global Administrator the line is a `WARN`: the `admin-ui` stage stops at its Microsoft Graph grant |
| Resource providers | A `WARN` with the `az provider register` command when `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.OperationalInsights` or `Microsoft.ManagedIdentity` is not registered |
| Sign-in | The installing account has no e-mail address in Entra ID and the admin file has no `deployment.emailClaim` |
| Resource group | It exists, was not created by the installer, and `-UseExistingResourceGroup` is not given; or it holds a resource named like one the installer creates (for example `ca-claude-gw`) that this install did not make |
| Foundry account | The account is not in `-FoundryResourceGroup`, the signed-in account may not read it, or it has no deployment named in the admin file's `models[].deployment` |
| Database regions | With `deployment.database` `managed`: no region in `-DatabaseLocation` offers PostgreSQL 16 on Burstable `Standard_B1ms` to this subscription. A region that does not is a `WARN` and is skipped |

The region check reads the subscription's PostgreSQL capabilities
([Resolve capacity errors](https://learn.microsoft.com/en-us/azure/postgresql/troubleshoot/how-to-resolve-capacity-errors)).
A region can pass and still refuse at creation time, so the `base` stage creates the database first and moves to the
next region on a refusal (infra/azure-test/lib/database.mjs:89).

---

## base

**Resource group, container registry, managed identity, Log Analytics workspace, Container Apps environment, and the
identity's role on the Foundry account.**

Performed by: an Azure administrator with Owner on the subscription ([Prerequisites](#prerequisites)).

```powershell
node infra/azure-test/deploy.mjs --any-address --step base --resource-group rg-claude-gw-eval --foundry-resource-group $foundryRg --foundry-account $foundry
```

A resource group the stage creates carries a `purpose` and a `runId` tag that every later run checks; with
`--use-existing-resource-group` the stage uses a group without them and tags only what it creates. With the managed
database, the stage creates the database server first (see [preflight](#preflight)) (infra/azure-test/deploy.mjs:138-157).
The template derives the registry's and the workspace's names from the resource group's ID
(infra/azure-test/gateway-test.json:29-32), so the way to create the same resources by hand is to deploy that template.

# [Azure portal](#tab/portal-base)

1. **Resource groups** > **Create**: the name and region, with the tags `purpose` = `claude-apps-gateway-test` and
   `runId` = a new GUID ([deploy resources with ARM templates and the Azure portal](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-portal)).
1. **Create a resource** > search **template** > **Template deployment (deploy using custom templates)** > **Create** >
   **Build your own template in the editor** > **Load file**: `infra/azure-test/gateway-test.json` > **Save**.
1. Parameters: the resource group from step 1, **Run Id** the same GUID as its tag, **Tester Cidr**, **Foundry
   Resource Group**, **Foundry Account Name**, **Deploy App** `false` > **Review + create** > **Create**.
1. Run the `base` stage again so the state file records the names.

# [Script](#tab/script-base)

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -Steps base -FoundryResourceGroup $foundryRg -FoundryAccount $foundry
```

---

## entra

**App registration, service principal, and the signed-in tester's `Gateway.Standard` role.**

Performed by: an account that may register applications in the tenant ([Prerequisites](#prerequisites)).

```powershell
node infra/azure-test/deploy.mjs --any-address --step entra --resource-group rg-claude-gw-eval --app-display-name claude-apps-gateway-eval
```

Needs `base`: the redirect URI is the gateway host name `base` created (infra/azure-test/deploy.mjs:215). The app
roles, the `email` optional claim and the delegated permissions come from `infra/azure-test/entra-app.json`.
`set-developer.mjs` assigns a role by the ID that manifest gives it, so a registration made by hand carries the same
role IDs (scripts/admin/set-developer.mjs:77, scripts/admin/set-developer.mjs:102).

# [Azure portal](#tab/portal-entra)

1. **Microsoft Entra ID** > **App registrations** > **New registration**: the display name, single tenant, redirect
   URI **Web** `https://<gateway host from base>/oauth/callback`
   ([register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)).
1. **Manifest**: replace `appRoles` with the array in `infra/azure-test/entra-app.json`, which keeps its role IDs, and
   set `api.requestedAccessTokenVersion` to `2`
   ([app manifest](https://learn.microsoft.com/en-us/entra/identity-platform/reference-microsoft-graph-app-manifest)).
1. **Token configuration** > **Add optional claim**: ID token, `email`.
1. **Enterprise applications** > the app > **Users and groups** > **Add user/group**: yourself, role
   `Gateway.Standard` ([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).
1. In `infra/azure-test/.state/<resource group>.json`, add `"application": { "id": "<Object ID>", "appId":
   "<Application (client) ID>" }` from the registration's **Overview**, then run the `entra` stage again: it finds the
   registration, sets its redirect URI and optional claims, and records the service principal. The `app` stage adds
   the client secret.

# [Script](#tab/script-entra)

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -Steps entra -AppRegistrationName claude-apps-gateway-eval
```

---

## image

**The gateway image built through ACR Tasks, and, for the in-app database only, PostgreSQL 16 imported.**

Performed by: the Azure administrator who ran `base`.

```powershell
node infra/azure-test/deploy.mjs --any-address --step image --resource-group rg-claude-gw-eval
```

Needs `base`: the registry name comes from its record (infra/azure-test/deploy.mjs:269-270). The tag is the pinned
Claude Code version plus a timestamp, and the record holds each image's digest, which `app` deploys
(infra/azure-test/deploy.mjs:278-287).

# [Azure CLI](#tab/cli-image)

```powershell
az acr import --name <registry> --source docker.io/library/postgres:16-alpine --image postgres:16-alpine
az acr build --registry <registry> --image claude-gateway:<version>-<timestamp> infra/azure-test/image
```

The Azure portal has no page that runs an ACR Tasks build from a Dockerfile; **Container registries** >
**Repositories** lists the images already pushed
([build with ACR Tasks](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-quickstart-task-cli)).
These commands run in Azure Cloud Shell too. Run the `image` stage afterwards: only it records the digests.

# [Script](#tab/script-image)

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -Steps image
```

---

## app

**The gateway Container App: its secrets, environment variables, mounted configuration and ingress.**

Performed by: an Azure administrator with Owner on the subscription ([Prerequisites](#prerequisites)).

```powershell
node infra/azure-test/deploy.mjs --any-address --step app --resource-group rg-claude-gw-eval --config config/gateway.azure-eval.yaml --foundry-resource-group $foundryRg --foundry-account $foundry
```

Before it changes anything, the stage stops when the rendering references a `${VAR}` the template does not set,
because the gateway would not boot (infra/azure-test/deploy.mjs:333-334), and when the live app holds secrets or
variables the template does not define, which a redeploy would delete (infra/azure-test/lib/credentials.mjs:39-44). It
generates the admin API key once and keeps the live one on every later run. For Entra sign-in it makes a self-signed
certificate, registers it on the app registration, and deploys it as the secret `oidc-certificate`; a later run keeps a
certificate with more than 30 days left (infra/azure-test/lib/credentials.mjs:67). `--sign-in secret` uses a client
secret of `--client-secret-days` days, 365 by default, instead.

# [Azure portal](#tab/portal-app)

1. **Template deployment (deploy using custom templates)** > **Build your own template in the editor** > **Load
   file**: `infra/azure-test/gateway-test.json` > **Save**, as for `base`, with **Deploy App** `true`
   ([deploy resources with ARM templates and the Azure portal](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-portal)).
1. **Edit parameters**, since `gatewayConfigYaml` holds line breaks: `gatewayImage` and `postgresImage` are the
   digests in the state file's `images`; `oidcClientId` its `application.appId`; `allowedEmailDomain` its
   `tester.emailDomain`; `oidcClientSecret` a new client secret from the registration's **Certificates & secrets**, as a
portal deployment uses a client secret;
   `gatewayJwtSecret`, `postgresPassword` and `gatewayAdminWriteKey` 64 random hexadecimal characters each;
   `gatewayConfigYaml` the content of the rendering.
1. **Review + create** > **Create**, then run the `app` stage again: it keeps those three secrets, replaces the client
   secret with one it names, and records the revision.

Where a deployment fails, **Container Apps** > `ca-claude-gw` > **Revisions and replicas** and **Log stream** show why
([view log streams](https://learn.microsoft.com/en-us/azure/container-apps/log-streaming)).

# [Script](#tab/script-app)

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -Steps app -FoundryResourceGroup $foundryRg -FoundryAccount $foundry
```

---

## budgets

**The admin file's spend caps, through the gateway's own admin API (ADR-0009).**

Performed by: the Azure administrator who ran `app`, which created the admin key this stage reads.

```powershell
node scripts/admin/bootstrap-budgets.mjs --admin config/gateway-admin.azure-eval.json --resource-group rg-claude-gw-eval --gateway-app ca-claude-gw
```

Spend caps have no Azure portal page: they are set through the gateway's admin API, not as an Azure resource
(https://code.claude.com/docs/en/claude-apps-gateway-spend-limits, "Set a cap"). When the script stops:

- With `admin-ui` deployed, its **Budgets** page sets the same caps through the same API
  (docs/adr/0008-admin-ui-for-the-gateway-spend-limits-api.md, "Decision").
- Otherwise, call the API once per row; `amount` is USD cents as a string, or `null` for unlimited:

  ```powershell
  curl.exe -sS https://<gateway host>/v1/organizations/spend_limits `
    -H "x-api-key: $env:GATEWAY_ADMIN_WRITE_KEY" -H "Content-Type: application/json" `
    -d '{"scope": {"type": "organization"}, "amount": "10000", "period": "monthly"}'
  ```

  The key is the gateway app's `admin-write-key` secret, which `az containerapp secret show` reads.

## admin-ui

**The spend-limits and developer-role console (ADR-0008), as a second Container App, and its Microsoft Graph grant.**

Performed by: the Azure administrator for the deployment; the Microsoft Graph grant at the end needs a Privileged
Role Administrator or Global Administrator ([Prerequisites](#prerequisites)).

```powershell
pwsh -File admin-ui/infra/Deploy-AdminUi.ps1 -ResourceGroup rg-claude-gw-eval -AcrName <registry> -AppRegistrationName claude-apps-gateway-eval -AdminFile config/gateway-admin.azure-eval.json -Topology test -EnableSignIn -SignInAdmins $admins -AllowAnyAddress
```

`-AllowAnyAddress` deploys the console with no IP rule; `-AllowedCidr <block>` instead limits it to one block. The stage
also deploys `job-signin-renewer`, which renews the gateway's sign-in certificate or client secret 30 days before it
ends, with the console's identity; it needs the Microsoft Graph grant below and the console's ownership of the gateway's
app registration, which the stage adds after the grant (admin-ui/infra/main.bicep, `renewerJob`).

The Container App and its identity can be deployed from the portal; the Graph grant cannot.

# [Azure portal](#tab/portal-adminui)

1. The image build has no portal page, as for `image`. The Container App and its identity come from
   `admin-ui/infra/main.bicep`: **Template deployment** > **Build your own template in the editor** accepts ARM JSON, so
   the file is compiled first with `az bicep build --file admin-ui/infra/main.bicep`
   ([Bicep CLI build](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/bicep-cli#build)), and its
   parameters are the ones `Deploy-AdminUi.ps1` writes to its parameter file.
1. Microsoft documents assigning a managed identity to another application's app role, Microsoft Graph's included,
   with the Azure CLI or the Microsoft Graph PowerShell SDK
   ([assign a managed identity to an application role](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/assign-app-role-managed-identity-azure-cli)).
   The object ID is the `identity principal:` line the installer prints, and the **Object (principal) ID** on the
   **Overview** page of the managed identity `id-admin-ui` in the resource group
   (`admin-ui/infra/main.bicep`, line 76; `admin-ui/infra/Deploy-AdminUi.ps1`, line 235). In Azure Cloud Shell, signed in as a
   Privileged Role Administrator or Global Administrator:

   ```powershell
   $identityPrincipalId = '<object ID of the managed identity id-admin-ui>'
   $graphSpId = az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv
   foreach ($roleId in '06b708a9-e830-4db3-a914-8e69da51d44f', '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30', 'df021288-bdef-4463-88db-98f22de89214', '18a4783c-866b-4cc7-a460-3d5e5662c884') {
     @{ principalId = $identityPrincipalId; resourceId = $graphSpId; appRoleId = $roleId } | ConvertTo-Json -Compress | Set-Content "$HOME/role.json" -NoNewline
     az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId/appRoleAssignedTo" --body "@$HOME/role.json" --headers Content-Type=application/json
   }
   ```

   The four IDs are `AppRoleAssignment.ReadWrite.All`, `Application.Read.All`, `User.Read.All` and
   `Application.ReadWrite.OwnedBy`, Microsoft Graph's own app roles, the same in every tenant
   ([permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)). `Deploy-AdminUi.ps1`
   grants the same four (`admin-ui/infra/Deploy-AdminUi.ps1`, lines 95-100); it does not grant `User.ReadWrite.All`,
   because business-unit tags are kept in the gateway database (ADR-0015). The assignment is posted to Microsoft Graph's own
   service principal, the resource
   ([POST appRoleAssignedTo](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto)).
   `Application.ReadWrite.OwnedBy` also needs the admin-ui identity as an owner of the gateway's app registration,
   which `Deploy-AdminUi.ps1` adds; by hand,
   `az ad app owner add --id <gateway application ID> --owner-object-id $identityPrincipalId`
   ([az ad app owner](https://learn.microsoft.com/en-us/cli/azure/ad/app/owner)).

# [Script](#tab/script-adminui)

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -Steps admin-ui -SignInAdmins $admins -AppRegistrationName claude-apps-gateway-eval
```

---

## Related content

- [Manage users, groups and budgets](how-to-manage-users-and-groups.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Script reference](reference-scripts.md)
