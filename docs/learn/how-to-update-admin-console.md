---
title: Update an existing admin console without reinstalling the gateway
description: Build and roll out only the admin console image, or only the gateway image, while preserving sign-in, permissions, ingress, secrets and the gateway database.
author: naveenneog
ms.date: 11/21/2026
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

The plan reads the selected subscription, console and scheduled jobs and prints the target, previous images, rollback
commands and the jobs it would update. It builds nothing and changes no Azure resource. After the target is checked, the update is:

```powershell
pwsh -File .\admin-ui\infra\Update-AdminUi.ps1 -ResourceGroup $rg
```

The script builds the repository's admin-ui image with ACR Tasks, deploys it by digest, waits for a new ready and
Healthy revision, and compares authentication, ingress, identity, secrets and environment with the pre-update
settings. A changed setting, failed build or unhealthy rollout produces an error, not a success message.
The gateway, database, app registrations and role grants are not updated. This targeted image
update follows the [Container Apps update command](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)
instead of replacing the app with an incomplete ARM template.

The console's scheduled jobs run the same image: `job-spend-pacer` (container `spend-pacer`) and, when sign-in
renewal is installed, `job-signin-renewer` (container `signin-renewer`). Only after the console revision is Healthy
does the script move each job that exists and runs an `admin-ui` image from the console's registry to the same digest.
A missing job, or one with another image or registry, is skipped and left unchanged. Each job's previous image and
rollback command are printed before any change. After each job update the script compares the job's identity, trigger
and schedule, secret names, registries and template, except the image, with the earlier settings. A difference stops
the run with that job's rollback command, and the success message names the jobs it updated
([job update command](https://learn.microsoft.com/en-us/cli/azure/containerapp/job#az-containerapp-job-update)).

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
"principal=$principal"; "envId=$envId"
if ($principal -and $envId) {
  az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal `
    --role f3bd1b5c-91fa-40e7-afe7-0c11d331232c --scope $envId
}
```

`f3bd1b5c-91fa-40e7-afe7-0c11d331232c` is the built-in Container Apps Operator role ID, the same in every tenant
([built-in roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-operator)).
The ID avoids a lookup by display name, which Azure CLI reports as `Role 'Container Apps Operator' doesn't exist`
when it cannot resolve the name at that scope. The `if` stops the command when either value is empty.

Container Apps Operator reads the environment and allows join; it does not allow writing the environment or any app
([Container Apps Operator](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-operator)).
The Azure Portal path is the environment > **Access control (IAM)** > **Add role assignment** > **Container Apps
Operator** > `id-admin-ui`. A new assignment can take several minutes to apply
([RBAC troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting#symptom---role-assignment-changes-are-not-being-detected));
**Check again** then reports it, and **Apply and roll out** is retried. A later `Deploy-AdminUi.ps1` run finds this
assignment and does not create a second one, which Azure would refuse with `RoleAssignmentExists`.

The gateway app also reattaches its user-assigned managed identity on each update. If **Apply and roll out** reports
403 `LinkedAuthorizationFailed` for `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action`, assign
**Managed Identity Operator** on `id-claude-gw` to `id-admin-ui`:

```powershell
$principal = az identity show -g $rg -n id-admin-ui --query principalId -o tsv
$identityId = az identity show -g $rg -n id-claude-gw --query id -o tsv
"principal=$principal"; "identityId=$identityId"
if ($principal -and $identityId) {
  az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal `
    --role f1a07417-d97a-45cb-824c-7a7467783830 --scope $identityId
}
```

The role ID is the built-in **Managed Identity Operator**. Its `assign/action` permission is scoped to the gateway
identity, not the resource group, and it does not let `id-admin-ui` change that identity. In the Portal, open
`id-claude-gw` > **Access control (IAM)** > **Add role assignment** > **Managed Identity Operator** > `id-admin-ui`.
Refresh **Settings > Check again** after the grant takes effect. The installer skips creating a duplicate if this
assignment already exists.

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

## Spend history after the update

From this version, the first `job-spend-pacer` run after the update creates the table `admin_console.spend_history`
in the managed database and copies the gateway's past spend into it, from the oldest period the gateway still keeps
(up to 13 months). Later runs, every 5 minutes, add to it; no existing table, cap, tag, audit event or role assignment
is changed (admin-ui/server/spend-history.mjs:11, docs/TEST-PLAN.md:720). **Chargeback** > **Showing** then lists the closed periods
([report a past period](how-to-organize-departments.md#report-a-past-period)). On the in-app database there is no
history, and the page says so. A rollback to an earlier console image leaves the table in place; the earlier code does
not read it, and a later update continues from it.

## Roll back the console image

The updater prints the original image and an exact rollback command before making a change. The same image update
command with that original reference restores the earlier console code. Each updated job has its own printed
command, `az containerapp job update -g <group> -n <job> --container-name <container> --image <previous image>`,
which restores that job's earlier code. Rollback does not undo configuration changes made
through the console, or change the gateway's data.

No automatic rollback overwrites a concurrent administrator's changes. If the preservation check reports a
difference, the deployment settings are reviewed before using the printed rollback command
([image update command](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)).

## Upgrade the gateway image

A new Claude Code release reaches the gateway through
[upgrade-gateway.mjs](../../scripts/admin/upgrade-gateway.mjs), which replaces only the `gateway` container image and
compares the gateway's data before and after (ADR-0021, P-51). It works only with the managed PostgreSQL database:
a gateway on the in-app database is refused, because a new revision starts that database empty
(scripts/admin/upgrade-gateway.mjs:58). The signed-in Azure account needs the same build and Container App update
permissions as the console update; reading the database from the installer machine needs a firewall rule for that
machine's address, which `--temporary-firewall` adds for the run and removes at the end, also after a failure
(scripts/admin/upgrade-gateway.mjs:161-170).

```powershell
node scripts/admin/upgrade-gateway.mjs --resource-group $rg --build --plan --temporary-firewall 'INSTALLER_PUBLIC_IPV4'
node scripts/admin/upgrade-gateway.mjs --resource-group $rg --build --temporary-firewall 'INSTALLER_PUBLIC_IPV4'
```

`--build` builds `infra/azure-test/image` at the Claude Code version its Dockerfile pins and deploys the resulting
digest; `--image` takes an existing `<registry>/claude-gateway@sha256:<digest>` from the app's own registry instead.
`--profile` with a signed-in developer profile folder adds an inference request and a `/user/bootstrap` check
([script reference](reference-scripts.md#upgrade-gatewaymjs)). `--plan` prints the running image, the target and the
rollback command and takes the first snapshot; it builds and changes nothing.

Each snapshot holds:

- the gateway's table list and `_migrations` versions, and the row count and content hash of each table in our
  `admin_console` schema, read in a `BEGIN READ ONLY` transaction (scripts/admin/gateway-upgrade.mjs:69-101);
- whether `public.spend` still has the columns the spend history backfill expects (U-156);
- spend caps, the newest audit events and each user's monthly spend, read through the documented admin API rather
  than from the gateway's tables, so a release that changes its own tables does not cause a false rollback
  ([spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits));
- `/healthz`, and with `--profile` inference, `/user/bootstrap`, its connector names and marketplace count.

A failing check in the first snapshot stops the run before any change. After the swap, the script waits for a ready,
Healthy revision and compares (scripts/admin/gateway-upgrade.mjs:113-151). A new gateway migration or table is
reported as a note; a missing migration, a changed `admin_console` table, a cap change with no audit event, a missing
audit event, a lower monthly spend, a failed check, changed connectors, or any other app setting that changed is a
failure. On success the image is recorded in the installer's state file, so a later `app` stage keeps it
(scripts/admin/upgrade-gateway.mjs:145-151).

On a failure, the script swaps the previous image back and waits for that revision, then exits 1 with the failures and
the rollback command; `--no-rollback` leaves the new image in place and only prints the command
(scripts/admin/gateway-upgrade.mjs:196-205). The installer state is not changed. A new image that ran a database
migration can leave a schema the previous image does not start on; the managed server's point-in-time restore is then
the recovery path ([point-in-time restore](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-backup-restore)).
On the Contoso test deployment on 2026-11-21, an upgrade to a new 2.1.311 build kept every compared item, and a
non-gateway image whose revision failed to activate was rolled back to a Healthy revision (docs/TEST-PLAN.md, T-182).
