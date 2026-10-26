# admin-ui

A web UI for the Claude apps gateway's own admin API (ADR-0008): spend-limit budgets and Entra developer-role
management. In the browser it is titled **Claude apps gateway - Foundry · Admin console**. Steps for opening it and
a description of each page are in [Use the admin console](../docs/learn/how-to-use-admin-console.md); terms are
defined in the [glossary](../docs/learn/glossary.md). Not a reimplementation of Claude Console's admin portal — the gateway's own documentation states its
scope plainly: "The gateway serves the spend-limits endpoints only"
([claude-apps-gateway-spend-limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)). There is no
gateway-side API for members, workspaces, invites or API keys; those are Claude Console concepts for Anthropic-hosted
accounts and do not apply to a self-hosted gateway whose developers sign in by Entra ID.

## What it does

- **Dashboard** — this month's spend per developer from the gateway's `/effective` endpoint: period-to-date spend,
  the cap that applies, and where that cap comes from (organization, role or user). The gateway calls the role
  scope `rbac_group`; its value is a gateway app role such as `Gateway.Standard`, not an Azure RBAC role and not an
  Entra security group. The spend is the gateway's
  list-price estimate, not the Foundry invoice
  ([spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)).
- **Budgets** — set, list and delete spend caps by organization, role (`rbac_group`) or user. A user cap accepts an
  e-mail address or an OIDC subject; an e-mail resolves to the subject only after that developer's first request
  (`/v1/organizations/spend_limits`), see the resolved per-principal spend (`/effective`), and the mutation trail
  (`/audit`).
- **Developers** — grant or remove the `Gateway.Standard`/`Gateway.Premium` Entra app roles, reusing
  `scripts/admin/set-developer.mjs` unmodified (`admin-ui/server/graph-client.mjs` is shaped exactly like
  `infra/azure-test/lib/azure-rest.mjs`'s `graph()`, so that script's logic runs against it without changes).
- **Access & models** (ADR-0010) — edits the gateway's admin file: models, each role's models and Desktop access. A
  save previews the change, renders `gateway.yaml` with the same renderer the deploy scripts use, and writes the
  `gateway-config` secret through Azure Resource Manager in one `PUT` of the container app, which starts a new
  revision ([Container Apps secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)). A save
  based on an older version answers 409, and so does one where the app changed between admin-ui's read and its write
  (Container Apps returns no ETag, so admin-ui compares `lastModifiedAt` and the latest revision; ADR-0010 amendment).
