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

## Verification

T-165 covers same-origin browser writes and retained cross-site/non-admin refusals. T-166 uses Microsoft's
published role patterns and exclusions. T-167 covers strict Desktop validation, per-role rendering and the reviewed
editor. T-168 covers image-only update planning and preservation. Playwright exercises actual page interactions;
local authentication fixtures are labelled simulations, not proof of Azure Authentication behavior. Live evidence
identifies the authorized test installation; customer deployment verification is not claimed without access.
