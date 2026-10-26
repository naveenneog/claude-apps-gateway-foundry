# ADR-0009: A staged installer that sequences the existing deploy scripts, plus the one missing step

- **Status:** Accepted
- **Date:** 2026-10-19
- **Packet:** P-34
- **Deciders:** owner (request: "Create a stage based installer, and a Documentation of Each step if Automated
  Script fails how to do it in Portal UI. Also managing the users and Groups once installation is done."), agent

## Context
The owner asked, in the prior turn, what a full installer would need (resource creation, configuration,
permissions, initial groups and budgets, user onboarding), and this repository's own gap analysis found:

| Piece | State |
|---|---|
| Resource creation (resource group, registry, identity, workspace, environment) | Exists: `infra/azure-test/deploy.mjs --step base` (ADR-0003), `infra/azure-private/Deploy-Gateway.ps1` (ADR-0005). Proven live, this tenant, 2026-10-18 (U-80, U-81). |
| Config render and deploy | Exists: the same scripts' `entra`/`image`/`app` steps, `scripts/admin/new-gateway-config.mjs`. |
| Initial groups (app roles) | Exists: the `entra` step creates the app roles `infra/azure-test/entra-app.json` declares. |
| Allowed models per group | Exists, but manual: `policies[].models` in the admin file, hand-edited. |
| Microsoft Graph permission grant (admin-ui's Developers page) | Exists: `admin-ui/infra/Deploy-AdminUi.ps1`'s third step. **Never succeeded live** on any of the three tenants/deployments used this session — the signed-in account held Global Reader, not Global Administrator or Privileged Role Administrator, even where it owned the subscription (U-75, OPEN, docs/UNKNOWNS.md). |
| Initial budgets per group | **Missing.** No script calls `POST /v1/organizations/spend_limits`; a freshly deployed gateway admits every role with no cap until an operator visits admin-ui or calls the API by hand (ROADMAP, "Later", 2026-10-19). |
| User onboarding | Split, unchained: `scripts/admin/set-developer.mjs` grants the Entra role; `scripts/developer/Install-ClaudeGatewayProfile.ps1` installs the local profile; the developer's own browser sign-in is not scriptable at all. |

So the real gap is not "no automation exists" — most of it does, proven live — but that (a) nothing sets an
initial budget, (b) the pieces that do exist run as separate, manually-sequenced tools with no single entry point,
and (c) the one step that has repeatedly failed live (the Graph grant) fails by itself with no recorded, in-repo
answer for "what does the operator do instead", even though this session worked that out by hand three times over
(an Azure Portal walkthrough and a Cloud Shell script, both given to the owner directly in chat, never committed).

## Options considered
1. **A thin orchestrator that sequences the existing scripts as external processes**, each stage's command and
   arguments overridable for testing, stopping on the first failure and naming a documentation anchor rather than
   continuing past a broken prerequisite. Adds the one missing piece (`scripts/admin/bootstrap-budgets.mjs`) as a
   new stage alongside them.
2. **Rewrite deploy.mjs, Deploy-AdminUi.ps1 and set-developer.mjs into one monolithic script.** Rejected: throws away
   three separately proven-live, separately tested tools (T-52 to T-88) for no behavioural gain, and couples their
   release cadence; this repository's own convention (ADR-0003, ADR-0005, ADR-0008) is one script per concern.
3. **Leave the tools separate and only add documentation.** Rejected: does not close the budgets gap, and the owner
   asked for a staged installer, not only documentation.

## Decision
Option 1. `infra/azure-test/Install-ClaudeGateway.ps1` runs the ADR-0003 test topology's stages in order — `base`,
`entra`, `image`, `app` (each `node infra/azure-test/deploy.mjs --step <name>`), `admin-ui`
(`admin-ui/infra/Deploy-AdminUi.ps1`), `budgets` (the new `scripts/admin/bootstrap-budgets.mjs`) — and nothing else:
it contains no direct `az`, ARM or Graph call of its own, only sequencing, `-Plan` preview and failure handling, so
its own correctness is about the order and the stop, not about re-proving Azure calls the underlying scripts
already prove. `scripts/admin/bootstrap-budgets.mjs` reads a new, optional `budgets` array from the same admin
JSON file the other steps already share, and calls `admin-ui/server/gateway-client.mjs`'s existing `setSpendLimit`
once per row — no parallel HTTP client. `docs/learn/how-to-install-stage-by-stage.md` gives each stage's Portal UI
(or, where none exists, Cloud Shell) equivalent, researched and verified this session, not recalled; it is what the
orchestrator's own failure message points to. `docs/learn/how-to-manage-users-and-groups.md` covers the
already-working, post-install operations (role grants, new groups, budget changes) the same way.

## Consequences
+ One command (`Install-ClaudeGateway.ps1`) runs a fresh deployment end to end, including the one previously
  missing piece (initial budgets), idempotently: every stage it wraps is already idempotent on its own (ADR-0003,
  ADR-0008), and `bootstrap-budgets.mjs`'s `POST` replaces a cap for an unchanged `{scope, period}`, not creates a
  duplicate.
+ A stage that fails stops the sequence by name, with a pointer to the exact documentation section to do that one
  step by hand — chiefly useful for the Graph grant, which has failed live on every deployment this session (U-75).
+ No new Azure-calling logic to test from scratch: the orchestrator's own tests fake the three sub-scripts as
  whole processes (mirroring `tests/azure-private.test.mjs`'s world-driven fake, one level up), proving sequencing
  and stop-on-failure, while the sub-scripts' own Azure-calling correctness stays covered where it already is
  (T-52 to T-88).
− The orchestrator has not been run start-to-finish against a genuinely empty subscription this session: the
  Contoso-tenant deployment it was proven against already exists, so the live proof re-runs each already-applied
  stage idempotently (confirming no stage changes anything unexpected on a second pass) rather than building from
  zero. A true from-scratch run is the stronger proof and is not yet done (new unknown, see docs/UNKNOWNS.md).
− The Portal UI fallback for the Graph grant is, honestly, not a Portal UI at all: Microsoft's own Azure Portal has
  no "grant an application permission to a managed identity" surface (researched this session, see the new Learn
  article); the documented fallback is Azure Cloud Shell running the same Microsoft Graph REST call
  `Deploy-AdminUi.ps1` already makes, under a Global Administrator or Privileged Role Administrator's own sign-in.
  This is stated plainly in the new article rather than inventing a Portal path that does not exist.

## How we'd know this was wrong
A fresh subscription run of `Install-ClaudeGateway.ps1` either does not reach a healthy gateway and admin-ui in one
pass, or reaches one that a hand-run of the equivalent individual scripts would not; a stage's failure message
points to a documentation section whose steps do not in fact produce the same state the automated stage would
have; or `bootstrap-budgets.mjs`'s caps are not visible in `GET /v1/organizations/spend_limits` and `/effective`
after it runs.

## Amendment, 2026-10-21: council round 1
The council, reading the code before any from-scratch run, found that the decision above did not hold: the
installer would not have reached a healthy admin-ui in one pass, which is this ADR's own first test of being wrong.

| Finding | Change |
|---|---|
| The four `deploy.mjs` stages got no `--resource-group`, so they targeted `deploy.mjs`'s default resource group whatever `-ResourceGroup` named | Every `deploy.mjs` stage gets `--resource-group` and `--app-display-name`, and `--location`, `--foundry-*` and `--email-domain` when given |
| `-AdminFile` never reached `app`, which always deployed `config/gateway.azure-test.yaml` | A first stage, `config`, renders the admin file; `deploy.mjs --config` deploys that rendering; asking for `app` runs `config` too |
| The test template had no admin API key, so `budgets` and `admin-ui` could only work where it had been added by hand | `gateway-test.json` carries `admin-write-key` and `GATEWAY_ADMIN_WRITE_KEY`; `deploy.mjs` generates the key once and keeps the live one |
| `budgets` ran after `admin-ui`, whose Graph grant had failed on every deployment (U-75) | `budgets` runs before `admin-ui`, so the grant is the last step of the last stage |
| `-AcrName` was required before `base` created the registry; `-AllowedCidr` defaulted to a virtual network range this topology lacks | The registry is read from the state `base` records; the range defaults to `-TesterCidr` |
| Re-running `app` on a deployment patched by hand would delete what was added, such as Contoso's cross-tenant Foundry credential (U-80) | The `app` step stops before any change when the live app holds secrets or gateway variables the template does not define, or when the configuration references a `${VAR}` the template does not set |
| `Deploy-AdminUi.ps1` passes values to `az.cmd`, whose arguments cmd.exe parses again | The installer refuses, before any stage runs, a value holding a character cmd.exe interprets (ampersand, pipe, angle brackets, caret, percent sign, double quote) or a line break |

The decision itself stands: the installer still makes no `az`, ARM or Graph call of its own. The changes to
`deploy.mjs` and `gateway-test.json` belong to this packet because without them its first consequence was false. A
from-scratch run on 2026-10-21 then built an empty resource group through six stages and stopped at the Graph grant as
designed (docs/TEST-PLAN.md, T-91), so U-82 is resolved. A deployment whose Foundry account is in another tenant is
still outside what `deploy.mjs` builds; supporting it is a roadmap entry, not part of this packet.