- **Roles** (ADR-0010) — lists the gateway registration's app roles and creates new ones (`PATCH` of the full
  `appRoles` list, [Graph update application](https://learn.microsoft.com/en-us/graph/api/application-update)).
- **Chargeback** (ADR-0010) — this period's spend from `/effective` per developer, joined to Entra users by e-mail and
  grouped by `department`, `companyName`, `officeLocation`, `costCenter`, `division` (the last two from
  `employeeOrgData`) or gateway role; downloadable as CSV with spreadsheet-formula cells neutralised
  ([OWASP CSV injection](https://owasp.org/www-community/attacks/CSV_Injection)). Tagging a user sets `department`
  and `employeeOrgData.costCenter` ([Graph user resource](https://learn.microsoft.com/en-us/graph/api/resources/user)).
  The **Business units** card lists every holder of a gateway app role, with or without spend, and their department
  (the business unit) and cost center. Editing a user's department to a new name creates that unit; the field offers
  the existing names. Groups that hold a role are listed by name only, because their members are not expanded.
- **Settings** — what the deployed identity can do (`/api/capabilities`), who is signed in (`/api/me`), and the client kit
  (`/api/client-kit`, P-41).
- **Help** — each administrator task with its steps in the console's labels and a link to its article
  (`web/help-topics.js`).

### Spend data on the test topology

With `deployment.database` absent or `"sidecar"`, the test topology's in-app PostgreSQL stores spend on an `EmptyDir`
volume, which a new revision starts empty
([Container Apps storage](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts)). Saving the
configuration there answers 428 until the request carries `acknowledgeDataLoss: true`; caps set through the admin API
are lost with it and `scripts/admin/bootstrap-budgets.mjs` sets the admin file's caps again (U-92). With
`deployment.database: "managed"`, the gateway uses a Flexible Server, a save keeps spend and caps, and no
acknowledgement is asked for (ADR-0012).

### Who can use it

| Sign-in | Who reaches the console | Who can change things |
|---|---|---|
| On (`-EnableSignIn`) | Users holding `AdminUi.Admin` on the `<app-registration>-admin-ui-signin` app. Anyone else who signs in sees an access-denied page, and every `/api` route except `/api/health` and `/api/me` answers 403 (ADR-0011) | The same users |
| Off (default) | Anyone in the `-AllowedCidr` range | Spend limits and developer roles: anyone in that range (ADR-0008). Configuration, roles and user tags: nobody (ADR-0010). `Deploy-AdminUi.ps1` prints a warning |

Every response carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer`; `/api` responses carry `Cache-Control: no-store`. A request body must be
`application/json` and at most 1 MiB, and a write marked `Sec-Fetch-Site: cross-site` is refused, because the
sign-in cookie is `SameSite=None` (U-95).

### Routes

With sign-in on, every route below also needs `AdminUi.Admin`.

| Route | Needs |
|---|---|
| `GET /api/health` | — (no sign-in) |
| `GET /api/me` | Sign-in only; reports the user, the roles received and `isAdmin` |
| `GET /api/capabilities` | — |
| `GET /api/gateway-config`, `POST /api/gateway-config/preview`, `GET /api/gateway-config/rollout` | `GATEWAY_RESOURCE_ID` |
| `PUT /api/gateway-config` | `AdminUi.Admin`, Container Apps Contributor on the gateway app |
| `GET /api/roles` / `POST /api/roles` | `Application.Read.All` / `AdminUi.Admin` and `Application.ReadWrite.OwnedBy` |
| `GET /api/chargeback?period=&groupBy=&format=csv` | `User.Read.All` |
| `GET /api/business-units` | `User.Read.All`, `Application.Read.All` |
| `PATCH /api/users/{email}` | `AdminUi.Admin` and `User.ReadWrite.All` |
| `GET`/`POST`/`DELETE /api/developers`, `/api/spend-limits…` | — beyond the sign-in rule above |

`AdminUi.Admin` is read from the `X-MS-CLIENT-PRINCIPAL` header Container Apps authentication adds
([Container Apps authentication](https://learn.microsoft.com/en-us/azure/container-apps/authentication)). With sign-in
off (`ADMIN_UI_SIGN_IN=off`) that header is ignored and every write route above answers 403.

## Architecture

`admin-ui/server/` is a framework-free `node:http` backend-for-frontend: `gateway-client.mjs` (fetch wrapper for the
gateway's admin API), `managed-identity.mjs` (token acquisition from Container Apps' own identity endpoint, no SDK),
`graph-client.mjs` (Microsoft Graph, authenticated by the admin-ui's own managed identity), `api.mjs` (the router),
`server.mjs` (the entry point). `admin-ui/web/` is a vanilla HTML/CSS/JS single-page app, no build step. This matches
this repository's own convention: Node.js 22 or later, no npm packages (`README.md` at the repository root).

Deployed as a second Container App (`ca-admin-ui`) in the gateway's existing Container Apps environment
(`admin-ui/infra/main.bicep`), with its own user-assigned managed identity, least-privilege and separate from the
gateway's own identity.

## Permissions this needs, and why

The admin-ui identity holds four Microsoft Graph application permissions, five with `-GrantUserWrite`, granted by `Deploy-AdminUi.ps1` after the
Bicep deployment (ARM has no resource type for a Graph permission grant on a service principal):

| Permission | Why |
|---|---|
| `AppRoleAssignment.ReadWrite.All` | To grant or remove the gateway's own app roles on a user, the call `set-developer.mjs` makes ([POST /servicePrincipals/{id}/appRoleAssignedTo](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto)) |
| `Application.Read.All` | To read the gateway's app registration's own `appRoles` (their ids and display values), so the Developers page shows role names, not raw GUIDs |
| `User.Read.All` | To resolve a developer's email to their object id before granting a role |
| `Application.ReadWrite.OwnedBy` | To create app roles on the gateway's registration. It reaches only applications the identity owns; `Deploy-AdminUi.ps1` adds the identity as an owner of the gateway's registration ([permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#applicationreadwriteownedby)) |
| `User.ReadWrite.All` (only with `-GrantUserWrite`) | To set a user's department and cost center from the Chargeback page. It can change any user's profile; without it these attributes are set in Entra ID directly |

The Bicep template also gives the identity **Container Apps Contributor** (`358470bc-b998-42bd-ab17-a7e34c199c0f`)
on the gateway's container app only, so it can write the `gateway-config` secret
([built-in roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-contributor)).

Azure RBAC and admin role assignments have Portal workflows:

- For the managed identity's Azure role, open the gateway Container App in Azure Portal, select **Access control (IAM)
  > Add role assignment**, choose **Container Apps Contributor**, select `id-admin-ui`, and keep the scope at the
  gateway app ([role assignment steps](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-portal)).
- For an admin's `AdminUi.Admin` role, open the admin-ui enterprise application in the Microsoft Entra admin center,
  then **Users and groups > Add user/group** ([assignment steps](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).
  The role must exist first: in **App registrations > the admin-ui sign-in app > App roles**, create or confirm an
  enabled user role with value `AdminUi.Admin`. The app registration also needs ID token issuance and the Web redirect
  URI `https://<ca-admin-ui-fqdn>/.auth/login/aad/callback`; select that registration under **Container Apps >
  ca-admin-ui > Security > Authentication**.

Microsoft Entra does not provide a Portal workflow to grant Microsoft Graph application permissions to a managed
identity. A directory role administrator must create those app-role assignments through Microsoft Graph
([grant application permissions](https://learn.microsoft.com/en-us/graph/permissions-grant-via-msgraph)). The
Settings page states this limitation instead of presenting unsupported Portal steps.

`AppRoleAssignment.ReadWrite.All` is itself a highly privileged grant: it can manage app-role assignments for **any**
application registered in the tenant, not only this gateway's — Microsoft Graph has no narrower permission scoped to
one application's roles. This is a real trade-off, not hidden: an identity that holds it should be treated as
privileged, with its own audit trail (Entra sign-in and audit logs for the identity's object id) and least-privilege
applied everywhere else (no other role, no other resource access).

Granting these permissions needs a **Global Administrator** or **Privileged Role Administrator** in the
tenant (or Cloud Application Administrator where consent for Microsoft Graph's application permissions is already
present) — plain Owner on the resource group, enough for every other step `Deploy-AdminUi.ps1` takes, is not enough
for this one. If the signed-in operator holds neither, the grant step fails with a named, surfaced
`Authorization_RequestDenied` error (not silently skipped), and the Budgets/Dashboard/Audit pages still work; only
the Developers page needs the grant (docs/UNKNOWNS.md, U-75).

The Settings page also has a collapsible client-onboarding guide. For a model of the admin file, `GET /api/client-kit`
answers the files `scripts/admin/new-client-policy.mjs` writes, for the gateway URL from Container Apps ingress: the
whole folder as `client-policy.zip`, or one file with `file=<path>`, such as `desktop/ClaudeDesktop-HKLM.reg` or
`desktop/Set-ClaudeDesktopPolicy.ps1` for Claude Desktop's `HKLM\SOFTWARE\Policies\Claude\bootstrapUrl` policy. A model
outside the admin file is refused with 400 and an unknown file with 404. The zip is written without a package
(`server/client-kit.mjs`), so the image copies `infra/azure-test/lib`, which the generator imports. There is no custom
`onboarding.json` format.

## Deploying

```
pwsh -File admin-ui/infra/Deploy-AdminUi.ps1 -ResourceGroup <rg> -AcrName <acr> -AppRegistrationName <gateway-app-registration-display-name> -AdminFile <admin file> -AllowedCidr <range> -EnableSignIn -SignInAdmins <your UPN>
```

`-AllowedCidr` is the address range allowed to open the console (default `10.40.0.0/16`, the private topology's
virtual network). In the test topology it is the public range the administrator connects from. The range
`203.0.113.0/26` used in this repository's examples is a documentation range ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737))
and admits nobody; `(Invoke-RestMethod https://api.ipify.org)` prints the current public IPv4 address, and
`<address>/32` admits that address only. A caller outside the range gets HTTP 403 with the body `RBAC: access denied`.
`-AdminFile` defaults to `config/gateway-admin.azure-private.json`. Without `-EnableSignIn`, the write routes for
configuration, roles and user tags answer 403.

Requires the gateway already deployed with `deployment.adminApi: true` in its admin file
(`infra/azure-private/Deploy-Gateway.ps1 -Step app`, which creates the `admin-write-key` secret this script reads).
Idempotent: re-running rebuilds the image, deploys from its digest (not a mutable tag — a same-day rebuild under an
unchanged tag does not make Container Apps re-pull it) and skips a Graph permission already granted.

| Switch | Effect |
|---|---|
| `-Topology test` | The gateway configuration was rendered for the test topology (default `private`). |
| `-EnableSignIn` | Creates the `<app-registration>-admin-ui-signin` registration (ID tokens, no client secret, assignment required, app role `AdminUi.Admin`) and turns on Container Apps authentication for admin-ui. `/api/health` stays anonymous. |
| `-SignInAdmins a@contoso.com,...` | Assigns `AdminUi.Admin` to those users. A user who already holds a different role on the app still gets `AdminUi.Admin`. |
| `-GrantUserWrite` | Also grants `User.ReadWrite.All`. |

## Reachability

External ingress with an `ipSecurityRestrictions` allow rule for the gateway's own VNet range, the same pattern
`ca-claude-gw` uses — not Container Apps' internal-only ingress, which hit a live, reproducible, still-open platform
bug here: the internal load balancer answered 404 "This Container App is stopped or does not exist" for a healthy
replica (tracked upstream at
[microsoft/azure-container-apps#1714](https://github.com/microsoft/azure-container-apps/issues/1714)). The
environment itself has no public endpoint (ADR-0005), so this is still unreachable from the internet either way.

## Cost

No new Container Apps environment and no separate environment-management fee: the existing `cae-claude-gw`
environment runs the Consumption workload profile only, which Azure's own pricing page does not meter as a fixed
fee ([Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/), checked
2026-10-16). At 0.25 vCPU / 0.5 GiB and `minReplicas: 0` (live Azure Retail Prices API, `northcentralus`,
2026-10-16: vCPU idle $0.000003/vCPU-second, memory idle $0.000003/GiB-second, requests $0.40/million), admin-ui
scales to zero between admin sessions, so it costs cents a month at this scale rather than the roughly $6/month an
always-warm (`minReplicas: 1`) replica would idle-bill around the clock — the trade-off is a several-second cold
start on the first request after idle. The subscription's Consumption free grant is already consumed by the
always-warm gateway (`minReplicas: 2`, 1 vCPU / 2 GiB each), so none of it is left over for admin-ui.
