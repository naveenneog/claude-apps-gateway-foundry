# ADR-0019: Same-origin console writes, Desktop capabilities and image-only updates

- **Status:** Accepted
- **Date:** 2026-11-04
- **Packet:** P-35
- **Extends:** ADR-0010, ADR-0011 and ADR-0012
- **Deciders:** owner requested fixes, browser testing, import/plugin controls and an update path for existing installs.

## Evidence

| Fact | Source |
|---|---|
| Customer POSTs to the console had a matching Origin and `Sec-Fetch-Site: same-origin`, but no Referer. Azure Authentication logged CSRF rejection, HTTP 403 substatus 60, before the Node API. The console sends `Referrer-Policy: no-referrer`. | Customer's sanitized HAR and middleware logs, 2026-11-04; admin-ui/server/server.mjs:147 |
| `same-origin` sends a Referer to the same origin and omits it for cross-origin requests. | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy, read 2026-11-04 |
| Container Apps Contributor grants `Microsoft.App/containerApps/*/read`, `*/write` and `*/action`; the console's literal slash matcher misses the app-level read/write operations. This is a capability display, not an authorization grant. | https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-contributor; admin-ui/server/capabilities.mjs:13-17, read 2026-11-04 |
| Desktop documents boolean plugin-upload, marketplace, skill and extension controls, and `claudeAiImport.enabled` and `exportEnabled` booleans. Automatic third-party import is independent and can reactivate tasks and executable plugins. | https://claude.com/docs/third-party/claude-desktop/configuration#claudeaiimport, read 2026-11-04 |
| The gateway serves explicitly configured Desktop settings through a matched policy's `desktop` block. | https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay, read 2026-11-04 |
| A customer's **Apply and roll out** answered 403 `LinkedAuthorizationFailed`: the console identity held `Microsoft.App/containerApps/write` on the gateway app but not `Microsoft.App/managedEnvironments/join/action` on its environment. Reproduced on the test installation with a temporary service principal and a throwaway app: Container Apps Contributor on the app alone gave the same 403; after Container Apps Operator on the environment and a new token, the same PUT succeeded. Container Apps Operator could not write the environment (403 `AuthorizationFailed`). The probe app, service principal and role assignments were deleted. | Customer screenshot, 2026-11-05; probe on rg-claude-gw-p45-existing, 2026-11-05; https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-operator |
| A subsequent **Apply and roll out** answered 403 `LinkedAuthorizationFailed` for `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action` on `id-claude-gw`; Managed Identity Operator (`f1a07417-d97a-45cb-824c-7a7467783830`) includes that action and can be scoped to the identity. | Customer screenshot, 2026-11-05; live role definition via `az role definition list`; https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/identity#managed-identity-operator |

## Decision

- Replace ADR-0011's `no-referrer` with `same-origin`. Keep Entra sign-in, `AdminUi.Admin`, JSON-only bodies,
  body limits, CSP and the cross-site write refusal. Do not disable platform CSRF protection.
- Interpret a standalone interior `*` action segment as zero or more resource segments in the capability display.
  Keep exact action matching, case-insensitivity, per-permission NotActions and independent grants. ARM remains the
  authority; this does not add a role or bypass a denied operation.
- Offer per-role Desktop switches through the existing validator, renderer and reviewed configuration save.
  Unset settings stay unset. Import is explicit, never automatically migrated; plugin enablement does not install
  plugins or preapprove tool calls. No arbitrary Desktop configuration passthrough is added.
- Prefer email-to-gateway-subject resolution for user caps and make the distinction from Entra object IDs visible.
  Preserve the ability to configure a known opaque gateway subject.
- An existing console can receive an image-only update without rerunning provisioning or Graph grants.
  This is an explicit exception to CHARTER's full-template what-if prerequisite: a targeted image update avoids
  replacing omitted authentication, secret, ingress and environment settings. Its plan identifies the target and
  image; before/after checks verify those settings are preserved. No gateway database, budget, identity assignment,
  app registration or scheduled job is recreated. The previous image is the rollback target.
- Amendment, 2026-11-05: `main.bicep` also assigns the console identity **Container Apps Operator**
  (`f3bd1b5c-91fa-40e7-afe7-0c11d331232c`) on the gateway's Container Apps environment, the smallest built-in role
  with `managedEnvironments/join/action`; it has no write on the environment or any app. Settings > Permissions
  reports the grant as its own item, and the configuration editor is read-only with that reason while it is missing.
  An existing install receives the grant with one role-assignment command; the image-only update does not grant roles.
- Amendment, 2026-11-05: `main.bicep` also assigns **Managed Identity Operator** on the gateway's user-assigned
  identity, granting `userAssignedIdentities/assign/action` without write access to the identity. The deployment
  skips this assignment when the console identity already holds the role. Settings > Permissions checks every
  user-assigned identity attached to the gateway app, and the configuration editor is read-only while any lacks
  assign/action. Existing installs grant the role on `id-claude-gw`.

## Verification

T-165 covers same-origin browser writes and retained cross-site/non-admin refusals. T-166 uses Microsoft's
published role patterns and exclusions. T-167 covers strict Desktop validation, per-role rendering and the reviewed
editor. T-168 covers image-only update planning and preservation. T-169 covers the environment join grant and its
Permissions item. T-170 covers the user-assigned identity grant and its Permissions item. Playwright exercises actual page interactions;
local authentication fixtures are labelled simulations, not proof of Azure Authentication behavior. Live evidence
identifies the authorized test installation; customer deployment verification is not claimed without access.
