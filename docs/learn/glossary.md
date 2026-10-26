---
title: Glossary for the Claude apps gateway on Azure
description: One-line definitions of the Azure, Microsoft Entra, Claude and repository terms used in the Claude apps gateway articles, each with a reference.
author: naveenneog
ms.date: 10/25/2026
ms.topic: reference
---

# Glossary

Each term is defined as these articles use it, with the page that defines it in full. The URLs were checked on
2026-10-25.

## Claude and the gateway

| Term | Definition | Reference |
|---|---|---|
| Claude Code | Anthropic's coding assistant. It runs in a terminal, in VS Code and in JetBrains IDEs, and sends prompts to Claude models. | https://code.claude.com/docs/en/overview |
| Claude apps gateway (the gateway) | A server shipped inside Claude Code (`claude gateway`). It signs developers in through an OpenID Connect provider, applies each role's model access and spend caps, and forwards requests to a model provider such as Microsoft Foundry. | https://code.claude.com/docs/en/claude-apps-gateway |
| `gateway.yaml` | The gateway's configuration file. This repository renders it from the admin file and stores it as the Container App secret `gateway-config`. | https://code.claude.com/docs/en/claude-apps-gateway-config |
| Admin console | This repository's web page for spend caps, developer access, models and chargeback, titled **Claude apps gateway - Foundry · Admin console** and deployed as the Container App `ca-admin-ui`. | [Use the admin console](how-to-use-admin-console.md) |
| Spend cap (budget) | A USD limit per day, week or month on the gateway's estimated spend, for one user, one role or the whole organization. Over the cap, the gateway refuses requests. | https://code.claude.com/docs/en/claude-apps-gateway-spend-limits |
| `rbac_group` scope | The spend-cap scope for everyone who holds one gateway role. Its value is an app role value such as `Gateway.Standard`; it is not an Azure RBAC role and not an Entra security group. | https://code.claude.com/docs/en/claude-apps-gateway-spend-limits |
| Business unit | In the admin console, a user's Entra `department` attribute, or the cost center, used to group spend for chargeback. | https://learn.microsoft.com/en-us/graph/api/resources/user |
| Chargeback | A report of gateway spend grouped by business unit, cost center or role, for billing internal teams. | [Use the admin console](how-to-use-admin-console.md) |
| Client kit | The files a developer machine needs for this gateway, from `new-client-policy.mjs` or the admin console's **Settings** > **Client onboarding**: `developer`, `intune`, `desktop` and `login` folders. | [Tutorial: onboard developers](tutorial-first-install.md#onboard-developers) |
| Admin file | The JSON file in `config/` that lists the admitted roles, the models, each role's models and spend caps. The scripts render it into `gateway.yaml`. | [Install, stage by stage](how-to-install-stage-by-stage.md#the-admin-file) |
| State file | `infra/azure-test/.state/<resource group>.json`, written by the installer with the names, IDs and address range of what it created, and read by later stages and scripts. | [Tutorial: run the installer again later](tutorial-first-install.md#run-the-installer-again-later) |
| Developer profile | The separate Claude Code configuration folder `%USERPROFILE%\.claude-apps-gateway` that the developer quickstart installs. | [Quickstart](quickstart-developer.md) |
| Managed settings | Claude Code settings an administrator delivers through a file, the registry or device management, which users cannot override. They carry the gateway URL. | https://code.claude.com/docs/en/settings |
| Launcher | `claude-gateway.cmd` in the developer profile folder. It starts Claude Code with the profile, so its requests go through the gateway. | [Quickstart](quickstart-developer.md) |
| `AdminUi.Admin` | The app role on the admin console's own sign-in application that lets an account open the console. The installer gives it to the people named in `-SignInAdmins`. | [Use the admin console](how-to-use-admin-console.md) |

## Azure

| Term | Definition | Reference |
|---|---|---|
| Microsoft Foundry | Azure's service for deploying and calling AI models, Claude models included. | https://learn.microsoft.com/en-us/azure/ai-foundry/what-is-azure-ai-foundry |
| Model deployment | A named instance of a model in a Foundry account; the admin file's `deployment` field names it. | https://learn.microsoft.com/en-us/azure/developer/ai/how-to/deploy-claude-foundry |
| Azure Container Apps | An Azure service that runs containers without managing servers. The gateway and the admin console each run as one Container App. | https://learn.microsoft.com/en-us/azure/container-apps/overview |
| Container Apps environment | The boundary around a group of Container Apps that share a virtual network and logging. | https://learn.microsoft.com/en-us/azure/container-apps/environment |
| Revision | An immutable version of a Container App. A change to the app's template, such as the image or an environment variable, starts a new revision; a change to a secret does not, and running revisions read the new value only after a restart. | https://learn.microsoft.com/en-us/azure/container-apps/revisions#change-types |
| Ingress | A Container App's HTTPS entry point and its rules, such as which address ranges may connect. | https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview |
| IP restrictions | Ingress rules that allow or deny address ranges. A denied caller gets HTTP 403 with the body `RBAC: access denied`. | https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions |
| CIDR range | An address range written as address/prefix length: `203.0.113.0/26` covers 64 addresses and `/32` one address. `203.0.113.0/26` is a documentation range that admits nobody. | https://www.rfc-editor.org/rfc/rfc4632 |
| Tester range | The public CIDR range from which a test deployment accepts connections, given to the installer as `-TesterCidr`. | [Install, stage by stage](how-to-install-stage-by-stage.md#run-the-installer) |
| Built-in authentication (Easy Auth) | Container Apps sign-in that the platform handles before a request reaches the app. The admin console uses it when deployed with `-EnableSignIn`. | https://learn.microsoft.com/en-us/azure/container-apps/authentication |
| Managed identity | An Entra identity that Azure gives a resource, so the resource calls other Azure services without a stored key. The gateway calls Foundry with one. | https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview |
| Azure RBAC | Azure role-based access control for Azure resources, with roles such as Owner and Contributor. It is separate from Entra app roles and from the gateway's `rbac_group` scope. | https://learn.microsoft.com/en-us/azure/role-based-access-control/overview |
| Azure Container Registry | Azure's private store for container images; the gateway and admin console images are built there. | https://learn.microsoft.com/en-us/azure/container-registry/container-registry-intro |
| Azure Database for PostgreSQL flexible server | The managed database that stores the gateway's sessions, rate-limit counters and spend in the network-restricted deployment, and in the test deployment when the admin file sets `deployment.database: "managed"`. | https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/overview |
| Log Analytics workspace | The Azure Monitor store that receives the gateway's console log and audit events. | https://learn.microsoft.com/en-us/azure/azure-monitor/logs/log-analytics-overview |

## Microsoft Entra ID

| Term | Definition | Reference |
|---|---|---|
| Microsoft Entra ID | Microsoft's identity service. Developers and administrators sign in with their Entra work accounts. | https://learn.microsoft.com/en-us/entra/fundamentals/whatis |
| App registration | The Entra definition of an application: its sign-in settings, secrets and app roles. | https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals |
| Enterprise application (service principal) | The tenant's instance of an app registration, where users and groups are assigned to roles. | https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals |
| App role | A named permission defined on an app registration and assigned to users or groups, such as `Gateway.Standard`, `Gateway.Premium` and `AdminUi.Admin`. The gateway admits only users whose token carries one of its roles. | https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps |
| Microsoft Graph application permission | A tenant-wide permission that an application or managed identity holds to call Microsoft Graph without a signed-in user. Granting one needs a Privileged Role Administrator or Global Administrator. | https://learn.microsoft.com/en-us/graph/permissions-overview |
| Entra directory role | A tenant-wide administrator role such as Global Administrator, Privileged Role Administrator or Application Administrator. | https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference |
| OpenID Connect (OIDC) | The sign-in protocol the gateway uses with Entra ID. The OIDC subject (`sub`) is the user's stable identifier in the token. | https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc |
| Device code sign-in | A sign-in in which the client shows a short code and the user confirms it in a browser. The developer scripts use the gateway's own device code page, which then signs the user in to Entra ID. | https://code.claude.com/docs/en/claude-apps-gateway |
| Privileged Role Administrator | The Entra directory role that grants Microsoft Graph application permissions, such as the four the admin console needs. | https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#privileged-role-administrator |

## Microsoft Intune

| Term | Definition | Reference |
|---|---|---|
| Microsoft Intune | Microsoft's device-management service: it installs apps and applies settings on enrolled Windows devices. | https://learn.microsoft.com/en-us/intune/intune-service/fundamentals/what-is-intune |
| Win32 app | An Intune app type for a Windows program installed by a command line, such as the two apps that install Claude Code and the developer profile. | https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32 |
| `.intunewin` file | The package Intune uploads for a Win32 app, made from a folder by the Microsoft Win32 Content Prep Tool (`IntuneWinAppUtil.exe`). | https://learn.microsoft.com/en-us/intune/app-management/deployment/create-win32-package |
| Install behavior | Whether a Win32 app installs for every user of the device (**System**) or for the signed-in user (**User**). | https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32#step-2-program |
| Detection rule | How Intune decides that a Win32 app is installed: a file that exists, a registry value, or a script that writes to its output. | https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32#step-4-detection-rules |
| Assignment | The Entra group an Intune app is given to; **Required** installs it without the user asking. | https://learn.microsoft.com/en-us/intune/app-management/deployment/assign-groups |

## Repository records

The ledger files are named in the repository's charter (docs/CHARTER.md:1).

| Term | Definition | Reference |
|---|---|---|
| ADR | Architecture decision record, in `docs/adr/`: the context, options and decision for one design choice. | [ADR-0003](../adr/0003-azure-test-deployment-with-restricted-ingress.md) |
| Packet (P-nn) | One work item in `docs/ROADMAP.md`, with acceptance criteria. | [ROADMAP](../ROADMAP.md) |
| U-nn, T-nn | A known unknown in `docs/UNKNOWNS.md`, and a test case in `docs/TEST-PLAN.md`. | [UNKNOWNS](../UNKNOWNS.md) |

## Related content

- [Overview](overview.md)
- [Troubleshoot](troubleshoot.md)
