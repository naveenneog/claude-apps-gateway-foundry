# claude-apps-gateway-foundry — Roadmap

> A **packet** is one behaviour, testable in isolation, shippable in one commit.
> Exactly one packet is active at a time (`docs/STATUS.md`). Test cases per packet: `docs/TEST-PLAN.md`.
> Unknown IDs (U-n) refer to `docs/UNKNOWNS.md`.

## Done — M0: Plan

- [x] P-0  Ironclad scaffold
      Given a fresh repository, when `node .ironclad/gate.mjs --stage pre-commit` runs after `init.mjs`, then the gate passes (commit fdea6a9).

- [x] P-1  Planning ledger: comparison ADR, unknowns register, test plan
      Given the ledger docs, when `node --test tests/*.test.mjs` runs, then every comparison row, researched unknown and test case cites a source, every packet states acceptance criteria, and every P-, T-, PS- and U- reference resolves.

## Now — M1: Test deployment on Azure Container Apps (ADR-0003)

- [ ] P-2  Entra ID app registration for the gateway
      Given the tenant's app management policy (password credentials up to 30 days, system-generated only; U-1) and a consent rule that refuses user consent to apps requiring assignment (U-39), when `node infra/azure-test/deploy.mjs` registers the app from `infra/azure-test/entra-app.json` with redirect URI `https://<gateway-fqdn>/oauth/callback`, the `email` optional claim on the ID token and app roles `Gateway.Standard` and `Gateway.Premium`, assigns the tester to `Gateway.Standard`, and its app step adds a system-generated client secret that ends within 7 days, then Microsoft Graph returns each of those settings and the tenant refuses a second secret with a 60-day end date (T-01).
      Depends on: —          Unknowns: U-2, U-3, U-36, U-39

- [ ] P-3  Gateway boots on Azure Container Apps and signs a developer in
      Given the image built by ACR Tasks from Claude Code 2.1.280 for `linux-x64`, checked against the signed `manifest.json`, and a Container App with a PostgreSQL 16 sidecar, one replica and ingress limited to the tester's egress range, when `node infra/azure-test/deploy.mjs` completes, then the discovery document returns 200 to the tester (T-02), `POST /oauth/device_authorization` returns a `user_code` (T-03), a browser sign-in writes a `session.mint` audit event with the tester's email and egress address (T-04), and a request from outside the range receives 403 from the ingress (T-42).
      Depends on: P-2        Unknowns: U-5, U-32, U-33, U-34, U-35

- [ ] P-4  Inference reaches Foundry through the gateway
      Given a Claude Code on the Windows host that holds a gateway session token from the device flow in `ANTHROPIC_AUTH_TOKEN`, with an empty `CLAUDE_CONFIG_DIR` (U-38), and a `provider: foundry` upstream with `use_azure_ad: true` and a `models:` map to the Foundry deployment names, when `claude -p "Reply with PONG" --model claude-sonnet-5` runs, then the reply contains PONG and the gateway log gains an `inference` event naming the Foundry upstream with status 200 during that run (T-06).
      Depends on: P-3        Unknowns: U-7, U-11, U-37, U-40

- [ ] P-5  Failover between two Foundry upstreams
      Given upstreams `foundry-contosohub` then `foundry-claudepv2`, where only the second deploys `claude-haiku-4-5`, when a Haiku request is sent, then the operational log shows a 404 from the first upstream and the `inference` audit event names the second (T-09).
      Given that result, when the one-hop cost is reviewed, then P-5 records either deploying `claude-haiku-4-5` on the first account or accepting the hop, in `docs/ARCHITECTURE.md`.
      Depends on: P-4        Unknowns: U-8

- [ ] P-18 Developer credential helper and Claude Code profile on Windows (ADR-0004)
      Given the gateway's device grant and refresh grant, when `scripts/developer/Connect-ClaudeGateway.ps1` runs in Windows PowerShell 5.1 and the developer approves the code in a browser, then the refresh token is stored encrypted with DPAPI for the Windows user, `Get-ClaudeGatewayToken.ps1` prints a valid access token and refreshes it within five minutes of expiry, and a profile directory holds `settings.json` with `ANTHROPIC_BASE_URL` and `apiKeyHelper` (T-48, T-49, T-50).
      Given that profile, when `claude -p` runs through it, then the reply arrives and the gateway logs `inference` events for the requests the CLI sent (T-51).
      Depends on: P-3        Unknowns: U-47, U-48

