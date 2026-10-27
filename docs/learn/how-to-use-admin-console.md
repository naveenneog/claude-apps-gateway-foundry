---
title: Use the admin console of the Claude apps gateway
description: Open the admin console, titled Claude apps gateway - Foundry, sign in with the AdminUi.Admin role, and use its pages for spend caps, developer access, models, chargeback, audit and client onboarding.
author: naveenneog
ms.date: 10/25/2026
ms.topic: how-to
---

# Use the admin console

The admin console is a web page titled **Claude apps gateway - Foundry · Admin console**
(admin-ui/web/index.html:29). It runs as the Container App `ca-admin-ui`, next to the gateway, and calls the
gateway's admin API for spend caps, Microsoft Graph for app roles, and Azure Resource Manager for the gateway
configuration (ADR-0008, ADR-0010; [spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)).
Terms are defined in the [glossary](glossary.md).

## Prerequisites

| Need | Detail |
|---|---|
| A deployed console | `Deploy-AdminUi.ps1` with `-EnableSignIn`, or the installer's `admin-ui` stage ([install, stage by stage](how-to-install-stage-by-stage.md#admin-ui)) |
| A network address inside the console's allowed range | The range given as `-AllowedCidr`. A caller outside it gets `RBAC: access denied` ([IP restrictions](https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions)) |
| The `AdminUi.Admin` app role | Assigned on the `<app registration>-admin-ui-signin` enterprise application. With sign-in required, every page except the health check needs it (ADR-0011) |
| The console's Microsoft Graph permissions | Needed by the Developers and Roles pages only; a Privileged Role Administrator or Global Administrator grants them once ([install, admin-ui](how-to-install-stage-by-stage.md#admin-ui)) |

## Open the console

1. In the Azure portal, open **Container Apps** > `ca-admin-ui` > **Overview** and copy **Application Url**
   ([Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)).
1. Open the URL in a browser on a machine inside the allowed range. The browser goes to the Microsoft Entra sign-in
   page ([Container Apps authentication](https://learn.microsoft.com/en-us/azure/container-apps/authentication)).
1. Sign in with the account that holds `AdminUi.Admin`. The **Dashboard** page opens.

An account with no assignment on the sign-in application is stopped by Microsoft Entra ID during sign-in with error
`AADSTS50105`, because `Deploy-AdminUi.ps1` requires an assignment on that application
(`admin-ui/infra/Deploy-AdminUi.ps1`, line 184). An account that is assigned but does not hold
`AdminUi.Admin`, or whose token does not carry the role, sees the page **No access to this console**, with the card
**AdminUi.Admin is required**, and no navigation (admin-ui/web/app.js:346-352; admin-ui/web/settings-view.js:73).

## Pages

Each description is the page's own header text.

| Page | What it does | Source |
|---|---|---|
| Dashboard | Spend the gateway has recorded this month, and the latest changes to spend caps. The spend is the gateway's list-price estimate, not the Foundry invoice. | admin-ui/web/app.js:23 |
| Budgets | Spend caps the gateway enforces for a user, a role or the whole organization. A change applies immediately. A user cap accepts an e-mail address or an OIDC subject; an e-mail address takes effect after that developer's first request. | admin-ui/web/app.js:120 |
| Chargeback | Spend per business unit, from the gateway's per-user totals and each user's business-unit tags (department, cost center, company, office, division) kept in the gateway database. The Business units card sets the tags; the report downloads as CSV. | admin-ui/web/chargeback-page.js:249 |
| Developers | People who hold a gateway app role in Entra ID. The role decides which models and apps they can use. | admin-ui/web/developers-page.js:12 |
| Roles | App roles on the gateway's Entra app registration. A developer needs an admitted role to use the gateway. A new role is not admitted until Access & models admits it. | admin-ui/web/roles-page.js:5 |
| Access & models | Which models each admitted role can use, and whether it can use Claude Desktop. A change is applied as a new gateway revision. | admin-ui/web/access-page.js:49 |
| Audit | Changes to spend caps, as the gateway records them. The latest 50 are shown. | admin-ui/web/audit-page.js:6 |
| Settings | What the console is allowed to do, and how to grant what is missing. The **Client onboarding** section downloads the client kit for a chosen model: the zip that `new-client-policy.mjs` writes for this gateway, or one of its files, such as `ClaudeDesktop-HKLM.reg` and the Intune platform script `Set-ClaudeDesktopPolicy.ps1`. It also gives the gateway profile command on a gateway with a public address, or `managed-settings.json` on the network-restricted gateway. | admin-ui/web/settings-page.js:4 |
| Help | How to do each administrator task in this console, and where the full guide is: departments, groups, console access, one machine, Intune, Claude Desktop, models, caps, the soft limit and chargeback. | admin-ui/web/help-page.js:5 |

## Common tasks

| Task | Page | Result |
|---|---|---|
| Give a developer access | **Developers** > user principal name and role (`Gateway.Standard` or `Gateway.Premium`) > **Grant role** | The developer signs in from Claude Code; the role decides the models ([manage users](how-to-manage-users-and-groups.md)) |
| Add a new model to a role | **Access & models** > **Add model**, with its Foundry deployment name > tick it for the role > **Review changes** > **Apply and roll out** | A new gateway revision serves it ([configure models](how-to-admin-configure.md)) |
| Raise a user's or a role's budget | **Budgets** > **Set cap** with the same scope, period and the new amount | Replaces the cap and applies on the next request; no revision ([spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)) |
| Pace the last part of a monthly cap | **Access & models** > **Soft limit** > switch on, set the share > **Review changes** > **Apply and roll out** | Past that share of a person's monthly cap, the spend pacer gives them a daily cap of the rest over the days left ([soft limit](how-to-admin-configure.md#pace-the-last-part-of-a-monthly-cap-with-a-soft-limit)) |
| Group spend by team | **Chargeback** > **Business units** > **Edit** a user's tags, or **Import CSV** > **Export CSV** | Spend per business unit, from the tags the console keeps in the gateway database; Entra ID is not changed. Tags need the managed database option ([group developers into departments](how-to-organize-departments.md)) |
| Onboard client machines | **Settings** > **Client onboarding** > a model > **Download client kit (.zip)** | The `developer`, `intune`, `desktop` and `login` folders for this gateway, with `New-IntunePackage.ps1` at the top; no separate `onboarding.json` (admin-ui/web/settings-page.js:57) |

Applying a change on **Access & models** starts a new gateway revision. With the in-app PostgreSQL sidecar, the test
topology's default, its database starts empty, so spend totals, caps and the audit trail reset, and the page asks for
confirmation first (admin-ui/server/gateway-config.mjs:187). With the managed database they are kept and the page
does not ask ([choose the database](how-to-install-stage-by-stage.md#choose-the-database)).

## Messages

[Troubleshoot: gateway and admin console](troubleshoot.md#gateway-and-admin-console) lists the messages, their causes
and fixes, including `RBAC: access denied` and **AdminUi.Admin is required** (ADR-0011,
docs/adr/0003-azure-test-deployment-with-restricted-ingress.md:1).

## Related content

- [Manage users, groups and budgets](how-to-manage-users-and-groups.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Glossary](glossary.md)
