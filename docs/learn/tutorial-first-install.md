---
title: "Tutorial: Install the Claude apps gateway on Azure and onboard developers"
description: A first install from start to finish for an Azure administrator new to the gateway. It covers the tools, the values each command needs, the admin file, the installer, the admin console, giving developers access, and onboarding developer machines one at a time or with Microsoft Intune.
author: naveenneog
ms.date: 10/25/2026
ms.topic: tutorial
---

# Tutorial: Install the Claude apps gateway on Azure and onboard developers

The Claude apps gateway is a server that signs developers in with Microsoft Entra ID and forwards Claude Code's
requests to Claude models in Microsoft Foundry, so no model key reaches a developer machine
([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)). This tutorial installs it into one Azure
resource group, with an admin console, then connects developer machines. Every command runs from the repository root in
one PowerShell 7 window, and each step shows the output that means it worked. Terms are defined in the
[glossary](glossary.md).

At the end of this tutorial:

- The gateway runs on Azure Container Apps and accepts connections from one public address range
  (docs/adr/0003-azure-test-deployment-with-restricted-ingress.md:1).
- Spend, spend caps and chargeback data are kept in Azure Database for PostgreSQL, with 35 days of point-in-time
  restore (docs/adr/0012-test-topology-database-choice.md:50).
- The admin console opens only for the people named at install (docs/adr/0011-admin-ui-is-admin-only-with-sign-in.md:1).
- Developers use Claude Code through the gateway, installed by hand on one machine or by Intune on many.

This is the project's test topology: a public address limited to one range, for evaluation and pilots (ADR-0003). A
gateway that has no public address and is reached over VPN or ExpressRoute, the design for production, is the subject
of [Tutorial: deploy in a network-restricted environment](tutorial-deploy-network-restricted.md).

In this tutorial, you:

- Check the tools and sign in to Azure
- Set the values every command uses
- Write the admin file from the example
- Preview and run the installer
- Open the admin console and give developers access
- Onboard developer machines, by hand and with Intune
- Keep the gateway's sign-in secret current

## Before you begin

The install needs three Microsoft roles. One person can hold all of them, or several people can each run their part
([Microsoft Entra built-in roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference)).