- [ ] P-19 Admin configuration and onboarding scripts (ADR-0004)
      Given an admin file that lists app roles, the models each role may use and the Foundry deployments, when `node scripts/admin/new-gateway-config.mjs` runs, then it writes a `gateway.yaml` whose policies, `models:` and `availableModels` match the file, and it refuses a role or model the file does not define (T-52).
      Given a user principal name and a role, when `node scripts/admin/set-developer.mjs` runs, then Microsoft Graph lists that role for the user, and with `--remove` it lists none (T-53).
      Given the gateway URL, when `node scripts/admin/new-client-policy.mjs` runs, then it writes managed settings for `/login` as JSON, a Windows `.reg` file and a macOS `.mobileconfig`, each with `forceLoginMethod` set to `gateway` and `forceLoginGatewayUrl`, and a developer bundle for the P-18 profile (T-54).
      Depends on: P-2        Unknowns: U-24

- [ ] P-20 Inference test suite through the gateway (ADR-0004)
      Given a session from the P-18 helper, when `node tests/live/inference-suite.mjs` runs, then each case T-55 to T-65 passes, or reports BLOCKED with the condition that did not occur, and every 200 answer from the gateway on `/v1/messages` is matched to its `inference` audit event by `x-request-id`; the APIM samples of T-64 have no gateway audit.
      Depends on: P-4, P-18  Unknowns: U-44, U-52

- [ ] P-21 Documentation in Microsoft Learn format (ADR-0004)
      Given the scripts of P-18 to P-20, when `docs/learn/` is read, then an overview, a quickstart, how-to guides for administrators and developers, a script reference and a troubleshooting article exist with Learn front matter, each script command they show is one the scripts accept, and the ledger tests check their citations and wording (T-66).
      Depends on: P-18, P-19, P-20

- [ ] P-22 One audit-log reader for both live suites
      Given the audit-log polling that `tests/live/gateway-live.mjs` and `tests/live/inference-suite.mjs` each carry, when either suite looks up events by request ID, then both use one reader in `tests/live/lib.mjs` that waits for an event matching the predicate (council round 2, Architect note 8; split from the helper option in council round 4).
      Depends on: P-20

- [ ] P-23 A diagnostic for a project's Claude Code settings
      Given a developer profile and a project folder, when a diagnostic script runs with `-ProfileDir` and the project folder, then it names each key in the project's `.claude/settings.json` and `.claude/settings.local.json` that the launcher's pinned settings override or that makes the helper refuse, and runs the helper with the effective `ANTHROPIC_BASE_URL` (council round 2, UX note 5).
      Depends on: P-18

- [ ] P-24 The inference suite runs a profile's own helper
      Given a developer profile installed with its own runtime, when `inference-suite.mjs --profile-dir <dir>` runs, then the suite reads the session token through that profile's `apiKeyHelper`, so the runtime the profile was installed with is the one tested (council round 2, Architect note 8; council round 4, Architect note 3).
      Depends on: P-20

- [ ] P-25 The installer refuses a Claude Code older than the supported version
      Given a `claude` on `PATH`, or named with `-ClaudePath`, whose `claude --version` is below 2.1.272, when `Install-ClaudeGatewayProfile.ps1` runs, then it writes nothing and names the version found, 2.1.272, and the update command, because the launcher's settings precedence was measured only with 2.1.272 (U-50; council round 4, UX note 5).
      Depends on: P-18

