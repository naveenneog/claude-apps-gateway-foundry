---
title: Manage users, groups and budgets
description: Grant or remove a developer's gateway role, add a new role, and set or change a spend cap, once the Claude apps gateway is installed, with the admin scripts and their Azure portal or API fallbacks.
author: naveenneog
ms.date: 10/19/2026
ms.topic: how-to
---

# Manage users, groups and budgets

Once `infra/azure-test/Install-ClaudeGateway.ps1` or its individual stages
([stage by stage](how-to-install-stage-by-stage.md)) have deployed a gateway, these are the ongoing operator tasks:
who holds a gateway role, what roles exist at all, and what each role or person may spend.

## Prerequisites

| Task | Needs |
|---|---|
| Grant, remove or list a role | The Azure CLI signed in to the deployment's tenant; an account that can assign users to the gateway's enterprise application: Cloud Application Administrator, Application Administrator, User Administrator, or an owner of its service principal ([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)) |
| Add a new role | The same account, with access to the app registration's own **Manifest** or **App roles** page, or Microsoft Graph directly |
| Set or change a budget | The gateway's `admin.write_keys` value, or admin-ui deployed and reachable in a browser |

## Grant or remove a developer's role

```powershell
node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard --admin <admin file> --resource-group <resource group>
node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard --remove --admin <admin file> --resource-group <resource group>
node scripts/admin/set-developer.mjs --list --resource-group <resource group>
```

The admin file is the one the install used, such as `config/gateway-admin.azure-eval.json`, and the resource group the
one it installed into; without them the script reads this project's own test file and resource group
(scripts/admin/set-developer.mjs:98-99).

The admin file's `roles` decides what may be granted: `set-developer.mjs` reads it and checks it with
`new-gateway-config.mjs`'s own rules before any Microsoft Graph request, so a role the admin file does not admit is
refused before anything changes (scripts/admin/set-developer.mjs:41-52). A removal needs no admitted roles, so a
role taken out of the admin file can still be removed from whoever holds it.

# [Azure portal](#tab/portal-grant)

1. **Enterprise applications** > the gateway's app > **Users and groups** > **Add user/group**: a user, and a role
   ([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).
1. To remove one, select its row in the same list and **Remove**.

Assigning a *group*, rather than one user at a time, needs Microsoft Entra ID P1 or P2
(docs/UNKNOWNS.md, U-24): group-based assignment to an enterprise application is a premium feature. The steps,
and what the console shows for a group, are in [Group developers into departments and teams](how-to-organize-departments.md#give-a-whole-team-a-role-with-an-entra-group).

# [Script](#tab/script-grant)

```powershell
node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard --admin <admin file> --resource-group <resource group>
```

---

## Add a new role

Entra app roles are more than a label: the gateway's `oidc.allowed_groups` admits sign-in only from a role already
in the admin file (scripts/admin/new-gateway-config.mjs:211-213), and a new role needs a matching
[policy](how-to-admin-configure.md#change-models-and-per-role-model-access) before anyone holding it can use a
model. After the admin console has saved the gateway's configuration, the console's **Access & models** page adds the
role to the configuration, because a later `app` stage keeps the console's configuration rather than the admin file
(docs/adr/0010-admin-ui-writes-gateway-config-roles-and-chargeback.md:117).

Adding the role to `infra/azure-test/entra-app.json`'s `appRoles` and re-running `deploy.mjs --step entra` does
**not** push it to an already-registered Entra app: that step's update path for an existing application sends only
`{web, optionalClaims}` to Microsoft Graph, not `appRoles` (docs/UNKNOWNS.md, U-83). Use one of these instead.

# [Azure portal](#tab/portal-role)

1. **Microsoft Entra ID** > **App registrations** > the gateway's app > **App roles** > **Create app role**: a
   **Display name** and **Value** (for example `Gateway.Trial`), allowed member types **Users/Groups**
   ([app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).
1. Add the same value to the admin file's `roles` array and a `policies` entry for it, then render and deploy the
   configuration again ([change models and per-role model access](how-to-admin-configure.md#change-models-and-per-role-model-access)).

# [Cloud Shell](#tab/cloudshell-role)

```powershell
$appId = az ad app list --display-name <app display name> --query "[?displayName=='<app display name>'].appId" -o tsv
$roles = (az ad app show --id $appId --query appRoles -o json | ConvertFrom-Json)
$roles += @{ id = [guid]::NewGuid().ToString(); displayName = 'Trial'; value = 'Gateway.Trial'; allowedMemberTypes = @('User'); isEnabled = $true; description = 'Trial access' }
$roles | ConvertTo-Json -Depth 5 | Set-Content "$HOME/app-roles.json"
az ad app update --id $appId --app-roles "@$HOME/app-roles.json"
```

A role is removed the same way: set its `isEnabled` to `false` in one update, then remove it entirely in a second
([delete an app role](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps#delete-an-app-role)) -
Microsoft Graph refuses deleting an enabled role outright.

---

## Set or change a budget

```powershell
node scripts/admin/bootstrap-budgets.mjs --admin <admin file> --resource-group <rg> --gateway-app <app>
```

Add or edit a row in the admin file's `budgets` array and re-run the command: the gateway's own `POST` replaces the
existing cap for an unchanged `{scope, period}` rather than creating a second one
(https://code.claude.com/docs/en/claude-apps-gateway-spend-limits, "Set a cap"), so this is the same command whether
a budget is new or changing.

# [admin-ui](#tab/adminui-budget)

Open the admin console ([use the admin console](how-to-use-admin-console.md)), **Budgets**, **Set cap**: a scope (`user`, `rbac_group` or
`organization`), the target (for `user`, the developer's e-mail address or OIDC subject, where an e-mail address takes
effect after that developer's first request through the gateway; for `rbac_group`, a gateway app role value such as
`Gateway.Standard`, not an Azure RBAC role or an Entra security group), an amount in USD, and a
period. The page calls the same API `bootstrap-budgets.mjs` does (admin-ui/web/app.js:150-163).

# [API](#tab/api-budget)

```powershell
curl.exe -sS https://<gateway host>/v1/organizations/spend_limits `
  -H "x-api-key: $env:GATEWAY_ADMIN_WRITE_KEY" -H "Content-Type: application/json" `
  -d '{"scope": {"type": "rbac_group", "rbac_group_id": "Gateway.Standard"}, "amount": "10000", "period": "daily"}'
```

There is no Azure portal page for this: spend limits are a gateway-native concept with no corresponding Azure
resource (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits).

---

## Related content

- [Group developers into departments and teams](how-to-organize-departments.md)
- [Install the Claude apps gateway, stage by stage](how-to-install-stage-by-stage.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Script reference](reference-scripts.md)
