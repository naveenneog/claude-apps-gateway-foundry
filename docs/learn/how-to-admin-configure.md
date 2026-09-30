---
title: Configure models, roles and developer access for the Claude apps gateway
description: Change the models the gateway serves and each app role's model list, grant and remove developer access through Microsoft Entra app roles, and generate the client payloads for Claude Code, with the admin scripts of this repository.
author: naveenneog
ms.date: 09/28/2026
ms.topic: how-to
---

# Configure models, roles and developer access

The admin scripts change three things on the Azure test deployment: which models the gateway serves and which roles
may use them, which users hold a gateway role, and what developer machines receive. Each script checks its input and
writes nothing when a check fails (docs/adr/0004-operator-and-developer-tooling.md:52-54).

## Prerequisites

| Task | Needs |
|---|---|
| Every task | Node.js 22 or later, and this repository |
| Deploy a configuration change | The state file `infra/azure-test/.state/<resource group>.json` that `infra/azure-test/deploy.mjs` wrote; the Azure CLI signed in with `az login`, `az account set --subscription <subscription>` for the deployment's subscription, and Owner on it, as for the deployment itself (README.md:48) |
| Grant or remove a role | The state file, from which `set-developer.mjs` reads the gateway's service principal (scripts/admin/set-developer.mjs:107); the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) signed in to the deployment's tenant with `az login --tenant <tenantId>` (the `tenantId` in the state file), because `set-developer.mjs` calls Microsoft Graph with that sign-in (infra/azure-test/lib/azure-rest.mjs:17); and an account that can assign users to the gateway's enterprise application: Cloud Application Administrator, Application Administrator, User Administrator, or an owner of its service principal ([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)). The account that ran `deploy.mjs` is an owner |
| Change models and per-role model access, or generate client payloads | Nothing more: `new-gateway-config.mjs` reads the admin file and the Entra application manifest in the repository, `infra/azure-test/entra-app.json` (scripts/admin/new-gateway-config.mjs:243-255), and `new-client-policy.mjs` reads only its options |

The deployment's tester range, which `--tester-cidr` needs, is in the state file:

```powershell
(Get-Content infra\azure-test\.state\rg-claude-apps-gateway-test.json -Raw | ConvertFrom-Json).testerCidr
```

## Change models and per-role model access

The gateway configuration `config/gateway.azure-test.yaml` is rendered from the admin file
`config/gateway-admin.azure-test.json`, and a test fails when the two differ (tests/admin-config.test.mjs:42). The
rendering of the fixed sections, the ADR-0003 topology, is part of the script.

| Key | Meaning |
|---|---|
| `roles` | The app roles the gateway admits, from `infra/azure-test/entra-app.json`; they become `oidc.allowed_groups` |
| `models` | Each model's `id` for clients, optional `label`, and the Foundry `deployment` that serves it |
| `policies` | Optional: one entry per admitted role, `{ "role": ..., "models": [...] }`, in the order the gateway checks them |

1. Edit the admin file. This example gives `Gateway.Premium` both models and `Gateway.Standard` one:

   ```json
   {
     "roles": ["Gateway.Standard", "Gateway.Premium"],
     "models": [
       { "id": "claude-opus-5", "label": "Claude Opus 5", "deployment": "claude-opus-5" },
       { "id": "claude-sonnet-5", "label": "Claude Sonnet 5", "deployment": "claude-sonnet-5" }
     ],
     "policies": [
       { "role": "Gateway.Premium", "models": ["claude-opus-5", "claude-sonnet-5"] },
       { "role": "Gateway.Standard", "models": ["claude-sonnet-5"] }
     ]
   }
   ```

1. Render the configuration:

   ```powershell
   node scripts/admin/new-gateway-config.mjs
   ```

   ```output
   wrote ...\config\gateway.azure-test.yaml: 2 models, 2 roles, 2 policies.
   Deploy it with: node infra/azure-test/deploy.mjs --tester-cidr <range> --step app
   ```

1. Deploy it with the tester range from the state file. The app step replaces the configuration secret and waits for
   the new revision:

   ```powershell
   $range = (Get-Content infra\azure-test\.state\rg-claude-apps-gateway-test.json -Raw | ConvertFrom-Json).testerCidr
   node infra/azure-test/deploy.mjs --tester-cidr $range --step app
   ```