- [ ] P-26 Mutation runs on GitHub-hosted Windows runners
      Given the repository on GitHub and `.github/workflows/mutation.yml`, when the workflow is dispatched, then `tests/mutate-ledger.ps1`, `tests/mutate-deploy.ps1`, `tests/mutate-admin.ps1` and `tests/mutate-developer.ps1` run on `windows-latest` with Windows PowerShell 5.1 and Claude Code 2.1.272, the admin and developer scripts run in shards whose `-List` output together names every mutation exactly once, each job uploads its log, and a job fails when a mutation survives, does not apply exactly once or stops its suite from loading (T-67).
      Depends on: —          Unknowns: U-54, U-55

## Next — M2: Governance parity with the APIM route

- [ ] P-6  Per-group model access
      Given policies keyed on the gateway's own standard and premium groups, separate from the APIM allowlist groups (standard: Sonnet and Haiku; premium: adds Opus), with `enforceAvailableModels: true`, when a standard-group user requests the Opus model, then the gateway returns 400 and the `/model` picker lists no Opus model (T-10).
      Depends on: P-4        Unknowns: U-2, U-24

- [ ] P-7  Managed settings delivered per group
      Given a catch-all policy with `permissions.deny: ["WebFetch"]`, `disableBypassPermissionsMode: disable` and `allowManagedPermissionRulesOnly: true`, when a signed-in session starts, then WebFetch is denied, a local allow rule has no effect, and `--dangerously-skip-permissions` is refused (T-12, T-34).
      Depends on: P-4        Unknowns: —

- [ ] P-8  Spend limits at Foundry prices, failing closed
      Given an `admin:` block, `pricing.overrides` rows at the Foundry rates, `enforcement.fail_closed_on_error: true` and a `"0"` cap on the test user, when the user sends a prompt, then the gateway returns 429 `billing_error` with `x-should-retry: false`, and after the cap is deleted the next request returns 200 (T-13).
      Given `admin.identity_retention_days` set and an erasure request for the test user, when `DELETE FROM principal_emails WHERE principal = '<sub>'` runs, then `/effective` shows no email or name for that subject (T-31).
      Given that `admin:` block with a read key, a `pricing.overrides` row for the test model with `output` 10000 USD per million tokens, one cent per token and the highest rate the gateway accepts, and `input`, `cache_read` and `cache_write` 0.01, since every rate must be above 0, and a test user with no other request in the day, when the suite reads the user's daily spend in `/effective`, sends a prompt that `count_tokens` counts at 100 input tokens or fewer, without `cache_control` and with `max_tokens` M, closes the stream after receiving c ≥ 2,000 characters of text, and reads the spend again, then the spend has risen by at least ceil(c / 8) cents, half the floor estimate at four characters per token, which the input charge of at most 0.0001 cents cannot reach, and by at most M + 1 cents; and two reads with no request between them show the same spend (T-57, U-52).
      Depends on: P-4        Unknowns: U-9, U-20

- [ ] P-9  Telemetry into Azure Monitor, metrics only
      Given `telemetry.forward_to` pointing at an OpenTelemetry Collector that exports to Application Insights, with `logs: false` and `traces: false`, when a signed-in user runs one prompt with tool calls, then a token-usage metric carrying `user.email` is queryable in Application Insights and the collector receives no log or trace records (T-15, T-32).
      Given the telemetry workspace set to require workspace permissions, in DataActionsOnly mode, with Log Analytics Data Reader granted only to the named reader group, when a principal with Reader on the Application Insights component and its resource group but outside that group queries it, then that principal sees no rows while a group member does (T-35).
      Given the same workspace, when its settings and tables are read, then retention is 30 days with `immediatePurgeDataOn30Days` on, and every table that receives telemetry or audit data, including the Application Insights tables whose platform default is 90 days, keeps data no longer than 30 days (T-39).
      Depends on: P-4        Unknowns: U-10, U-28, U-29, U-30, U-31

## Now — M3: Private deployment on Azure (re-planned 2026-09-29)

