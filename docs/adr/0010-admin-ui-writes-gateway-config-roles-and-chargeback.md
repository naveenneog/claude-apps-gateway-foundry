# ADR-0010: admin-ui edits the gateway configuration, creates app roles and reports chargeback

- **Status:** Accepted; with sign-in on, reads also need `AdminUi.Admin` since ADR-0011
- **Date:** 2026-10-24
- **Packet:** P-35
- **Deciders:** owner (request: "Lets go ahead and build these for the admin ui", after asking which features admin-ui
  lacks, which permissions they need, whether a group cap is per user, and whether users can be tagged to a business
  unit for a chargeback report), agent
- **Extends:** ADR-0008, which limited admin-ui to the gateway's spend-limits API and Entra role assignment

## Context
ADR-0008 kept admin-ui to the two administrative surfaces that have a runtime API: spend limits (the gateway's admin
API) and developer roles (Microsoft Graph). Everything else an operator changes after installation needs a terminal
and this repository:

| Change | Where it lives | How it changes today |
|---|---|---|
| Models, a role's models, a role's Claude Desktop access | `gateway.yaml`, the gateway app's `gateway-config` secret, read once at startup | Edit the admin file, render with `scripts/admin/new-gateway-config.mjs`, replace the secret, start a new revision |
| A new role | The Entra app registration's `appRoles`, then the admin file | Entra portal **App roles**, then the admin file (U-83) |
| Spend per business unit | Nowhere | The gateway's `/effective` lists spend per user only; nothing joins it to an organizational unit |

Facts this decision rests on:

- The Contoso gateway's live `gateway-config` secret, `config/gateway.azure-contoso.yaml` and
  `renderGatewayConfig(config/gateway-admin.azure-contoso.json)` are byte-identical (checked 2026-10-24), so admin-ui
  can render the same file the repository does.
- `az containerapp secret set` reads the app, merges values from `listSecrets`, writes the whole app back with a PUT,
  and warns that the app must restart for a secret change to take effect (`set_secrets` in
  `src/azure-cli/azure/cli/command_modules/containerapp/custom.py`, azure-cli `dev`, read 2026-10-24; U-85).
- The built-in **Container Apps Contributor** role (`358470bc-b998-42bd-ab17-a7e34c199c0f`) grants
  `Microsoft.App/containerApps/*/read|write|action` and `managedEnvironments/join/action`, read live with
  `az role definition list` on 2026-10-24.
- `/effective` keys a user by the OIDC `sub`, which Entra issues per application, not the user's object ID; the live
  row for the Contoso developer has `user_id` `WR3H…` and `actor.email_address` set to the UPN (U-90). It reports the
  current period only (U-89).
- A group or organization cap is a per-member default, not a shared pool
  (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits, "Set a cap").
- Container Apps authentication injects `X-MS-CLIENT-PRINCIPAL*` headers, and "External requests aren't allowed to set
  these headers" (https://learn.microsoft.com/en-us/azure/container-apps/authentication, read 2026-10-24; U-87).

## Options considered
1. **Keep ADR-0008's scope; document the terminal steps.** No new privilege. Operators without the repository cannot
   add a model or a role, and no chargeback view exists.
