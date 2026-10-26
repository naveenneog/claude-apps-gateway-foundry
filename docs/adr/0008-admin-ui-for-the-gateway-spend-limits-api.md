# ADR-0008: An admin UI for the gateway's own spend-limits API, as a second Container App

- **Status:** Accepted
- **Date:** 2026-10-16
- **Deciders:** owner (request: "build a UI equivalent in features of claude portal for admins and compute the cost
  of hosting this UI as well"), agent
- **Packet:** P-33 · **Unknowns:** U-71 to U-75 (this ADR)

## Context
The owner asked for an admin UI for the gateway, equivalent to Claude Console's admin portal, and the cost of
hosting it. The gateway's own documentation is explicit about scope: "The gateway serves the spend-limits endpoints
only" ([claude-apps-gateway-spend-limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits)). There
is no gateway-side API for members, workspaces, invites or API keys - those are Claude Console concepts for
Anthropic-hosted accounts, and do not map onto a self-hosted gateway whose developers sign in by Entra ID, not API
key. The only other administrative action this deployment has is Entra app-role assignment
(`scripts/admin/set-developer.mjs`, already built for P-18/P-19), run today from an operator's own signed-in Azure
CLI session, with no UI.

So "equivalent to Claude Console for admins" means, honestly, two things this gateway can actually do: manage spend
caps, and manage who holds the `Gateway.Standard`/`Gateway.Premium` app roles. Anything wider would be inventing an
API the gateway does not have.

| Fact | Source |
|---|---|
| The gateway's admin API serves `/v1/organizations/spend_limits` (list/create/get/delete), `/effective` and `/audit` only | https://code.claude.com/docs/en/claude-apps-gateway-spend-limits |
| `admin.write_keys`/`admin.read_keys` are arrays of `{id, key}` objects, not bare strings; keys need a 32-character minimum | Anthropic's own example, `github.com/anthropics/claude-code/blob/main/examples/gateway/aws/gateway.yaml.example` (checked 2026-10-16); confirmed live by the gateway's own config validator, which rejected a bare-string array with "Expected object, received string" at `["admin","write_keys",0]` |
| This repository's convention is Node.js 22 or later, no npm packages | `README.md` |

## Options considered
1. **A second Container App (`ca-admin-ui`) in the gateway's existing environment**, a thin backend-for-frontend
   calling the gateway's admin API and reusing `set-developer.mjs` unmodified, plus a static frontend. Shares the
   VNet, the private DNS zone and the environment's own cost; its own identity, least-privilege from the gateway's.
2. **A script-only admin experience** (what already existed): `new-gateway-config.mjs` and `set-developer.mjs`, run
   by an operator with their own Azure CLI session. No new infrastructure or cost, but not a UI, and not something a
   non-technical admin can use.
3. **Extend the gateway's own container** to also serve an admin UI. Rejected: couples an UI deployment to the
   gateway's own release cadence and blast radius, and the gateway image is Anthropic's, not ours, to add routes to.

## Decision
Option 1. `admin-ui/server/` is a framework-free `node:http` backend (`gateway-client.mjs` for spend limits,
`graph-client.mjs` + `managed-identity.mjs` for Entra, `api.mjs` as the router), `admin-ui/web/` a vanilla JS/HTML/CSS
frontend, deployed by `admin-ui/infra/main.bicep` and `admin-ui/infra/Deploy-AdminUi.ps1` into the existing
`cae-claude-gw` environment. `admin-ui/README.md` states the scope and the permissions trade-off.

## Consequences
+ Spend caps (per organization, RBAC group or user) are set, listed and audited from a browser, backed by the
  gateway's own Postgres-backed store, proven live end to end on 2026-10-16: a cap created via `POST
  /v1/organizations/spend_limits` is visible in `GET .../spend_limits`, `/effective` and `/audit`, through the
  admin-ui's own `/api/spend-limits` route, not only by calling the gateway directly.
+ Developer role management reuses `set-developer.mjs` unmodified, proving the azure-rest.mjs-shaped `graph()`
  contract (`admin-ui/server/graph-client.mjs`) is a correct substitute for an operator's Azure CLI session.
+ Incremental cost is small and shared infrastructure absorbs most of it: no new Container Apps environment, no new
  environment management fee (the environment runs the Consumption workload profile only, which Microsoft's own
  pricing page does not meter separately -
  [Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/), checked 2026-10-16).
  At 0.25 vCPU / 0.5 GiB and `minReplicas: 0` (live Azure Retail Prices API, `northcentralus`, 2026-10-16: vCPU idle
  $0.000003/vCPU-second, memory idle $0.000003/GiB-second, requests $0.40/million), the admin-ui scales to zero
  between admin sessions and costs cents a month at this scale, trading a several-second cold start on the first
  request after idle; the subscription's Consumption free grant is already consumed by the always-warm gateway
  (`minReplicas: 2`, 1 vCPU / 2 GiB each), so none of it is left for admin-ui.
− Granting the admin-ui identity's three Microsoft Graph application permissions
  (`AppRoleAssignment.ReadWrite.All`, `Application.Read.All`, `User.Read.All`) needs a Global Administrator or
  Privileged Role Administrator in the tenant; the signed-in operator holds neither (live: Microsoft Graph answered
  `Authorization_RequestDenied: Insufficient privileges to complete the operation`). The Budgets/Dashboard/Audit
  pages work today; the Developers page is built and answers a clean 403 (not a crash) until that grant is made
  (U-75, OPEN).
− `AppRoleAssignment.ReadWrite.All` is itself a highly privileged grant: it can manage app-role assignments for any
  API registered in the tenant, not only this gateway's. Documented, not hidden, in `admin-ui/README.md`.
− Found and fixed five real defects on the way, none of them hypothetical (U-71 to U-75 below): the `write_keys`
  config shape, a Postgres CLI flag this repository had carried since before this packet, a bug in the `containerapp`
  CLI extension's own `update --yaml` path, Container Apps' internal-only ingress returning 404 for a healthy
  replica (an open upstream platform bug), and this gateway's own `managed-identity.mjs` using the wrong token
  protocol for Container Apps. Each is live-verified and test-covered (docs/TEST-PLAN.md, T-80 to T-87).

## How we'd know this was wrong
A spend cap set through admin-ui does not change what `/effective` reports for that principal; the audit trail
loses an entry; granting the Graph permissions (once a tenant admin runs that step) still answers 403; or the
Container App's incremental cost, measured from Cost Management after a month of real use, is not materially smaller
than the always-on estimate in this ADR.