- [ ] P-10 Gateway on Azure, reachable only on private addresses
      Given `infra/azure-private` deploying a virtual network, an internal Container Apps environment with a private DNS zone for the gateway host, PostgreSQL Flexible Server with private access, a Foundry account whose Claude deployments are reached through a private endpoint with public network access disabled, and a user-assigned identity with a Foundry data-plane role, when its deploy script runs after a preview of each change, then from a virtual machine in the VNet `/readyz` returns 200 and the gateway host resolves only to private addresses (T-16), a Messages API request sent to the Foundry endpoint from outside the VNet is refused while the gateway's `claude-sonnet-5` request through the private endpoint returns 200 (T-68), and the PostgreSQL server name resolves only to a private address and the server has no public endpoint (T-69).
      Depends on: P-4, P-8, P-9   Unknowns: U-11, U-12, U-22, U-56, U-57, U-61

- [ ] P-11 Developer sign-in over private connectivity
      Given a developer machine on the corporate network or VPN, when `/login` runs against the Azure gateway, then Claude Code accepts the private address, shows the published TLS fingerprint and completes sign-in (T-19), and `claude -p` after that sign-in reaches Foundry with no `ANTHROPIC_AUTH_TOKEN` set (T-45).
      Depends on: P-10       Unknowns: U-14

- [ ] P-28 Capacity for 25,000 developers
      Given the private deployment with an HTTP scale rule, when a load generator in the VNet holds concurrent streams against one gateway replica, then the concurrency at which requests start to queue, the memory held per open stream and the CPU at that point are recorded, and a stream longer than 240 seconds either completes or is cut, which decides between HTTP and TCP ingress (T-46, T-71).
      Given those measurements and stated inputs (developers, share active at peak, requests per active developer per minute, seconds a request stays open, tokens per request), when the capacity article is read, then it derives the replica count, `BUN_CONFIG_MAX_HTTP_REQUESTS`, PostgreSQL `max_connections` and SKU, sign-in `rate_limits`, and the Foundry tokens-per-minute to request, each with its formula and source (T-71).
      Depends on: P-10       Unknowns: U-40, U-58, U-59, U-60

- [ ] P-29 Learn articles for the network-restricted deployment
      Given P-10, P-11, P-14, P-27 and P-28, when `docs/learn/` is read, then a worked example deploys the gateway on Azure in a network-restricted environment, with the sections of Anthropic's [AWS worked example](https://code.claude.com/docs/en/claude-apps-gateway-on-aws): architecture, prerequisites and shell variables, deployment steps, the companion script, Azure-specific troubleshooting and telemetry; each step is shown three ways, the Azure portal with its navigation path and a screenshot, the Azure CLI, and the script; a how-to connects Claude Code, the VS Code extension and Claude Desktop with the interactive sign-in and managed settings delivered through Intune or Group Policy; a concept article plans capacity for 25,000 developers; every screenshot the articles show exists under `docs/learn/media` with alt text; and the T-66 checks pass (T-72).
      Depends on: P-10, P-11, P-14, P-27, P-28   Unknowns: U-62

- [ ] P-31 A clean public copy of the repository under the guide's name   ← ACTIVE
      Given the tracked files at HEAD, when `node scripts/publish/check-public.mjs` runs with the owner's deny file, then it finds no Windows or macOS user profile path, no public IPv4 address outside `scripts/publish/allow.json`, no Container Apps host name outside that file, no e-mail address outside the example domains and no deny-listed text, in text files, UTF-16 files, the parts and paragraph text of Word files, the object strings and Flate streams of PDFs (page text is not decoded, ADR-0006), the text chunks of PNG images and containers inside containers, and a tree with any one of these planted makes it exit 1 naming the file, the line and the rule, while a file it cannot read completely makes it exit 2 (T-75).
      Given a committed revision, a clone of the public repository and the deny file, when `node scripts/publish/publish-public.mjs` runs, then it refuses a clone that holds a commit of the working repository in any ref, has uncommitted changes, another `origin` or an identity other than a GitHub no-reply address, and a revision the checker fails; otherwise it replaces the clone's files, commits only when the staged tree equals the revision's tree, and a later publication removes the files the revision deleted (T-77).
      Given the private repository renamed to `naveenneog/claude-apps-gateway-foundry-private` and the local clone's `origin` pointed at the new name, when the public repository `naveenneog/claude-apps-gateway-foundry` is created and published as one commit under the MIT license, then `node scripts/publish/verify-public.mjs`, which mirrors it without credentials, finds no commit of the working repository in any ref, `main` holding the published revision's tree and no finding of the checker; the tutorial's `git clone` command works without credentials; and the private repository answers at its new name with its refs unchanged (T-76).
      Depends on: —          Unknowns: U-66, U-67, U-68