2. **admin-ui writes the configuration through Azure Resource Manager, behind admin sign-in.** One new Azure role
   (Container Apps Contributor on the gateway app only) and one new Graph permission (`Application.ReadWrite.OwnedBy`
   with admin-ui as an owner of the gateway's app registration). The same validator and renderer the repository uses.
3. **admin-ui opens a pull request; a pipeline deploys it.** Keeps every change in review. Needs a GitHub credential
   in admin-ui and a deployment pipeline this repository does not have.

## Decision
Option 2, with these rules:

- **One renderer.** admin-ui calls `adminErrors` and `renderGatewayConfig` from `scripts/admin/new-gateway-config.mjs`
  unmodified. An invalid admin file is refused before any Azure call.
- **The live admin file is stored next to the configuration.** The gateway app gains a `gateway-admin-file` secret,
  written in the same PUT as `gateway-config`, so the two cannot disagree. admin-ui reads it first and falls back to
  the file it was deployed with. The SHA-256 version of the admin file refuses a stale client edit with 409. The
  full-resource PUT carries the ARM ETag in `If-Match` when ARM returns one (412 is a conflict). Container Apps returns none
  (U-94, amended 2026-10-25), so admin-ui reads the app again just before the PUT and answers 409 if its lastModifiedAt or
  latest revision moved; neither field present refuses the write. This narrows, not closes, the race to that gap.
- **Rollout is a new revision, not a restart.** The same PUT sets `CONFIG_UPDATED_AT` on the container that mounts
  `gateway-config`, so Container Apps starts a new revision and moves traffic only when it is ready. A configuration
  the gateway rejects leaves the previous revision serving.
- **A temporary database needs an explicit acknowledgement (U-92).** When any container of the gateway app mounts an
  `EmptyDir` volume, as the test and Contoso topologies' in-app PostgreSQL does, a new revision starts with an empty
  database. admin-ui reports this (`restart.temporaryDatabase`) and refuses the write with 428 unless the request
  carries `acknowledgeDataLoss: true`. The private topology's managed PostgreSQL is unaffected.
- **Git stays the record.** admin-ui shows when the live admin file differs from the deployed one, and offers it as a
  download to commit. `deploy.mjs --step app` already refuses to run while the app holds a secret its template does
  not define (T-95), so it names `gateway-admin-file` rather than silently reverting a change made in admin-ui.
- **Writes need admin sign-in.** The routes that change the configuration, create a role or tag a user answer 403
  unless Container Apps authentication is on (`ADMIN_UI_SIGN_IN=required`, set by the same deployment that turns
  authentication on) and the signed-in user holds the admin-ui app's `AdminUi.Admin` role. The principal headers are
  ignored when sign-in is off, because without the platform's authentication a client can set them itself.
- **Roles:** admin-ui adds an enabled app role to the gateway's app registration with a PATCH of the full `appRoles`
  list. It does not disable or delete roles.
- **Chargeback:** admin-ui reads every `/effective` row for one period, looks up each user in Microsoft Graph by
  `actor.email_address`, and groups spend by an Entra user attribute (`department`, `companyName`, `officeLocation`,
  `employeeOrgData.costCenter`, `employeeOrgData.division`) or by gateway role. Users with no recorded email, or not
  found, are reported as unresolved, not dropped. Amounts are the gateway's list-price estimates. CSV cells that begin
  with `=`, `+`, `-` or `@` are prefixed with `'` (spreadsheet formula injection).
- **Business-unit tagging** writes `department` or `employeeOrgData.costCenter` on the Entra user. It needs
  `User.ReadWrite.All`, which can change any user's profile, so `Deploy-AdminUi.ps1` grants it only with
  `-GrantUserWrite`; without it the page shows the attribute read-only.
  **Amended by ADR-0015 (2026-10-27):** department, company, office, cost center and division are tags in the gateway's
  managed PostgreSQL, set in the console; admin-ui no longer reads them from Entra or writes Entra, and
  `User.ReadWrite.All` and `-GrantUserWrite` are removed. Gateway role grouping is unchanged.
- **Permissions view:** admin-ui reports what it can do from its own tokens: the Graph token's `roles` claim and the
  ARM permissions API on the gateway app (U-88).

## Consequences
- admin-ui's identity can read every secret of the gateway app, including the cross-tenant Foundry client secret,
  because `listSecrets` is needed to write the app back. admin-ui never returns a secret value from its API, and the
  role is scoped to the gateway app, not the resource group.
- An operator who changes the configuration in admin-ui and then runs the installer's `app` stage is stopped by the
  existing guard until the downloaded admin file is committed and the secret is removed or the template defines it.
- Chargeback covers the current period only; a month that has ended is no longer available from `/effective` (U-89).
  A month-end export or snapshot job is a ROADMAP "Later" item.
- A Foundry model deployment is still created outside admin-ui; admin-ui maps an existing deployment name to a model.
- On a topology with in-app PostgreSQL, every saved change resets spend totals, caps and the audit trail; caps are set
  again afterwards (`scripts/admin/bootstrap-budgets.mjs`). Persistent storage for that PostgreSQL is a ROADMAP
  "Later" item.
- Without sign-in, `/api/developers` keeps ADR-0008's behaviour (granting a role needs only network access to
  admin-ui). With sign-in on, granting or removing a developer role also needs `AdminUi.Admin`.

## Amendment, 2026-10-25: Container Apps returns no ETag

A live `GET` of the Contoso gateway app on API versions 2024-03-01, 2025-01-01 and 2025-07-01 returned no `etag`
property and no `ETag` header, so the original rule ("a missing ETag refuses the write") refused every save with 502.
T-106 found this on its first live run. admin-ui now sends `If-Match` only when ARM returns an ETag. Without one, it
reads the app again immediately before the PUT and refuses with 409 when `systemData.lastModifiedAt` or
`latestRevisionName` differs from the read the save started from; with neither an ETag nor `lastModifiedAt` it refuses
with 502. Saves in one admin-ui process run one at a time, so two admins saving together get one save and one 409
from the version check. A change landing between the second read and the PUT from outside admin-ui is still overwritten. Only the admin-ui console and an
operator's `az` or Bicep run write this app, so the residual window is accepted (U-94).

Sources: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2025-07-01/ContainerApps.json
(the `ContainerApp` definition has `extendedLocation`, `identity`, `managedBy`, `kind` and `properties`, and the file
never mentions `etag`; read 2026-10-25); live evidence in `docs/TEST-PLAN.md`, "Results — T-106 admin-ui live checks".
## Amendment, 2026-10-25: the test deployment's app step keeps what the console saved

A novice review of the first-install tutorial (P-39, T-121) found that once admin-ui has saved, `infra/azure-test/deploy.mjs
--step app` refused to run: the app then holds the `gateway-admin-file` secret and a `CONFIG_UPDATED_AT` variable that
`gateway-test.json` does not define, and the step refuses to delete settings it does not own (P-34, U-80). Client-secret
renewal, an address-range change and a database-region retry all need that step.

Options: (a) refuse, and tell the operator to stop using the console, which defeats this ADR; (b) deploy the repository's
admin file over the console's, which loses the console's edits; (c) when the app holds `gateway-admin-file`, deploy that
secret, the `CONFIG_UPDATED_AT` value and the `gateway-config` the console rendered, and print that the local file is
not deployed. Chosen: (c), in `templateForConsole` and `consoleConfig` (infra/azure-test/lib/plan.mjs:156-180). The
console remains the one writer of the configuration after its first save; settings added by hand are still refused. Live
check on Contoso, 2026-10-25: `--step app --what-if` no longer named the two console settings and still refused the
hand-added cross-tenant credential.