The gateway enforces each policy's `availableModels` at `/v1/messages`, so a request for another model gets `400`
([managed](https://code.claude.com/docs/en/claude-apps-gateway-config#managed)). A user who matches no policy may use
every model in the catalog, so the script requires a policy for every admitted role and renders no `match: {}`
policy. A policy's other `cli` keys reach only clients that sign in through `/login`
([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)).

The script stops with exit code 1 on a role the Entra manifest does not define, a model without a deployment, a
policy model or role outside the lists, an admitted role without a policy, a duplicate, an unknown key, an entry that
is not an object, or a label with a line break or a `$`. The gateway replaces `${VAR}` in a value with an
environment variable, also inside a longer string, and a whole `${file:/path}` value with the file's content
([secret expansion](https://code.claude.com/docs/en/claude-apps-gateway-config#secret-expansion)), and it serves each
label to every signed-in user. A `$` in a label could therefore publish a gateway secret, so the renderer also refuses
a `$` in every value it takes from the admin file (scripts/admin/new-gateway-config.mjs:17-21). `--check` reports a
configuration that differs from the admin file, or an admin file with a problem, without writing.

## Grant developer access

The gateway admits a user whose token carries one of its app roles (config/gateway.azure-test.yaml:22-23).
`set-developer.mjs` adds and removes app role assignments on the gateway's service principal through Microsoft Graph
([appRoleAssignedTo](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto)). It grants
only a role the admin file admits, because the gateway would refuse its holder's sign-in. The admin file is the one
`new-gateway-config.mjs` renders from, `config/gateway-admin.azure-test.json` unless `--admin` names another; the script
reads it and checks it with the renderer's rules before any Graph request (scripts/admin/set-developer.mjs:41-52).

1. Grant a role. A second run reports that the user already holds it:

   ```powershell
   node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard
   ```

   ```output
   Gateway.Standard granted to Dev One (dev@contoso.com)
   ```

1. List the users who hold each role:

   ```powershell
   node scripts/admin/set-developer.mjs --list
   ```

1. Remove a role. The user's other gateway role, and assignments of other apps, stay:

   ```powershell
   node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard --remove
   ```

A guest's user principal name contains `#EXT#`; the script accepts it as Graph lists it. A change reaches the gateway
at the user's next sign-in or session refresh, within the session lifetime of one hour
([managed](https://code.claude.com/docs/en/claude-apps-gateway-config#managed)).

## Generate client payloads

`new-client-policy.mjs` writes two alternative sets of client files; a machine takes one of them, because under
`forceLoginMethod` Claude Code blocks an `apiKeyHelper` credential at startup
([authentication](https://code.claude.com/docs/en/authentication)).

1. Generate the files:

   ```powershell
   node scripts/admin/new-client-policy.mjs --gateway-url https://claude-gateway.corp.contoso.com --fast-model claude-sonnet-5 --out .\client-policy
   ```

1. Deliver one folder to each machine:

   | Folder | Content | Delivery |
   |---|---|---|
   | `login\` | `managed-settings.json`, `ClaudeCode-HKLM.reg`, `ClaudeCode.mobileconfig` | `managed-settings.json` in `C:\Program Files\ClaudeCode\`, `/Library/Application Support/ClaudeCode/` or `/etc/claude-code/` ([managed settings](https://code.claude.com/docs/en/managed-settings)); the `.reg` file through Group Policy or an installer; the `.mobileconfig` through MDM |
   | `developer\` | Every script of `scripts\developer`, and `START-HERE.txt`: the prerequisites (Windows PowerShell 5.1, Claude Code 2.1.272 or later, a network the gateway admits, a gateway role), the install, sign-in and sign-out commands to run from the folder, and the common messages with their fixes (scripts/admin/new-client-policy.mjs:95-99) | To the developer, for the [quickstart](quickstart-developer.md) |

The `login` payloads set `forceLoginMethod` to `gateway`, `forceLoginGatewayUrl` to the gateway, and
`parentSettingsBehavior` to `merge` ([set the gateway URL](https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url)).
`/login` accepts the gateway only when its name resolves to private addresses, so the script refuses a public IPv4
literal, an IPv6 literal, a URL that is not `https`, and a URL with a path, query or credentials. The configuration
profile's identifiers come from `--policy-id` (default `default`), so a new gateway URL with the same policy ID
updates the profile an MDM already holds. The payloads were checked by tests, not imported on a device.

## Related content

- [Quickstart: connect Claude Code on Windows](quickstart-developer.md)
- [Run the inference tests](how-to-test-inference.md)
- [Script reference](reference-scripts.md)