- [ ] P-12 Bypass routes are closed for migrated users
      Given Foundry with local (key) auth disabled and data-plane roles held only by the gateway identity and the APIM identity, when a developer calls Foundry directly with `CLAUDE_CODE_USE_FOUNDRY=1` and their own Entra token, then Foundry returns 401 or 403 (T-20).
      Given a migrated user who holds a gateway group and no APIM allowlist group after `Sync-ClaudeAccess.ps1` runs, when that user restores `CLAUDE_CODE_USE_FOUNDRY=1` and the APIM base URL, then APIM returns 403 and the same user's gateway session still returns 200 (T-27).
      Depends on: P-10       Unknowns: U-15, U-16

- [ ] P-30 Private deployment under a store outage, with backups and log access
      Given PostgreSQL accepting logins only from the named operator group, when a principal outside the group connects, then the server refuses it (T-36).
      Given the readiness probe on `/healthz` and spend enforcement failing closed, when PostgreSQL stops, then signed-in requests receive 429 `spend limit unavailable` and new sign-ins fail (T-18).
      Given the erasure procedure from P-8, when the server's backup retention is read, then it is 7 days and the procedure names that window as the time an erased row stays restorable (T-37).
      Given the gateway's console logs sent to the P-9 workspace, when a principal with Reader on the Container App but outside the named reader group queries the audit events, then that principal sees no rows while a group member does (T-40).
      Depends on: P-8, P-9, P-10   Unknowns: U-13, U-27

## Now — M4: Clients

- [ ] P-13 Windows managed settings and migration from the APIM client configuration
      Given a machine configured for the APIM route through user environment variables or the accelerator's managed settings file (`env.CLAUDE_CODE_USE_FOUNDRY`, `env.ANTHROPIC_FOUNDRY_BASE_URL`), when the migration removes the variables and replaces the managed file with one carrying `forceLoginMethod` and `forceLoginGatewayUrl`, then `/login` opens the Cloud gateway screen and `/status` shows the gateway sign-in (T-21, T-22, T-26).
      Given a user in an APIM allowlist group, when the migration runs for that user, then the gateway group is added and a gateway prompt succeeds before the APIM groups are removed (T-38).
      Depends on: P-11, P-12 Unknowns: U-16, U-21

- [ ] P-14 Claude Desktop through the gateway, with parent settings locked
      Given Claude Desktop with `bootstrapUrl` set to `<public_url>/user/bootstrap` and a policy carrying a `desktop` key, when the user signs in, then the gateway logs `desktop_bootstrap.serve` and Cowork and Code tab requests appear as `inference` events (T-23).
      Given `parentSettingsBehavior: "merge"` and the five `allowManaged*Only` locks with their allowlists in both the managed settings file and the catch-all `cli` block, when a host process supplies an allow rule, an MCP server, a hook, a network domain and a read path, then none of them apply (T-30).
      Depends on: P-11       Unknowns: U-17

- [ ] P-27 The VS Code extension through the gateway
      Given the managed login keys on a developer machine in the private network and the Claude Code extension for VS Code, when the developer opens the Claude Code panel and completes the gateway sign-in, then a prompt from the panel reaches Foundry and the gateway logs an `inference` event for the developer (T-70).
      Depends on: P-11       Unknowns: U-21

## Next — M5: Decide

- [ ] P-15 Hybrid route: gateway in front of a separate, authenticated APIM API
      Given an APIM API `claude-gw` that requires an API-scoped subscription key sent as `x-api-key`, allows only the gateway's egress address through `ip-filter`, and keys token limits on `x-claude-gateway-user-id`, when requests arrive without the key, with a wrong key, or with forged identity headers on the direct `claude` API, then APIM returns 401 or ignores the headers (T-28, T-29).
      Given the gateway's only upstream is `provider: anthropic` with `base_url` on `claude-gw` and `forward_user_identity: true`, when a signed-in user exceeds the APIM per-user tokens-per-minute limit and then the daily quota, then the APIM 429 and then the APIM 403 reach the developer (T-24).
      Depends on: P-4        Unknowns: U-18, U-25, U-26

