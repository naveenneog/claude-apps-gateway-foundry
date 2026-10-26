# ADR-0011: with sign-in on, admin-ui answers only AdminUi.Admin holders

- **Status:** Accepted
- **Date:** 2026-10-25
- **Packet:** P-35
- **Deciders:** owner (request: "this app also should be secure and accessed by only admin"), agent
- **Extends:** ADR-0008 (network-restricted admin-ui) and ADR-0010 (writes need sign-in and `AdminUi.Admin`)

## Context
ADR-0010 put the `AdminUi.Admin` check on the routes that change the gateway configuration, create a role or tag a
user. Several other routes stayed open to any caller that admin-ui let through:

| Route | Before this decision, with sign-in on |
|---|---|
| `GET/POST/DELETE /api/spend-limits…` | No principal check: a signed-in user without `AdminUi.Admin` could read spend and set or delete a cap |
| `GET /api/developers` | Any signed-in user could list every role holder |
| `GET /api/gateway-config`, `/preview`, `/rollout` | Any signed-in user could read the models, roles and Desktop access |
| `GET /api/chargeback`, `/api/business-units`, `/api/roles`, `/api/capabilities` | Any signed-in user could read spend per user and per department, and the Graph user list |

Container Apps authentication admits a user when the sign-in app registration lets the user sign in. With
`appRoleAssignmentRequired=true` (set by `Deploy-AdminUi.ps1 -EnableSignIn`), Entra issues a token only to users and
groups assigned to the enterprise app ([Microsoft Learn: restrict a Microsoft Entra app to a set of users](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users)).
That assignment can be the default access role or `AdminUi.Admin`, so being able to sign in does not mean holding
`AdminUi.Admin`.

The frontend has no inline script or style and builds every element with `createElement`/`textContent`
(`admin-ui/web/ui.js` `el()`), and the server sent no security headers. `readBody` read any size and any content type.

## Options considered
1. **Leave reads open, as ADR-0010 did.** Spend per user, department tags and role holders are personal and
   financial data; this does not meet "accessed by only admin".
2. **Rely on the Entra assignment alone.** One gate only, and a default-access assignment, or a group added later for
   another reason, opens the whole console.
3. **Check `AdminUi.Admin` on every API route when sign-in is on (chosen),** keep Entra assignment-required as the
   first gate, and harden the HTTP layer.
4. **Also refuse every write when sign-in is off.** This would break the network-only mode ADR-0008 accepted and the
   staged installer's first admin-ui deployment, which runs before a sign-in app exists. Deferred: the deployment
   script warns instead.

## Decision
- **With `ADMIN_UI_SIGN_IN=required`, every `/api` route except `/api/health` and `/api/me` answers 403** unless the
  platform's `X-MS-CLIENT-PRINCIPAL` carries the `AdminUi.Admin` role claim. The check runs in `handleApi`, before any
  route is dispatched, so a route added later is covered without its own check. `/api/health` stays anonymous for the
  Container Apps probe (it is also excluded from authentication in `main.bicep`). `/api/me` stays open to a signed-in
  user so the browser can explain why access is refused.
- **The browser shows an access-denied screen** naming the signed-in account and the missing role, with the Entra
  admin center path to assign it, when `/api/me` reports `isAdmin: false` with sign-in on. It loads no other page.
- **HTTP hardening on every response:** `Content-Security-Policy` (`default-src 'self'`, `img-src 'self' data:`,
  `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; `/api` responses also send `Cache-Control:
  no-store`. Values follow the [OWASP HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).
- **Request bodies must be `application/json` and at most 1 MiB** (415 and 413 otherwise). A cross-site form or
  `fetch` can send `text/plain` without a CORS preflight; requiring `application/json` makes the browser preflight it,
  and admin-ui answers no preflight, so a page on another site cannot use the admin's session cookie to write (U-95).
  A write whose `Sec-Fetch-Site` header is `cross-site` is refused with 403 as a second check.
- **With sign-in off, ADR-0008's behaviour is unchanged:** admin-ui is limited by its IP allowlist only, ADR-0010's
  writes stay refused, and `Deploy-AdminUi.ps1` prints a warning that the console is not admin-only without
  `-EnableSignIn`.

## Consequences
- A user assigned to the sign-in app without `AdminUi.Admin` signs in and sees the access-denied screen; no API data
  is returned. Admins are added in Entra admin center > Enterprise applications > the `-admin-ui-signin` app > Users
  and groups, with the `AdminUi.Admin` role.
- Admin access now depends on the role claim reaching admin-ui (U-93). If it does not, every admin sees the
  access-denied screen; the screen lists the roles admin-ui received, and redeploying without `-EnableSignIn` returns
  to the IP-only mode while it is investigated.
- ADR-0010's "reads are open to anyone who reaches admin-ui" no longer holds when sign-in is on; the `canWrite` and
  `canTag` flags stay, because the server still reports missing Graph or ARM permissions through them.

## Amendment, 2026-10-25: the installer deploys the console admin-only

`Install-ClaudeGateway.ps1` used to deploy the console without sign-in, because it never passed `-EnableSignIn`, and
with `-Topology private`, `Deploy-AdminUi.ps1`'s default, on a test-topology gateway. A first install therefore gave a
console anyone inside the allowed range could use. The installer now passes `-Topology test`, `-EnableSignIn` and
`-SignInAdmins`, refuses the `admin-ui` stage without `-SignInAdmins`, and keeps the old behaviour only behind an
explicit `-NoSignIn`. `Deploy-AdminUi.ps1 -EnableSignIn` refuses an empty or malformed administrator list before any
Azure call, because a console with sign-in and no administrator opens for nobody. Tests: T-117
(tests/install-orchestrator.test.mjs, tests/deploy-adminui-args.test.mjs).