| Need | Why | Source |
|---|---|---|
| **Owner** on the Azure subscription | The install creates resources and gives the gateway's identity a role on the Foundry account | infra/azure-test/gateway-test.json:106-142 |
| An Entra account that may register applications, such as **Application Administrator** | The gateway signs developers in through its own app registration | https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app |
| **Privileged Role Administrator** or **Global Administrator**, for one step | The admin console reads users and roles through Microsoft Graph application permissions, which only these roles grant. When the installing account lacks the role, the install stops at its last stage and a person who holds it runs the commands of one step ([Run the install](#run-the-install)); in this project's installs the role was activated through Privileged Identity Management for the grant (docs/UNKNOWNS.md, U-75) | https://learn.microsoft.com/en-us/powershell/entra-powershell/grant-api-permissions-managed-identity |
| A subscription that can run Azure Container Registry Tasks, which build the two images; some trial and free-credit subscriptions cannot | `az acr build` builds the gateway and console images in Azure (infra/azure-test/deploy.mjs:217) | https://learn.microsoft.com/en-us/azure/container-registry/container-registry-tasks-overview |
| A Microsoft Foundry account with Claude models deployed, in the same subscription and Entra tenant as the install, that accepts traffic from public networks, and whose endpoint subdomain is its name, as Foundry creates it | The gateway calls Claude through it with its managed identity, and names it by the account name (config/gateway.azure-test.yaml:36); the identity gets a role on that account (infra/azure-test/gateway-test.json:106-142) | https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude |
| One public address block, `/24` or narrower, that every developer machine and the administrator's machine connect to the internet from, such as the company's internet exit | The gateway and the console accept connections from that one block only; a machine outside it gets HTTP 403 (infra/azure-test/lib/plan.mjs:43-54) | https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions |
| For Intune onboarding: the Intune **Application Manager** role, and Windows devices joined or registered to Entra ID and enrolled in Intune | Intune installs the developer apps | https://learn.microsoft.com/en-us/intune/intune-service/fundamentals/role-based-access-control |

Developers sign in with an e-mail address in the same domain as the account that runs the install, for example
`contoso.com`; the gateway admits that one domain (config/gateway.azure-test.yaml:20; infra/azure-test/deploy.mjs:156).
When the installing account's e-mail is in another domain, such as `contoso.onmicrosoft.com`, `-EmailDomain contoso.com`
on the install command sets the developers' domain instead.

Some tenants stop users from consenting to applications. Users of such a tenant see **Need admin approval** at their
first sign-in to the gateway or the console, and an Application Administrator grants consent once for each, as in
[Give developers access](#give-developers-access)
([grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)).

The install costs money while it runs. The managed database's compute is $0.02 an hour in East US 2 and in Central US (Azure
Retail Prices API, 2026-10-25); Container Apps, Container Registry and Log Analytics are billed by use
([Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)). [Clean up
resources](#clean-up-resources) removes everything.

## Check the tools

Each command prints a version. This project's installs ran on Windows, which Intune packaging and the developer-machine steps also need
([PowerShell 7](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell),
[Node.js](https://nodejs.org/en/download), [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli),
[Git](https://git-scm.com/downloads)).

```powershell
pwsh --version
node --version
az --version
git --version
```

| Tool | Version needed | Example output |
|---|---|---|
| PowerShell | 7 or later | `PowerShell 7.5.2` |
| Node.js | 22 or later | `v22.11.0` |
| Azure CLI | 2.60 or later | `azure-cli 2.77.0` |
| Git | any | `git version 2.49.0.windows.1` |

A command reported as not recognized means the tool is missing; its link above installs it. Open a new PowerShell 7
window after installing a tool, so the new `PATH` applies.

## Get the files and sign in to Azure

The commands run from the root of the repository that holds this article, which contains the installer and the admin
file example. Its address for `git clone` is on its GitHub page under **Code**
([cloning a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository)).
The public copy, `naveenneog/claude-apps-gateway-foundry`, holds the revision last published (ADR-0006,
docs/adr/0006-publish-a-clean-public-copy.md:1). Sign-in uses the Azure CLI
([sign in with the Azure CLI](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli)):

```powershell
git clone <repository address>
Set-Location <repository folder>
az login
az account set --subscription "<subscription name or ID>"
az account show --query "{subscription:name,user:user.name}" -o table
az extension add --name containerapp --upgrade
```

`az account show` prints the subscription and the account every later command uses:

```output
Subscription          User
--------------------  -----------------------
Contoso Engineering   admin@contoso.com
```

A different subscription in that output means `az account set` named another one; the install goes into the
subscription shown here.

## Set the values every command uses

These variables hold the values the later commands read. They last as long as the PowerShell window; a new window
needs them set again.

```powershell
$rg = 'rg-claude-gw-eval'
$foundryRg = '<resource group of your Foundry account>'
$foundry = '<name of your Foundry account>'
$admins = az account show --query user.name -o tsv
$ip = Invoke-RestMethod https://api.ipify.org
$cidr = "$ip/32"
"$rg $foundryRg $foundry $admins $cidr"
```

| Variable | Value |
|---|---|
| `$rg` | A new resource group for the gateway. The installer creates it ([resource groups](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/manage-resource-groups-portal)) |
| `$foundryRg`, `$foundry` | The Foundry account's resource group and name, from its **Overview** page in the Azure portal |
| `$admins` | Who may open the admin console: the signed-in account. Several people are written as `'a@contoso.com,b@contoso.com'`. A guest or personal Microsoft account prints a name that is not a user principal name of the tenant; `$admins` is then set to a member account of the tenant |
| `$cidr` | The block the gateway and the console accept connections from. The command above sets this machine's own address as `/32`, which admits this machine only; [Choose the address range](#choose-the-address-range) decides it |

### Choose the address range

The range is decided before the install. The two choices:

| Choice | `$cidr` | Developers |
|---|---|---|
| Company block, for an install developers use | The company's public block from the network team, for example `$cidr = '198.51.100.0/26'` | Every machine inside the block connects |
| This machine only, to try the install first | `"$ip/32"`, as set above | None until the range is widened, as in [Widen the address range](#widen-the-address-range) |

The install records the range in `infra/azure-test/.state/<resource group>.json`. A later run of the installer without
`-TesterCidr` uses the recorded range, and prints `tester range: recorded range <range>`
(infra/azure-test/Install-ClaudeGateway.ps1:150-158), followed by the state file's path; a later run with
`-TesterCidr` replaces it.

A network that uses several public addresses, as many company networks do, needs its whole range from the network
team, as a block of `/24` or narrower, written as its first address, for example `198.51.100.0/26`; the installer
refuses a wider block and a private range (infra/azure-test/lib/plan.mjs:43-54). The ranges in this article's examples,
`198.51.100.0/24` and `203.0.113.0/24`, are documentation ranges ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737))
that no machine connects from. A machine outside the range gets HTTP 403 with
the body `RBAC: access denied` ([IP restrictions](https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions)).

## Find your Claude deployments in Foundry

The admin file names each Claude model by its deployment name in Foundry
([az cognitiveservices account deployment](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/deployment)):

```powershell
az cognitiveservices account deployment list -g $foundryRg -n $foundry --query "[].{deployment:name,model:properties.model.name}" -o table
```

```output
Deployment       Model
---------------  ---------------
claude-sonnet-5  claude-sonnet-5
claude-opus-5    claude-opus-5
```

The left column is what the admin file needs. An empty table means the account has no deployment yet;
[Deploy and use Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
creates one.

## Write the admin file

The admin file lists who may use the gateway, which models each group may use, and spend caps; the installer turns it
into the gateway's configuration (docs/adr/0004-operator-and-developer-tooling.md:1). The repository's example is valid
as shipped (tests/admin-config.test.mjs, T-118). Copy it, then open the copy:

```powershell
Copy-Item config/gateway-admin.example.json config/gateway-admin.azure-eval.json
notepad config/gateway-admin.azure-eval.json
```

In the copy, each `"deployment"` value under `models` is changed to a deployment name from the previous step. `id` is
the name developers and `--fast-model` use for the model, and changes with it when the deployment holds another model;
the same `id` is then changed in each `policies` entry that lists it. A model
with no deployment is removed from `models` and from each `policies` entry that lists it. The other values:

| Field | In the example | Meaning |
|---|---|---|
| `roles` | `Gateway.Standard`, `Gateway.Premium` | The two access levels a developer can be given (infra/azure-test/entra-app.json:1) |
| `policies` | Premium: both models and Claude Desktop; Standard: Sonnet only | What each access level may use ([gateway configuration](https://code.claude.com/docs/en/claude-apps-gateway-config#managed)) |
| `deployment.adminApi` | `true` | Turns on the spend-limits API the admin console uses (docs/adr/0008-admin-ui-for-the-gateway-spend-limits-api.md:1) |
| `deployment.database` | `"managed"` | Keeps spend and chargeback when the configuration changes ([choose the database](how-to-install-stage-by-stage.md#choose-the-database)) |
| `budgets` | 100 USD a month for the whole organization | A spend cap; the admin console changes it later ([spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)) |

The file is checked by rendering it:

```powershell
node scripts/admin/new-gateway-config.mjs --topology test --admin config/gateway-admin.azure-eval.json --out config/gateway.azure-eval.yaml
```

```output
wrote config/gateway.azure-eval.yaml: 2 models, 2 roles, 2 policies.
Deploy it with: node infra/azure-test/deploy.mjs --tester-cidr <range> --step app
```

The second line is for running stages one at a time; the installer in the next steps runs that stage itself.

A mistake is reported by field, for example `models[1].deployment: ...`, and nothing is written
(scripts/admin/new-gateway-config.mjs:30-84).

## Preview the install

`-Plan` prints every command the installer would run and changes nothing
(infra/azure-test/Install-ClaudeGateway.ps1:198-200, 233):

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -TesterCidr $cidr -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -SignInAdmins $admins -ClientSecretDays 30 -DatabaseLocation centralus -Plan
```

The output ends with:

```output
== admin-ui ==
  pwsh -NoProfile -File <repository>\infra\azure-test\..\..\admin-ui\infra\Deploy-AdminUi.ps1 -ResourceGroup rg-claude-gw-eval -EnvironmentName cae-claude-gw -GatewayAppName ca-claude-gw -AcrName <acrName the base stage records> -AppRegistrationName claude-apps-gateway-eval -AdminFile config\gateway-admin.azure-eval.json -AllowedCidr 198.51.100.7/32 -Topology test -EnableSignIn -SignInAdmins admin@contoso.com
=== plan: 7 stage(s) would run ===
```

## Run the install

The same command without `-Plan`. `-DatabaseLocation centralus` places the managed database in Central US, because East US 2 refused its size in this
project's installs (docs/UNKNOWNS.md, U-105); without it the database is in the gateway's region. `-ClientSecretDays 30`
gives the gateway's sign-in secret 30 days, the most the
installer allows; [Keep the gateway's sign-in secret current](#keep-the-gateways-sign-in-secret-current) renews it:

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -TesterCidr $cidr -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -SignInAdmins $admins -ClientSecretDays 30 -DatabaseLocation centralus
```

The installer runs seven stages in order and prints `== <stage> ==` as each starts
(infra/azure-test/Install-ClaudeGateway.ps1:198). On 2026-10-21 the first six took about eight minutes
(docs/TEST-PLAN.md, T-91); creating the managed database adds several minutes. A finished install ends with the two
addresses to keep, and the console identity's object ID, which the Microsoft Graph grant below needs:

```output
[deploy] gateway: https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io
...
  admin-ui: https://ca-admin-ui.<environment>.eastus2.azurecontainerapps.io
  identity principal: <object ID of id-admin-ui>
...
=== done ===
=== install complete ===
```

The install writes `infra/azure-test/.state/<resource group>.json`, which git does not track (.gitignore:7). Renewing
the sign-in secret, widening the range and clean-up read it, so they run in this repository folder on this machine, and
a copy of the file kept with the deployment's records, placed in the same folder of another clone together with the
admin file `config/gateway-admin.azure-eval.json`, which git does not track either, lets another machine
run them. The gateway is deployed to East
US 2 unless the install command has `-Location <region>` (infra/azure-test/deploy.mjs:53).

When a stage stops, the installer names it and the section of
[Install the Claude apps gateway, stage by stage](how-to-install-stage-by-stage.md) that does it by hand
(infra/azure-test/Install-ClaudeGateway.ps1:203). The stops seen in this project's installs:

| Stop | Cause | What fixes it |
|---|---|---|
| `admin-ui` stops with `Authorization_RequestDenied` | The account lacks Privileged Role Administrator for the Microsoft Graph grant (docs/UNKNOWNS.md, U-75) | 1. A Privileged Role Administrator, with the role active (in Privileged Identity Management when the tenant uses it), opens Azure Cloud Shell in **PowerShell** and runs [the Cloud Shell commands of the admin-ui stage](how-to-install-stage-by-stage.md#admin-ui), which give the console's identity its four permissions. When Cloud Shell is not available to that person, the same commands run in PowerShell 7 on any machine with the Azure CLI after `az login --allow-no-subscriptions`. 2. The installing account runs the install command again without `-TesterCidr` and with `-Steps admin-ui`: it reports `already granted` for the four, makes the console an owner of the gateway's app registration, which the **Roles** page needs, and deploys the console again (`admin-ui/infra/Deploy-AdminUi.ps1`, lines 240-265). When the **Developers** page still reports a missing permission, `az containerapp revision restart -n ca-admin-ui -g $rg --revision <revision>`, with the name from `az containerapp revision list -n ca-admin-ui -g $rg -o table`, starts it with a new Microsoft Graph token (admin-ui/server/managed-identity.mjs:12-16) |
| `app` stops with `SkuNotAvailable` | The region does not offer the database size to this subscription; in this project every East US 2 attempt on 2026-10-25 was refused, so `-DatabaseLocation centralus` on the first install avoids it (docs/UNKNOWNS.md, U-105) | The same install command with `-DatabaseLocation` set to another region and `-Steps app,budgets,admin-ui`; the console has not saved yet at this point |
| `the gateway is ready, but this machine gets 403 for ...` | This machine's public address left `$cidr` (docs/UNKNOWNS.md, U-33) | With the company block, this machine connects from inside it (on the company network or VPN), then the install command without `-TesterCidr` and with `-Steps app,budgets,admin-ui`. With this machine only, `$ip` and `$cidr` set again, then the same install command with `-Steps app,budgets,admin-ui`. The stop came before `budgets` and `admin-ui` ran, so the command runs them too. The message also names a `deploy.mjs` command; the install command does the same with the Foundry values (infra/azure-test/deploy.mjs:320-331) |
| `app` stops when it adds the client secret, with a Microsoft Graph error about the credential's lifetime | The tenant's app management policy allows client secrets shorter than 30 days (docs/UNKNOWNS.md, U-1) | The same install command with `-ClientSecretDays` at or under the tenant's limit, and renewals at that interval |
| `the signed-in user has no mail address; pass --email-domain` | The installing account has no e-mail address in Entra ID, as in many trial tenants (infra/azure-test/deploy.mjs:157) | When developers have e-mail addresses, the same install command with `-EmailDomain` set to their domain, for example `-EmailDomain contoso.com`. When they do not either, as in many trial tenants, also `"emailClaim": "preferred_username"` under `deployment` in the admin file, so the gateway reads the sign-in name (docs/UNKNOWNS.md, U-81), with `-EmailDomain` set to the sign-in names' domain, for example `contoso.onmicrosoft.com` |

Every stage can run again: a stage that already ran finds its resources and changes only what differs
(docs/adr/0009-a-staged-installer-over-the-existing-deploy-scripts.md:1). After the admin console has saved the
gateway's configuration, the `app` stage keeps the console's configuration and prints `the admin console saved this
gateway's configuration; the app step keeps it and does not deploy <file>` (infra/azure-test/deploy.mjs:341-343); models,
roles and policies are then changed in the console. A later run names its stages with `-Steps`, such as `-Steps app` or
`-Steps admin-ui`, and leaves out `-TesterCidr` unless the range changes: the `budgets` stage sets the spend caps from
the admin file again, replacing caps changed in the console
([install stage by stage](how-to-install-stage-by-stage.md#budgets)), and the admin file on disk does not hold
roles or models added in the console.

## Open the admin console

The console is at the `admin-ui:` address the install printed. Both addresses are also on each Container App's
**Overview** page in the Azure portal, `ca-claude-gw` and `ca-admin-ui` in `$rg`, as **Application Url**. It asks for a Microsoft sign-in, then opens the
**Dashboard**; an account named in `$admins` sees **Admin** next to its name (ADR-0011,
docs/adr/0011-admin-ui-is-admin-only-with-sign-in.md:1). Its pages are described in
[Use the admin console](how-to-use-admin-console.md).

| What appears | Meaning |
|---|---|
| `RBAC: access denied` | This machine's address is outside `$cidr` ([troubleshoot](troubleshoot.md)) |
| `AADSTS50105` from Microsoft sign-in | The account has no assignment on the console's sign-in application, `claude-apps-gateway-eval-admin-ui-signin`; the install command without `-TesterCidr`, with that account added to `-SignInAdmins` and with `-Steps admin-ui`, assigns it; before the Microsoft Graph grant is in place the run stops at the grant, after the assignment ([troubleshoot](troubleshoot.md#gateway-and-admin-console)) |
| **AdminUi.Admin is required** | The account is assigned to the sign-in application without the `AdminUi.Admin` role; the same command assigns the role |
| **Need admin approval** | The tenant stops user consent; an Application Administrator grants it as in [Give developers access](#give-developers-access) |

The installing account already holds `Gateway.Standard` (infra/azure-test/deploy.mjs:193), so the gateway can be
checked end to end before any developer is onboarded: [Onboard developers](#onboard-developers), the `new-client-policy.mjs` command and
[One machine](#one-machine), on this machine when it runs Windows, then [Check that it works](#check-that-it-works).

## Give developers access

The account that ran the install already holds `Gateway.Standard` (infra/azure-test/deploy.mjs:193). On the console's
**Developers** page, a user principal name and a role, `Gateway.Standard` or `Gateway.Premium`, then
**Grant role** gives a developer access (docs/learn/how-to-use-admin-console.md:59). The role decides the models and
whether Claude Desktop is available, as the admin file's `policies` set them. For a group of developers, the
**Enterprise applications** page in the Microsoft Entra admin center assigns a role to an Entra group, which needs
Microsoft Entra ID P1 or P2; assigning users one at a time there needs neither
([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).
The steps for a group, and for putting developers into departments for chargeback, are in
[Group developers into departments and teams](how-to-organize-departments.md).
The gateway's enterprise application has the name given as `-AppRegistrationName`, `claude-apps-gateway-eval`. Before
the Microsoft Graph grant is in place the **Developers** page cannot assign roles; this command does the same from the
installing machine (scripts/admin/set-developer.mjs:1-12):

```powershell
node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard --admin config/gateway-admin.azure-eval.json --resource-group $rg
```

In a tenant that stops user consent, sign-in shows **Need admin approval** until an Application Administrator grants
consent once for each of the two applications: Microsoft Entra admin center > **Enterprise apps** > **All
applications** > `claude-apps-gateway-eval`, then `claude-apps-gateway-eval-admin-ui-signin` > **Permissions** >
**Grant admin consent**. The gateway's application asks only for sign-in permissions (infra/azure-test/entra-app.json:37-42)
([grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)).
The console's sign-in application declares no permissions, so its prompt, if any, asks only for sign-in. This
project's tenant allowed user consent, so this step was not needed in its installs, and whether **Grant admin consent**
clears the prompt for the console's application is untested (docs/UNKNOWNS.md, U-108).

## Onboard developers

This gateway has a public address. Claude Code's built-in gateway sign-in, `/login`, accepts only a gateway whose name
resolves to private addresses, so a device policy that forces it would stop every sign-in
([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)). Developers use the gateway
profile instead: a separate Claude Code profile that signs in to the gateway once and sends Claude Code's requests to
it, without administrator rights and without changing the developer's own Claude Code settings
(docs/adr/0004-operator-and-developer-tooling.md:15-17).

One command writes everything the developer machines need, from the gateway address the install printed. `--model`
and `--fast-model` take a model `id` from the admin file that every developer's role allows; in the example that is
`claude-sonnet-5`, the one model of `Gateway.Standard` (config/gateway-admin.example.json:10):

```powershell
node scripts/admin/new-client-policy.mjs --gateway-url https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io --fast-model claude-sonnet-5 --model claude-sonnet-5 --out .\client-policy
```

```output
wrote C:\...\client-policy: login\ (managed-settings.json, ClaudeCode-HKLM.reg, ClaudeCode.mobileconfig), developer\, intune\ (INTUNE.txt) and desktop\ (DESKTOP.txt).
```

The lines after it explain why `login\` does not apply here. A second run into the same folder needs `--force`
(scripts/admin/new-client-policy.mjs:14-16).

| Folder | For |
|---|---|
| `client-policy\developer` | One machine, set up by the developer |
| `client-policy\intune` | Many machines, set up by Intune; `INTUNE.txt` holds every Intune field value |
| `client-policy\desktop` | Claude Desktop: `ClaudeDesktop-HKLM.reg` for one machine, `Set-ClaudeDesktopPolicy.ps1` for Intune, `DESKTOP.txt` with the steps |
| `client-policy\login` | The network-restricted deployment only; it does not work with this gateway |

The folders are described in scripts/admin/new-client-policy.mjs:1-16. `New-IntunePackage.ps1` is copied to the top of
the folder.

The admin console downloads the same folder, without the repository or Node.js: **Settings** > **Client onboarding**
> a model > **Download client kit (.zip)**, or a single file from the buttons below it
([Use the admin console](how-to-use-admin-console.md)). The zip, extracted, is the `client-policy` folder these
steps use.

![Settings > Client onboarding: the model, Download client kit (.zip), and the single-file buttons ClaudeDesktop-HKLM.reg, Set-ClaudeDesktopPolicy.ps1 (Intune), DESKTOP.txt and INTUNE.txt.](media/admin-console-client-kit.png)

### One machine

The administrator gives the developer the `client-policy\developer` folder, for example as a zip file on a file share;
it holds the scripts and `START-HERE.txt`, the same steps in plain text. The developer needs a network inside `$cidr`
and Claude Code: `winget install Anthropic.ClaudeCode` installs it, after which a new Windows PowerShell window finds
the `claude` command ([set up Claude Code](https://code.claude.com/docs/en/setup)). In Windows PowerShell, in the
folder:

```powershell
Set-Location <folder that holds Install-ClaudeGatewayProfile.ps1>
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeGatewayProfile.ps1 -GatewayUrl https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io -FastModel claude-sonnet-5 -Model claude-sonnet-5
```

The browser opens the gateway's page with a code; the developer checks that it matches the code PowerShell shows,
confirms it and signs in with the work account. Back in PowerShell, the script names the account and asks to keep the
session; **Y** keeps it (scripts/developer/Connect-ClaudeGateway.ps1:63-79):

```output
Signed in to https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io as dev@contoso.com. Get-ClaudeGatewayToken.ps1 now serves tokens for this gateway.
```

`-Model` sets the model Claude Code asks for, and `-FastModel` the one for background tasks; both are models the
developer's role allows. Without `-Model`, Claude Code asks for its own default model, which a role that does not list
it refuses with HTTP 400 (docs/TEST-PLAN.md, T-88; [model configuration](https://code.claude.com/docs/en/model-config)).
A developer whose role allows more models chooses with `/model` in Claude Code.

From then on the launcher starts Claude Code through the gateway:

```powershell
& "$env:USERPROFILE\.claude-apps-gateway\claude-gateway.cmd"
```

Each message the profile can show, and its fix, is in
[Quickstart: connect Claude Code on Windows](quickstart-developer.md).

### Many machines with Intune

Intune installs two Win32 apps on each machine: **Claude Code** itself, for every user of the device, and the
**gateway profile**, for the signed-in developer, without signing in, because Intune installs without showing anything
to the user ([add a Win32 app](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32)). The
Claude Code app downloads release 2.1.284 from Anthropic and installs it only when its SHA-256 matches the release's
(scripts/admin/intune-package.mjs:17-20). The devices are Windows 10 or 11 Enterprise, Pro or Education, joined or
registered to Entra ID and enrolled in Intune
([Win32 app prerequisites](https://learn.microsoft.com/en-us/intune/app-management/deployment/create-win32-package#prerequisites)).

1. The [Microsoft Win32 Content Prep Tool](https://go.microsoft.com/fwlink/?linkid=2065730) link opens its GitHub
   repository; **Code** > **Download ZIP**, extracted to `C:\tools\prep`, gives
   `C:\tools\prep\Microsoft-Win32-Content-Prep-Tool-master\IntuneWinAppUtil.exe`; `-ToolPath` names that file.
1. Package the two app folders. The script runs the tool once per app and prints the two files it wrote
   (scripts/admin/New-IntunePackage.ps1:40-47):

   ```powershell
   pwsh -File scripts/admin/New-IntunePackage.ps1 -PolicyFolder .\client-policy -ToolPath C:\tools\prep\Microsoft-Win32-Content-Prep-Tool-master\IntuneWinAppUtil.exe -OutputFolder .\intunewin
   ```

   ```output
   C:\...\intunewin\Install-ClaudeCode.intunewin
   C:\...\intunewin\Install-Profile.intunewin
   ```
1. In the [Microsoft Intune admin center](https://intune.microsoft.com), **Apps** > **All Apps** > **Create** >
   **Windows app (Win32)** > **Select**, then **Select app package file** > `Install-ClaudeCode.intunewin` > **OK**.
   Then the values for **App 1** in the table below, page by page, and **Create**.
1. Create a second app the same way from `Install-Profile.intunewin`, with the values for **App 2**.
1. Intune assigns apps to Entra groups of users or devices. A security group of developers, such as `Claude Code
   pilot`, is created in the Microsoft Entra admin center under **Groups** > **New group**, which needs the Groups Administrator
   role or a tenant that lets users create security groups
   ([create a group](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-groups)). On each app's
   **Assignments** page, in the creation wizard or later under the app's **Properties** > **Assignments** > **Edit**,
   **Required** > **Add group** > that group. After the pilot machines report **Installed** under
   the app's **Device install status**, a group of every developer who holds a gateway role is added the same way. The
   gateway role itself is given as in [Give developers access](#give-developers-access); without Entra ID P1 or P2 it is
   given per user, so the Intune group and the role holders are two lists, kept with the same people.

| Intune page and field | App 1: Claude Code | App 2: gateway profile |
|---|---|---|
| **App information** > **Name** and **Publisher** | `Claude Code`, `Anthropic` | `Claude Code gateway profile`, your organization |
| **Program** > **Install command** | `%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeCode.ps1` | `%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Profile.ps1` |
| **Program** > **Uninstall command** | The same, with `.\Uninstall-ClaudeCode.ps1` | The same, with `.\Uninstall-Profile.ps1` |
| **Program** > **Install behavior** | **System** | **User** |
| **Requirements** > **Operating system architecture** (**Allow on x64** in newer pages) | x64; the package holds the `win32-x64` release, so Arm devices get nothing | x64 |
| **Requirements** > **Minimum operating system** | Windows 10 1809, the oldest Claude Code supports ([requirements](https://code.claude.com/docs/en/setup)) | Windows 10 1809 |
| **Detection rules** | **Manually configure detection rules** > **Add** > **File**: path `%ProgramFiles%\Anthropic\ClaudeCode`, file `claude-code-2.1.284.installed`, the release marker the install writes, **File or folder exists**, **Associated with a 32-bit app on 64-bit clients**: **No** | **Use a custom detection script** > `Detect-Profile.ps1` from `client-policy\intune\2-gateway-profile`; **Run script as 32-bit process on 64-bit clients**: **No**; **Enforce script signature check**: **No** |
| **Dependencies** | None | **Add** > App 1, **Automatically install**: **Yes** |

App 2 runs with `-ReplaceGateway`, so on a machine whose `.claude-apps-gateway` profile pointed at another gateway it
then points at this one.

The `Sysnative` path runs 64-bit Windows PowerShell, as Intune's documentation gives for an install command; the
detection script reports the app as installed by writing to its output and exiting 0
([program and detection settings](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32#step-2-program)).
The same values are in `client-policy\intune\INTUNE.txt` with the gateway address filled in. During the install, the
device, as the SYSTEM account, reaches `https://downloads.claude.ai`, directly or through a proxy that asks for no user
sign-in, where Anthropic publishes Claude Code
([network access](https://code.claude.com/docs/en/network-config#network-access-requirements)).

Intune shows the developer nothing, so the administrator sends each developer a message once the app reports
**Installed** for them, for example:

```text
Claude Code is installed on your PC and connects through the company gateway. You have been given access.
On the company network, open Windows PowerShell and run once:
  & "$env:USERPROFILE\.claude-apps-gateway\sign-in.cmd"
Check that the code in the browser matches the one in PowerShell, sign in with your work account, and answer Y.
From then on, start Claude Code with:
  & "$env:USERPROFILE\.claude-apps-gateway\claude-gateway.cmd"
```

The same steps are in `client-policy\intune\INTUNE.txt` (scripts/admin/intune-package.mjs:224-227). The sign-in is the
one in [One machine](#one-machine). The two commands:

```powershell
& "$env:USERPROFILE\.claude-apps-gateway\sign-in.cmd"
& "$env:USERPROFILE\.claude-apps-gateway\claude-gateway.cmd"
```

On 2026-10-25 the two `.intunewin` files were built with `New-IntunePackage.ps1` and the Content Prep Tool, the Claude Code app installed release
2.1.284 with a matching checksum, and the profile app, run as a user against this project's gateway, wrote the profile
and a `sign-in.cmd` that started a gateway sign-in (docs/TEST-PLAN.md, T-120). The apps have not yet been assigned in
an Intune tenant (docs/UNKNOWNS.md, U-107). The Claude Code app installs one release under Program Files, 2.1.284 unless another is chosen
(scripts/admin/intune-package.mjs:17-20), which the developer starts only through the launcher and which does not update
itself, because the profile app sets `DISABLE_UPDATES` ([environment variables](https://code.claude.com/docs/en/env-vars));
[Package a newer Claude Code release](#package-a-newer-claude-code-release) replaces it. A change of `--model` is
checked against the models each role allows before the profile package is rebuilt. `--fast-model` and `--model` on `new-client-policy.mjs` name models the
admin file keeps.

### Claude Desktop

Claude Desktop reads the gateway address from the device policy `bootstrapUrl` under
`HKLM\SOFTWARE\Policies\Claude`, set to `<gateway address>/user/bootstrap`, and signs in on its own
([connect Claude Desktop](https://code.claude.com/docs/en/claude-apps-gateway#connect-claude-desktop)). In Intune a
**Platform script** in system context writes that value
([Connect clients](how-to-connect-clients.md#deliver-the-policy-with-intune-or-group-policy)). The client-policy
folder's `desktop` folder holds that script, `Set-ClaudeDesktopPolicy.ps1`, the same value as `ClaudeDesktop-HKLM.reg` for
one machine, and `DESKTOP.txt` with each Intune setting, including **Run script in 64-bit PowerShell host**: **Yes**;
the script stops with exit code 1 in a 32-bit host, which would write the value where Desktop does not read it
(scripts/admin/desktop-policy.mjs:15-35). Desktop signs in to this public
gateway with its own device code, separate from the Claude Code profile, for a developer whose role's policy turns
Desktop on: `Gateway.Premium` in the example admin file (docs/UNKNOWNS.md, U-106). A role's Chat, Cowork and Code
switches are set with `desktopSettings` on its policy in the admin file
([configure models, roles and developer access](how-to-admin-configure.md#claude-desktop-chat-cowork-and-code)); Desktop
applies the gateway's values over local settings.

### When Intune reports Failed or Not detected

The Intune Management Extension checks for new and changed Win32 apps every 8 hours; **Devices** > the device > **Sync**
in the Intune admin center, or **Sync** in the Company Portal app, starts a check sooner
([Intune Management Extension](https://learn.microsoft.com/en-us/intune/device-management/tools/management-extension-windows);
[sync a device](https://learn.microsoft.com/en-us/intune/device-management/actions/sync)). Each app's **Device install
status** page names the device; a failed install script reports exit code 1 for every
cause, so the cause is in the scripts' own logs on the device, which the scripts write because Intune keeps neither
their output nor their errors (scripts/admin/intune-package.mjs:32-33):

| App | Log on the device |
|---|---|
| App 1, Claude Code | `%ProgramFiles%\Anthropic\ClaudeCode\install-claude-code.log` |
| App 2, gateway profile | `%LOCALAPPDATA%\ClaudeAppsGateway\install-profile.log` of the developer |

Intune's own record of each Win32 app install is `AppWorkload.log` in
`%ProgramData%\Microsoft\IntuneManagementExtension\Logs`
([Intune Management Extension](https://learn.microsoft.com/en-us/intune/device-management/tools/management-extension-windows)).

| Log line | Cause | What fixes it |
|---|---|---|
| `failed:` with a download or connection error | The device, as SYSTEM, cannot reach `downloads.claude.ai` | The network or proxy lets the device reach it without a user sign-in |
| `failed: The download has checksum ...` | The package's checksum is not the release's `win32-x64` checksum, or the network altered the download | `--claude-checksum` is the `win32-x64` value of the same `--claude-version`, and the network passes the download unchanged; nothing was installed |
| `failed: Claude Code is running (...)` | A newer release was installing while Claude Code was open | Intune retries the install; it succeeds once Claude Code is closed |
| `failed: Install-ClaudeGatewayProfile: ...` | The profile script refused; the rest of the line is its message | The message's row in [Troubleshoot the developer profile](troubleshoot.md#installer-and-launcher-messages) |
| `failed: Claude Code was not found` | App 2 ran before App 1 | App 2's dependency on App 1, with **Automatically install**: **Yes** |
| App 2 **Not detected**, with `installed the profile` in its log | The detection script ran for another user | **Install behavior** of App 2 is **User** |

To run a script by hand on a test device, the app's folder from `client-policy\intune` is copied to the device, then
run from it in Windows PowerShell: App 1 in a window opened with **Run as administrator**, because it writes to
Program Files, and App 2 as the developer, for example
`powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeCode.ps1`.

### Package a newer Claude Code release

Anthropic publishes each release's checksums in its manifest. This command prints the Windows checksum of a release:

```powershell
$version = '<release, for example 2.1.290>'
(Invoke-RestMethod "https://downloads.claude.ai/claude-code-releases/$version/manifest.json").platforms.'win32-x64'.checksum
```

`new-client-policy.mjs` writes the Intune folder for that release with `--claude-version` and `--claude-checksum`
(scripts/admin/new-client-policy.mjs:15), with the same gateway address and models as before and `--force` to write into
the existing folder; without `--model` it warns, because the profile app would then pin no model:

```powershell
node scripts/admin/new-client-policy.mjs --gateway-url https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io --fast-model claude-sonnet-5 --model claude-sonnet-5 --claude-version $version --claude-checksum <checksum> --out .\client-policy --force
pwsh -File scripts/admin/New-IntunePackage.ps1 -PolicyFolder .\client-policy -ToolPath C:\tools\prep\Microsoft-Win32-Content-Prep-Tool-master\IntuneWinAppUtil.exe -OutputFolder .\intunewin
```

Then, in the Intune admin center,
App 1 > **Properties**: **App information** > **Edit** > **Select file to update** > the new `Install-ClaudeCode.intunewin`;
**Detection rules** > **Edit** > the file `claude-code-<release>.installed` > **Review + save**. Devices with the older
release no longer match the rule, so Intune installs the new one
([edit a Win32 app](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32)).

## Check that it works

A developer machine sends one request through the gateway:

```powershell
& "$env:USERPROFILE\.claude-apps-gateway\claude-gateway.cmd" -p "Reply with exactly the word: ok"
```

```output
ok
```

The console's **Dashboard** then shows the request's spend, the sum of the gateway's per-user totals
(admin-ui/web/app.js:33), and **Chargeback** lists it by department ([Use the admin console](how-to-use-admin-console.md)). On the Contoso deployment, `claude -p` calls through the gateway
answered in 3.7 to 4.0 seconds (docs/TEST-PLAN.md, T-116).

## Run the installer again later

A later run, such as widening the range or renewing the sign-in secret, happens in a new PowerShell 7 window in the
repository folder that holds the state file, so it signs in and sets the values again first:

```powershell
az login
az account set --subscription "<subscription name or ID>"
$rg = 'rg-claude-gw-eval'
$foundryRg = '<resource group of your Foundry account>'
$foundry = '<name of your Foundry account>'
$admins = az account show --query user.name -o tsv
```

The run needs the account that installed, which owns the gateway's app registration, or an Application Administrator,
because the `app` stage adds and removes the registration's client secrets
([Application Administrator](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#application-administrator)).

### Widen the address range

The install command with the company block replaces the range on the gateway and the console
(infra/azure-test/Install-ClaudeGateway.ps1:150-159):

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -TesterCidr 198.51.100.0/26 -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -SignInAdmins $admins -ClientSecretDays 30 -Steps app,admin-ui
```

`198.51.100.0/26` is a documentation range; the command takes the company block. `-SignInAdmins $admins` also makes the
account that runs it a console administrator, if it is not one already. The stage then checks the gateway from
this machine, so it runs from inside the new range. Before the Microsoft Graph grant is in place, the `admin-ui` stage
stops at the grant after the console's range is set, as in the install; the range change has applied by then.

## Keep the gateway's sign-in secret current

The values come from [Run the installer again later](#run-the-installer-again-later).

The gateway signs developers in with a client secret of its app registration, which ends `-ClientSecretDays` days after
it is created, 7 when the option is absent (infra/azure-test/lib/plan.mjs:92-93; infra/azure-test/deploy.mjs:276). Running the `app` stage again keeps a
secret with more than a day left (infra/azure-test/lib/plan.mjs:256-265); `-RotateClientSecret` creates a new one
whatever the end date. Existing sessions stay valid, because the session key is reused
(docs/adr/0003-azure-test-deployment-with-restricted-ingress.md:89-91). With 30-day secrets, this command every three
weeks, run in the folder that holds the state file, keeps sign-in working. It leaves out `-TesterCidr`, so the
recorded range stays. A reminder in a calendar keeps the interval; a scheduled task would need its own non-interactive Azure CLI sign-in:

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -ClientSecretDays 30 -RotateClientSecret -Steps app
```

The output includes `added client secret <id>; it ends <date>`. On the managed database, a gateway whose outbound
address changed answers `/readyz` with 503 until `node scripts/admin/sync-database-firewall.mjs --resource-group $rg`
runs ([troubleshoot](troubleshoot.md#gateway-and-admin-console)). The secret's end date is also under **App
registrations** > `claude-apps-gateway-eval` > **Certificates & secrets** in the Microsoft Entra admin center. After it
ends, sign-in fails and Entra reports `AADSTS7000222`, an expired client secret
([Microsoft Entra error codes](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes)); the
same command restores it.

The stage ends by checking the gateway from this machine, so it runs from inside the range. From outside, it ends with
`the gateway is ready, but this machine gets 403`; the secret is renewed by then, and the range stays as it is.

## Update the gateway's Claude Code release

The gateway image pins one Claude Code release, `CLAUDE_VERSION` and `CLAUDE_SHA256` in
infra/azure-test/image/Dockerfile:8-9, separately from the release the Intune package installs on developer machines.
The Dockerfile is a tracked file; the build reads the edited file without a commit, and a later `git pull` reports the
local change.
A newer release is set there, with its Linux checksum from the manifest,
`(Invoke-RestMethod "https://downloads.claude.ai/claude-code-releases/$version/manifest.json").platforms.'linux-x64'.checksum`, and the
install command with `-Steps image,app`, without `-TesterCidr`, builds and deploys it
([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)), with the values from
[Run the installer again later](#run-the-installer-again-later):

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -ClientSecretDays 30 -Steps image,app
```

 The gateway's live output is on the Container App
`ca-claude-gw` > **Monitoring** > **Log stream** in the Azure portal, and its history in the resource group's Log
Analytics workspace, table `ContainerAppConsoleLogs_CL` (docs/UNKNOWNS.md, U-98); this query lists the latest
lines ([Container Apps logs](https://learn.microsoft.com/en-us/azure/container-apps/log-monitoring)):

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == 'ca-claude-gw'
| project TimeGenerated, Log_s
| order by TimeGenerated desc
| take 50
```

The deployment sets up no alerts; an alert on these logs or on the secret's end date is created separately in Azure
Monitor ([log search alerts](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-create-log-alert-rule)).
The console's **Dashboard** shows spend, and [troubleshoot](troubleshoot.md#gateway-and-admin-console) lists the
gateway's messages.

## Clean up resources

With Intune, each app's **Required** assignment is first changed to **Uninstall**, so devices remove them while the
gateway still answers the profile's sign-out, and the apps are deleted under **Apps** > **All Apps** once the devices
report it, App 2 before App 1, which it depends on;
then the developer group is deleted under **Groups** in the Microsoft Entra admin center.

The teardown script removes the gateway's role on the Foundry account, its app registration and the resource group;
`--dry-run` lists them first (infra/azure-test/teardown.mjs:1-4). It reads the record the install wrote in
`infra/azure-test/.state/`, so it runs on the machine and in the folder that ran the install:

```powershell
node infra/azure-test/teardown.mjs --resource-group $rg --dry-run
node infra/azure-test/teardown.mjs --resource-group $rg
```

The admin console's sign-in app registration, `claude-apps-gateway-eval-admin-ui-signin`, is removed in the Microsoft
Entra admin center under **App registrations**. The local `client-policy`, `intunewin` and `infra\azure-test\.state` folders and any copy of the state
file are deleted after the teardown. On a developer machine, the profile is removed as
[the quickstart's clean-up](quickstart-developer.md#clean-up-resources) describes.

## Next steps

- [Use the admin console](how-to-use-admin-console.md)
- [Manage users, groups and budgets](how-to-manage-users-and-groups.md)
- [Install the Claude apps gateway, stage by stage](how-to-install-stage-by-stage.md)
- [Troubleshoot the developer profile](troubleshoot.md)