- [ ] P-17 Route A2 baseline: APIM plus endpoint-managed settings
      Given a route A machine with the managed settings file generated by the accelerator's `New-ClaudeCodePolicy.ps1`, when Claude Code starts, then `/status` shows the managed source and the P-7 deny rules apply without a gateway (T-33).
      Depends on: P-7        Unknowns: —

- [ ] P-16 Comparison run and decision
      Given the parity scenarios PS-1 to PS-11 run on routes A2, B and C, when the results table is filled from recorded runs, then ADR-0002 moves from Proposed to Accepted or Rejected by the criteria in its "Criteria for P-16" section (T-25).
      Given a marker event sent through the collector on the first day of P-9, when the telemetry workspace is searched 29 days and 30 days 12 hours later, then the marker is found and then absent from every table (T-41).
      Depends on: P-5 … P-15, P-17 Unknowns: U-19, U-31

## Later (ideas, not commitments)

- One gateway per business unit, each with its own config and hostname.
- Spend caps managed from infrastructure code through the admin API.
- The Anthropic API as a last-resort upstream; this changes the governing agreement and geography and needs its own ADR.
- The PDF and Word copies of the guide built by a script in this repository, with a check that each copy matches its Markdown and screenshots (ADR-0006: the checker does not read rendered text).
- A scheduled check that the public repository's `main` holds the tree of the last published revision (ADR-0006).

## Out of scope (decided, with reasons)

