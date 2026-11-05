---
title: Update an existing admin console without reinstalling the gateway
description: Build and roll out only the admin console image while preserving sign-in, permissions, ingress, secrets and the gateway database.
author: naveenneog
ms.date: 11/04/2026
ms.topic: how-to
---

# Update an existing admin console

This update replaces only the `admin-ui` container image in the existing console. It does not rerun Entra app
registration, grant permissions, reset budgets or redeploy the gateway database. The source is
[Update-AdminUi.ps1](../../admin-ui/infra/Update-AdminUi.ps1), and the preservation decision is ADR-0019
([Azure image updates](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)).

## Before the update

The existing installer machine has PowerShell 7, Azure CLI with the Container Apps extension, Git and this repository.
The signed-in Azure account needs permission to build in the existing registry, update the console Container App,
and read its authentication configuration. A new Privileged Role Administrator activation is not needed: this
update does not grant Graph permissions
([ACR build command](https://learn.microsoft.com/en-us/cli/azure/acr#az-acr-build)).

The commands run from the existing repository folder, in the customer's tenant and subscription. These identifiers
are examples, replaced by the customer's values:

```powershell
git pull --ff-only
az login --tenant 'CUSTOMER_TENANT_ID'
az account set --subscription 'CUSTOMER_SUBSCRIPTION_ID'
az account show -o table
$rg = 'EXISTING_RESOURCE_GROUP'
```

The local admin file and `.state` records stay in place. The update discovers the console's current registry and
keeps its existing settings; no app-registration name, admin file or `-UseExistingResourceGroup` argument is needed.

## Preview, then update

```powershell
pwsh -File .\admin-ui\infra\Update-AdminUi.ps1 -ResourceGroup $rg -Plan
```

The plan reads the selected subscription and console and prints the target, previous image and rollback command.
It builds nothing and changes no Azure resource. After the target is checked, the update is:

```powershell
pwsh -File .\admin-ui\infra\Update-AdminUi.ps1 -ResourceGroup $rg
```

The script builds the repository's admin-ui image with ACR Tasks, deploys it by digest, waits for a new ready and
Healthy revision, and compares authentication, ingress, identity, secrets and environment with the pre-update
settings. A changed setting, failed build or unhealthy rollout produces an error, not a success message.
The gateway, database, app registrations, role grants and scheduled jobs are not updated. This targeted image
update follows the [Container Apps update command](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)
instead of replacing the app with an incomplete ARM template.

## Check the console

After a browser refresh, **Settings > Check again** shows the console's current capabilities. Contributor on the
gateway app is the expected scope; there is no need to grant Owner or Contributor on the resource group.

**Container Apps Operator on the gateway's Container Apps environment** is also listed. Consoles installed before
2026-11-05 lack it, and **Apply and roll out** then answers 403 `LinkedAuthorizationFailed` for
`Microsoft.App/managedEnvironments/join/action`. Azure checks that action on the environment for every update of the
gateway app. The grant, by an account with Owner or User Access Administrator, is:

```powershell
$principal = az identity show -g $rg -n id-admin-ui --query principalId -o tsv
$envId = az containerapp env show -g $rg -n cae-claude-gw --query id -o tsv
az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal `
  --role 'Container Apps Operator' --scope $envId
```

Container Apps Operator reads the environment and allows join; it does not allow writing the environment or any app
([Container Apps Operator](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-operator)).
The Azure Portal path is the environment > **Access control (IAM)** > **Add role assignment** > **Container Apps
Operator** > `id-admin-ui`. A new assignment can take several minutes to apply
([RBAC troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting#symptom---role-assignment-changes-are-not-being-detected));
**Check again** then reports it, and **Apply and roll out** is retried. A later `Deploy-AdminUi.ps1` run finds this
assignment and does not create a second one, which Azure would refuse with `RoleAssignmentExists`.

**Developers > Grant role** and **Budgets > Set cap** exercise write requests. For a user cap, the email resolves
after the user's first model request; a manually entered ID is the gateway sign-in subject, not the Entra object ID.
An HTTP 403 with Azure Authentication's CSRF substatus 60 and an empty Referer is described in
[troubleshooting](troubleshoot.md#gateway-and-admin-console). The gateway's user cap uses its sign-in subject
([spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)).
The budget form asks for confirmation if an entered subject is not recorded; an Entra object ID can otherwise
produce a cap that matches nobody.

**Access & models > Desktop capabilities** configures the supported per-role import and plugin switches.
**Review changes** and **Apply and roll out** apply those policies to the gateway. This separate configuration change
starts a gateway revision; managed PostgreSQL keeps its data, while the temporary sidecar needs the page's explicit
data-loss acknowledgement ([Desktop settings](how-to-admin-configure.md#enable-import-plugins-and-extensions)).
If the page reports **Running configuration differs**, the image update does not reconcile the old deployed admin
file with later gateway changes. Those differences are reviewed before applying a Desktop policy; saving an old
admin file can otherwise replace a later sign-in or model setting.

## Roll back the console image

The updater prints the original image and an exact rollback command before making a change. The same image update
command with that original reference restores the earlier console code. It does not undo configuration changes made
through the console, or change the gateway's data.

No automatic rollback overwrites a concurrent administrator's changes. If the preservation check reports a
difference, the deployment settings are reviewed before using the printed rollback command
([image update command](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)).