- CI and unattended jobs through the gateway — gateway sign-in is a browser device flow with no service-token flow ([source](https://code.claude.com/docs/en/claude-apps-gateway#ci-pipelines-and-remote-machines)). CI stays on the APIM route or on Foundry directly (ADR-0002).
- A Windows-hosted gateway — the server runs on Linux only ([source](https://code.claude.com/docs/en/claude-apps-gateway#availability-and-limitations)).
- OTLP over gRPC and SAML identity providers — not supported by the gateway ([source](https://code.claude.com/docs/en/claude-apps-gateway#availability-and-limitations)).

---

## Milestone review

Run at every milestone boundary; answers are written below.

```
□ What shipped vs what we planned?
□ What did we learn that changes the plan?
□ What is now wrong in this roadmap?
□ What new unknowns appeared?              → docs/UNKNOWNS.md
□ What debt did we take on?                → a packet now, or explicitly accepted?
□ Is the charter still right?              → ADR if it changes
```

### M0 review — 2026-09-23
- Shipped: the Ironclad scaffold (P-0) and the planning ledger (P-1).
- Learned: npm on this machine resolves through a package feed proxy that lists Claude Code 2.1.273 as `latest`, while the public changelog lists 2.1.280 (U-5). Packets use only keys available in the build P-3 can obtain.
- Learned: this machine has no Linux runtime (no WSL distribution, no Docker), so P-3 starts by installing WSL2 (U-4).
- Changed after the P-1 council: route A2 (APIM plus endpoint-managed settings) added as an option and packet P-17; P-12 closes the APIM route for migrated users as well as direct Foundry, and P-13 waits for it; route C moved to a separate APIM API with its own key; spend enforcement fails closed from P-8; `parentSettingsBehavior` and its five locks moved to P-14; P-2 now proves the registration itself, not only tenant discovery.
- New unknowns: Entra ID P1 or P2 for group-based assignment (U-24); APIM key header and IP filter (U-25, researched); the gateway's egress address toward APIM (U-26).

### M1 re-plan — 2026-09-23
- Trigger: the owner asked for the gateway to run in an Azure container and be tested. This machine has no Linux runtime and the session has no administrator rights (U-4), so the WSL2 plan for P-3 cannot run.
- Changed: M1 moves to a Container Apps test deployment with ingress limited to the tester's egress range (ADR-0003). P-2 registers the redirect URI on the app's HTTPS address and keeps the client secret in the Container App secret store instead of Key Vault; P-3 boots on Container Apps; P-4 drives Claude Code with the device-flow session token in `ANTHROPIC_AUTH_TOKEN`.
- Changed after the plan review (Astra, 2026-09-23): the app does not require assignment, because an app that requires assignment accepts no user consent and the tester cannot grant admin consent (U-39); the gateway's `allowed_groups` on app roles admits the tester instead. `/login`, the TLS trust prompt, managed-settings delivery and the client's own token refresh are not run in this topology and stay with P-11 and P-7 (T-19, T-45, T-12). The allow lists use 203.0.113.0/26, measured from 34 samples, not the /24 (U-33).
- Unchanged: P-10 keeps the private design (internal environment, Flexible Server, Key Vault, private DNS).
- New unknowns: U-32 to U-40, including the 240-second request timeout of Container Apps HTTP ingress (U-40).

### M3 and M4 re-plan — 2026-09-29
- Trigger: the owner asked for the mutation runs to move to GitHub CI, for step-by-step Microsoft Learn documentation of a network-restricted deployment (Azure portal with screenshots and paths, Azure CLI, and scripts), for Claude Code, the VS Code extension and Claude Desktop with the interactive sign-in, and for a configuration that serves 25,000 developers.
- Changed: the repository moved to a private GitHub repository, `naveenneog/claude-apps-gateway-foundry`, so mutation runs no longer load the shared workstation (P-26). M3 and M4 are now: P-10 keeps its private design as a script-driven deployment, `infra/azure-private`, and its store-outage, backup and log-access criteria move to P-30. The recorded ordering stays: P-10 can be built and tested now, and is marked done only after P-8 makes spend enforcement fail closed and P-9 sends telemetry to Azure Monitor. P-27 adds the VS Code extension; P-28 measures capacity; P-29 writes the Learn articles.
- Learned: `/login` accepts only a gateway whose address is private, and a developer's machine connects to it directly, not through a proxy ([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)); so the interactive sign-in is tested from a developer VM inside the gateway's VNet, which stands in for the corporate network (U-14, U-61).
- Learned: sign-in is limited per client address, 30 starts and 10 code submissions every 10 minutes by default, and each replica sends at most 256 requests upstream at once ([large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts), [concurrent upstream requests](https://code.claude.com/docs/en/claude-apps-gateway-deploy#concurrent-upstream-requests)); P-28 sizes both for 25,000 developers.
- New unknowns: U-54 to U-62.

### Publication — 2026-09-30
- Trigger: the owner gave a customer the network-restricted guide, whose clone command names `naveenneog/claude-apps-gateway-foundry`, and asked for a clean public repository under that name, keeping this one private.
- Changed: P-31 publishes a cleaned copy of HEAD, without the history, as that repository, and this repository moves to `naveenneog/claude-apps-gateway-foundry-private` (ADR-0006). P-31 publishes the files the delivered guide already names, so it does not wait for P-29's open client and capacity checks, which stay open. P-26's runs wait: GitHub Actions jobs in the private repository have not started since 2026-09-29.
- Changed after the P-31 council, round 1: publication is a tested script, `scripts/publish/publish-public.mjs`, which fails closed, instead of a runbook; `scripts/publish/verify-public.mjs` checks every ref of the published repository against every commit of this one; the checker reads UTF-16, Word paragraphs and PDF streams, and refuses containers it cannot read completely.
- Changed after round 5: T-75's criterion covers PDF strings, PNG text chunks and containers inside containers. The round showed text a PDF reader displays that the checker did not read, and the same kind of gap existed in PDF strings, PNG text chunks and nested containers; the tracked exports and screenshots pass, with one new `allow.json` entry for the browser version in the PDF's Creator string.
- Learned: a repository that takes a renamed repository's old name ends GitHub's redirect to the renamed one (U-66), so every clone has to point at the new name first.
- New unknowns: U-66 to U-68.