# Changelog

All notable changes to claude-apps-gateway-foundry, written for a **user**, not a compiler.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- Telemetry for the network-restricted deployment (P-9, ADR-0007). With `deployment.telemetry` in the admin file, the gateway
  sends client metrics, and no logs or traces, to an OpenTelemetry Collector sidecar on its loopback, which exports them
  to Application Insights with the gateway's managed identity; each policy keeps session and account IDs out of the
  metrics. `Deploy-Gateway.ps1 -Step telemetry` makes the component with local authentication off, gives the identity
  Monitoring Metrics Publisher, sets every table of the workspace but `Usage` and `AzureActivity` to 30 days, and
  imports the collector by digest; `-Step verify` posts a metric, a log record and a trace record to the collector and
  finds the metric in `AppMetrics` (T-78, T-32).
- Telemetry checks from P-9's council round 1 (ADR-0007). The telemetry step stops before any change when the
  collector's tag in the registry is at another digest than the pinned one, naming both digests and the `az acr
  repository untag` command, and reads the digest again after an import; it sets the workspace's own retention to 30
  days along with its purge and permission settings. While telemetry is on, the app step refuses to deploy when anyone
  but the operator holds a role of the app registration, since every reader of the workspace can read the telemetry's
  emails until P-32; the entra step reads the holders from every page and stops when a page is missing, fails or holds
  no list. The app step restarts the latest revision when the component's connection string changed. `-Step
  verify` reads the role holders, reports a missing collector answer with the exec exit code and error line, and
  passes T-32 only on 404.
- A public copy of the repository (P-31, ADR-0006). `scripts/publish/check-public.mjs` checks a tree before it is
  published: user profile paths, public IPv4 addresses, Container Apps host names and e-mail addresses by pattern, and
  the words of a deny file kept outside the repository, in text and UTF-16 files, Word parts and paragraphs, the
  strings of PDF objects and the bytes of PDF Flate streams, and PNG text chunks, and in ZIP, PDF and PNG files inside
  other containers; a file it cannot read completely, such as a damaged ZIP, a PDF filter or predictor it does not
  decode, a PDF `/Length` that does not match its stream, a PDF object it did not read, or a PNG chunk it does not
  know, stops the publication. PDF page text is not decoded (ADR-0006 lists what that leaves out).
  `scripts/publish/allow.json` lists the accepted values, each with a reason. Its test, `tests/publish-check.test.mjs`
  (T-75), runs it over the tracked files. `scripts/publish/publish-public.mjs` publishes a committed revision,
  executable bits included, as one commit and refuses a public clone that holds any commit of the private working
  repository (T-77); `scripts/publish/verify-public.mjs` checks every ref of the published repository afterwards
  (T-76). The repository is MIT-licensed (`LICENSE`).

### Changed
- The working repository is `naveenneog/claude-apps-gateway-foundry-private`. `naveenneog/claude-apps-gateway-foundry`
  is public under the MIT license and holds revision `5bed341` as commit `86e3cbe` (P-31, T-76).
- Citations of local copies of other repositories link to those repositories on GitHub, at the commit each copy held
  when cited; ADR-0002 and ADR-0004 name the owner as decider.
- The tester's egress range reads 203.0.113.0/26, an RFC 5737 documentation range, in documents and test fixtures; the
  public test gateway's host reads `<environment>`; the NAT gateway's address in the test VM screenshot reads
  198.51.100.10; the tenant's name and the account's billing state are gone from `docs/STATUS.md`.
- The tutorial's "Get the files" names the public repository, and the PDF and Word copies are rebuilt with it.
- `.github/workflows/ironclad.yml` runs with a read-only token and pins each action to a commit.

### Fixed
- The Learn articles show their screenshots on GitHub. Each of the 20 images in `docs/learn/` used Learn's `:::image:::`
  syntax, which GitHub shows as text; they use Markdown's `![alt](src)` now, which Learn renders too. The tutorial's
  checklist and next-step link, Learn `[!div]` blocks that GitHub also showed as text, are plain lists. T-72 reports
  any Learn extension that GitHub does not render (ADR-0004, amendment of 2026-10-01).
- `Deploy-Gateway.ps1` writes the message of a step that stops as `Deploy-Gateway.ps1: <message>` on standard error,
  without the line breaks PowerShell's error view adds. The view broke long messages at the console width, on Linux inside a word, which split
  the `az acr repository untag` command and Graph URLs the messages name, and failed the public repository's CI (run
  36715159255).
- `Deploy-Gateway.ps1 -Step app` counted a secret read that failed for any reason as a missing secret. On 2026-09-30 the
  Container Apps service answered 503 to a read, and the step appended a new client secret to the app registration; the
  same path could have made a new session-signing secret or a new PostgreSQL password. The step now reads every secret it
  needs before it changes anything, makes a secret anew only when the app does not have it, and stops before any change
  when a read fails for another reason.

### Added
- The mutation checks run on GitHub (P-26): `.github/workflows/mutation.yml`, started by hand, runs the four
  `tests/mutate-*.ps1` scripts on `windows-latest` with Claude Code 2.1.272, the admin script in two shards and the
  developer script in four, and a last job checks that the shards' counts add up to each script's `-List`. The admin
  and developer scripts take `-Shard k/n` and `-List`.
- A network-restricted deployment on Azure (P-10, ADR-0005), deployed and verified on 2026-09-29 in North Central US:
  `infra/azure-private/Deploy-Gateway.ps1` runs one Azure CLI command per documented action for an internal Container
  Apps environment, PostgreSQL with private access, a Foundry account behind a private endpoint with public network
  access and keys off, and a developer VM reached through Azure Bastion; `-Plan` prints each change without making it,
  and `-Step verify` checks from the VM that every name resolves to a private address.
  `scripts/admin/new-gateway-config.mjs --topology private` renders `config/gateway.azure-private.yaml` from
  `config/gateway-admin.azure-private.json`.
- Learn articles for that deployment (P-29): a tutorial in the form of Anthropic's AWS example, with each step in the
  Azure portal (path and screenshot), the Azure CLI and the script; connecting Claude Code, the VS Code extension and
  Claude Desktop with Intune or Group Policy; and planning capacity for 25,000 developers. `tests/learn-media.test.mjs`
  (T-72) checks their images, tabs, `az` commands and steps against the script. PDF and Word copies of the three
  articles are in `docs/export`.

### Changed
- `Deploy-Gateway.ps1` defaults to North Central US and the resource group `rg-claude-gw-internal`: Central US refused
  a new Container Apps environment for lack of capacity, and PostgreSQL is restricted in East US 2 for the test
  subscription (U-63). `-MaxReplicas` defaults to 3, so replicas × `store.max_connections` stays within the 35 user
  connections of PostgreSQL Burstable B1ms.

### Fixed
- `Deploy-Gateway.ps1 -RotateClientSecret` set the new client secret on the Container App, but running replicas kept
  the old one: Container Apps applies a changed secret only when a revision restarts or a new one is deployed. The app
  step now restarts the latest revision when it changed a secret.
- The tutorial's CLI steps, after the council's review: global names derive from the subscription as the script's do,
  PostgreSQL's reply, which repeats the password, is kept off the console, secret files are written with .NET to a folder
  outside the repository, the test machine's password file and policy use the reader's own deployment, and the allowed
  email domain is a variable.
- `Deploy-Gateway.ps1` failed after building the image, because `az acr build` prints its build log, not JSON; the
  build now runs with `--no-logs`, and a build whose status is not `Succeeded` stops the step.
- `Install-ClaudeGatewayProfile.ps1` refused `%USERPROFILE%\.claude` as the profile directory only when it was named
  by its long path. Named by an 8.3 short path, such as `C:\Users\RUNNER~1\.claude` on a GitHub-hosted runner, it was
  accepted and the developer's own settings were overwritten. The profile directory is now compared after the same
  normalisation as the default directory.
- `tests/mutate-admin.ps1` and `tests/mutate-developer.ps1` failed to start the test runner on a machine with two
  `node` programs on `PATH`, as a GitHub-hosted runner has; they now take the first one.
- Inference suite, first live run through the gateway (P-20, 2026-09-28): a stream the suite closes after its first delta
  no longer stops the check with "This operation was aborted"; the sender is in `tests/live/inference-http.mjs`, and
  offline tests run it against a loopback server. T-60 asks for adaptive thinking, which Claude Opus 5 and Sonnet 5
  use, and treats a turn without a thinking block as BLOCKED; a manual thinking budget is its negative. Requests that
  expect text leave room for thinking, which counts toward `max_tokens`, and T-56's `max_tokens` stop may hold only a
  thinking block. T-51 accepts requests that reach the gateway without a session, since a failing `apiKeyHelper`
  leaves them with a placeholder key, and requires a 401 for each.
- Council review of those fixes: the closed stream is cut after its first text, not its first delta, and a floor check
  with no text received is BLOCKED; T-56's `max_tokens` stop needs text or a thinking block; T-60 needs text after the
  thinking and a summary, and asks each model for the manual budget; T-59 leaves room for thinking. The mutation
  suites run Node with `--no-wasm-dynamic-tiering`, after a review saw `--test-force-exit` end Node with an assertion
  after a fetch.
- QA follow-up review: T-51 reads the helper's exit status and its sign-in command from Claude Code's report on stderr,
  `apiKeyHelper failed: exited 1: <message>` (U-53), instead of refusing only Claude Code's exit 0; T-60 fails on a
  text block before the thinking, an empty one included; P-8's `/effective` criterion prices input and cache at 0.01
  USD per million tokens and output at one cent per token, so the input charge cannot account for the rise it requires.
- QA second follow-up review: `runCmd` in `tests/developer/harness.mjs` returns `timedOut` when its time limit stops
  the process tree, and T-51 fails a run stopped that way, or one without an integer exit status, instead of counting
  it as Claude Code's non-zero exit.
- QA third follow-up review: every Claude Code run of T-51 and T-65 counts only when it ended by itself with the status
  its case expects, so a run the time limit stopped with status 0, or an `agentic` run that failed, no longer passes;
  a profile install the time limit stopped fails, and the suite uses no session token from a helper it stopped.

### Changed
- The inference suite sends requests to an APIM route only when `--apim-url` names one. It no longer reads
  `ANTHROPIC_FOUNDRY_BASE_URL` from `%USERPROFILE%\.claude\settings.json`, so a run without `--apim-url` sends nothing
  to the accelerator's APIM route, and the APIM half of `latency` (T-64) is BLOCKED.
- Council round 5 (P-18 to P-21): a failed `latency` sample on either route fails T-64. The credential helper names the
  sign-in command only for the failures a sign-in fixes: after the token expired, a refresh answered with HTTP 429, a
  server error, a redirect or a 200 without a usable token names the gateway operator, an HTTP 4xx refusal other than
  429 and without `invalid_grant` names the sign-in, and a session it cannot save names neither. START-HERE gives the
  discovery fix for HTTP 200 too, and for Claude Code's generic `apiKeyHelper` failure it runs the helper diagnostic
  instead of a sign-in. T-66 and START-HERE's check read messages with one parser that skips comments, and a message
  matches one script line.
- Council round 6 (P-18 to P-21): only an HTTP 4xx answer other than 429 counts as an `invalid_grant` refusal, so a
  200 or 429 answer with an `invalid_grant` body keeps the session and names the gateway operator. START-HERE's
  diagnostic sets every value `gateway.settings.json` pins, as the launcher does, so a provider switch left in the shell
  does not hide the helper's own failure; its discovery fix for HTTP 200 names a gateway or ingress fault as well as a
  proxy's sign-in page, and a declined code is signed in again before the operator is asked for a role. A refused
  `--apim-url` is not repeated in the error.
- Council round 4 (P-18 to P-21): the stream the inference suite closes early gets the same audit as every 200 answer
  on `/v1/messages` to a request with the session token, `ctx.sendExternal` refuses the gateway, and every check runs
  offline against fakes. The suite reads the
  gateway's log with the state file's subscription and stops with exit code 2 when the Azure CLI does not hold that
  subscription in the deployment's tenant. The credential helper's messages for a refresh the gateway did not answer
  and for a lock another process holds say what fixes them and name no sign-in. The troubleshooting article gives the
  Discovery message's fix per HTTP status and has a row for the local sign-in deadline; T-66 counts a message as
  covered only by a row that cites its line, and checks cited line ranges. START-HERE gives the Discovery fix per
  status. `mutate-deploy.ps1` and `mutate-ledger.ps1` apply each literal mutation at exactly one site.
- Council round 3 (P-18 to P-21): the inference suite's checks reach the gateway only through a runner that audits every
  200 answer on `/v1/messages` to a request with the session token, the requests Claude Code sends included; the APIM
  samples of T-64 are not audited. Offline tests run the
  checks against fakes of the gateway, its log and Claude Code. The temporary Claude Code profile is removed after a
  failed install, and T-57 has a check of the gateway's floor price for a stream closed early, BLOCKED on the test
  deployment until P-8 (U-52). `set-developer.mjs` takes
  `--admin`, checks the admin file with the renderer's rules before any Graph request, and grants only a role it
  admits; the rendered configuration names its admin file. START-HERE lists the prerequisites, the commands to run from
  the folder, the common messages and the sign-out. The Learn articles state Claude Code 2.1.272 as the minimum, and the
  troubleshooting article covers every failure message of the developer scripts, which T-66 checks with the message
  parts in order.

### Security
- Inference suite, council round 5 (P-20): `--apim-url` must be an `https` URL without credentials, a query or a
  fragment, checked before any request, because the suite sends the APIM route a bearer token; `ctx.sendExternal`
  refuses `http` too. The APIM token is for `--apim-tenant`, by default the deployment's tenant.
- Admin scripts, council round 4 (P-19): `new-gateway-config.mjs` also refuses C1 control characters, U+2028 and
  U+2029 in the admin file path it writes into the header comment, which YAML 1.1 reads as line breaks.
- Developer scripts, council round 2 (P-18): the launcher passes `--settings <profile>\gateway.settings.json`, which
  ranks above a repository's `.claude/settings.json` and `.claude/settings.local.json`. A repository's
  `ANTHROPIC_BASE_URL`, provider switch, `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` no longer sends the helper's token
  to another host or replaces it (U-50). The helper prints no token while `ANTHROPIC_BASE_URL` is empty or unset or a
  `CLAUDE_CODE_USE_*` switch is set. The installer empties all five provider switches and keeps credentials already in
  a profile out of the PowerShell event log. A `--settings` argument given to the launcher replaces the pinned file.
- Admin scripts (P-19): `new-gateway-config.mjs` refuses a `$` in a model label and in every value it takes from the
  admin file, because the gateway expands `${VAR}` and `${file:...}` references and serves labels to every signed-in
  user.

### Changed
- Council round 2 (P-18 to P-21): `new-client-policy.mjs` writes a `login` folder and a `developer` folder, which are
  alternatives for one machine, takes `--policy-id` for the `.mobileconfig` identifiers, and puts every developer script
  in the `developer` folder. `set-developer.mjs` grants only a role the admin file admits. The inference suite audits
  every 200 answer on `/v1/messages`, exits 2 when a check is BLOCKED and puts a deadline on every request. Each Learn
  article cites a source in every section, and T-66 checks that each troubleshooting message is printed at the line it
  cites.

### Added
- Developer scripts, council round 1 (P-18): `Disconnect-ClaudeGateway.ps1` signs out, revoking the tokens when the
  gateway advertises revocation. The helper prints a token only for the gateway's own `ANTHROPIC_BASE_URL`, keeps
  tokens out of the PowerShell event log, and serves a still-valid token when a refresh fails or the lock is busy. The
  installer keeps each profile on the runtime version it installed, refuses to repoint a profile to another gateway
  without `-ReplaceGateway`, turns off fast mode and its `api.anthropic.com` check, and prints a launcher command that
  runs in PowerShell. A `windows-latest` CI job runs the developer and admin tests. `tests/live/inference-suite.mjs`
  (P-20) runs T-51 and T-55 to T-65 against the Azure test deployment with the helper's session.
- Admin scripts (ADR-0004, P-19). `scripts/admin/new-gateway-config.mjs` renders `config/gateway.azure-test.yaml` from
  `config/gateway-admin.azure-test.json` (admitted app roles, Foundry deployments, and optional per-role model
  allowlists) and checks drift with `--check`. `scripts/admin/set-developer.mjs` grants, removes and lists the gateway's
  app roles through Microsoft Graph. `scripts/admin/new-client-policy.mjs` writes the `/login` payloads
  (`managed-settings.json`, an HKLM `.reg` file, a macOS `.mobileconfig`) and a developer folder with the Windows
  scripts. `tests/mutate-admin.ps1` mutates a temporary copy of the admin scripts.
- Developer scripts for Windows (ADR-0004, P-18), compatible with Windows PowerShell 5.1.
  `scripts/developer/Install-ClaudeGatewayProfile.ps1` writes a separate Claude Code profile, with its own
  `CLAUDE_CONFIG_DIR` and a `claude-gateway.cmd` launcher, that reaches the gateway through `apiKeyHelper` and leaves
  `~/.claude` unchanged. `Connect-ClaudeGateway.ps1` signs in once with the device flow and saves the session encrypted
  with DPAPI for the Windows user. `Get-ClaudeGatewayToken.ps1` prints the access token and refreshes it under a lock
  when fewer than five minutes remain. Tests run the scripts against a loopback fake gateway
  (`tests/developer-helper.test.mjs`, `tests/developer-profile.test.mjs`), including a Claude Code 2.1.272 run through
  the launcher; `tests/mutate-developer.ps1` mutates a temporary copy of the scripts.
- `docs/GATEWAY-COMPARISON.md`: the APIM gateway accelerator at commit `ea31a5f` compared with the Claude apps
  gateway, with advantages and disadvantages, the requirements each route meets, measured results from both
  repositories and the points where the sources differ. Every table row cites a permalink, a documentation
  URL or a file line, and the ledger tests check it. ADR-0002 carries a dated note pointing to it.
- Ironclad engineering discipline: charter, ledger, council and an executable gate. (P-0)
- Planning ledger for running Claude Code on Foundry through the Claude apps gateway: ADR-0002 with a
  cited comparison against APIM and options A1, A2, B, C and D; `docs/ARCHITECTURE.md` with a draft
  `gateway.yaml`; roadmap P-0 to P-17; test plan T-01 to T-41 and PS-1 to PS-11; 31 logged unknowns. (P-1)
- `tests/ledger.test.mjs`: fails when a comparison row, researched unknown, test case or sourced
  ARCHITECTURE row lacks a URL or `path:line`, when a packet lacks Given/when/then criteria, when a
  P-, T-, PS- or U- reference does not resolve, when a pipe row belongs to no table, or when the
  roadmap drops the ordering ADR-0002 depends on. `tests/mutate-ledger.ps1` runs 43 mutations of the
  rules and docs and exits 1 unless each one fails the suite with every test loaded. (P-1)
- Azure test deployment (ADR-0003). `node infra/azure-test/deploy.mjs` creates a resource group with a
  registry, a managed identity, a Log Analytics workspace and a Container Apps environment; registers
  the Entra app; builds the gateway image with ACR Tasks from the signed Claude Code 2.1.280 release;
  and deploys the gateway with a PostgreSQL sidecar. `teardown.mjs` removes all of it. (P-2, P-3, P-4)
- Unit tests for the deployment files (`tests/deploy-*.test.mjs`, `tests/live-lib.test.mjs`) and
  behavioural tests of `verify-release.sh` with throwaway signing keys (`tests/verify-release.test.mjs`);
  `tests/mutate-deploy.ps1` breaks 108 properties of the deployment files and guards, and each one fails the suite.
- Live checks (`tests/live/gateway-live.mjs`). On 2026-09-23: T-01, T-02, T-03, T-05, T-42 and T-43
  pass; the checks that need a browser sign-in are blocked. Results in `docs/TEST-PLAN.md`.

### Changed
- M1 re-planned from a WSL2 run on the dev box to a test deployment on Azure Container Apps with ingress
  limited to the tester's egress range (ADR-0003). P-2 to P-4 re-scoped; the app does not require
  assignment, because the tester cannot grant admin consent (U-39); `/login`-based checks stay with
  P-11 (T-19, T-45). Unknowns U-32 to U-40 and test cases T-42 to T-47 added; U-1 and U-5 closed.
- The ledger checks cover every decision record in `docs/adr/`; the mutation run has 55 mutations.
### Fixed
- After council round 1 (Astra, 2026-09-23): a new client secret starts a revision before the old key
  is removed, and a failed rotation discards its pending key; teardown finds the identity's Foundry
  grants by principal and keeps its state file with `--no-wait`; output is redacted before it is
  shortened; the `denied` check never re-grants a revoked role, and checks that remove access write a
  restore record first; live checks read audit events between two control requests matched by
  `x-request-id`, and the log parser now reads the Container Apps stream's timestamped lines, which
  made the first T-42 "no gateway event" result vacuous; negative checks require the specific status or
  error code; the ledger refuses a done packet whose cases lack PASS results.
- After council round 2 (Astra, 2026-09-23): the app step decides from the live app which client
  secret is installed and which one the ready revision reads (`keyPlan`), reuses a key that an
  interrupted run already installed, and removes other keys only after the new revision is ready with
  the new key; `--rotate-client-secret` rotates on request. Every ARM deployment is previewed with
  what-if first, and the preview lists changed property paths; `--what-if` writes no state. The state
  file records the tester range only after the app step applies it, and every Foundry account a run
  named, for teardown. A transport failure while removing access keeps its restore record; another
  check cannot replace it, the checks that remove access wait until it is repaired, and the run ends
  with `ACCESS NOT RESTORED` and the repair command. Live evidence needs the upstream, model and
  subject fields of each event (BLOCKED when missing), a refusal tied to the tested token or sign-in,
  and the refresh of the tested request; T-08 stays BLOCKED until its negative exists. The ledger uses
  each case's latest result and needs evidence, including evidence after "Negative:".
- After council round 3 (Astra, 2026-09-23): the restore record enters `restoring` before every grant that
  undoes a removal, and only a 4xx other than 408 counts as a call that changed nothing, so a restore whose
  response was lost is never repeated over a later revocation. The CLI check runs Claude Code through a
  loopback relay that records each response's `x-request-id`, and counts only those requests' audit
  events; its refused run sets `CLAUDE_CODE_MAX_RETRIES=0`, because Claude Code otherwise retries a 401
  ten times (U-46). A sign-in refusal counts only with the flow's `user_code`. The app step keeps every
  key while a ready revision names none; each deployment saves its Foundry account before it runs and
  its outputs, the grant ID included, after; the printed repair command names the deployment's resource
  group, email domain and Foundry account.
- After council round 4 (Astra, 2026-09-23): the capture relay passes failures through. A response the
  upstream cuts short breaks the client's connection, a client that goes away cancels its upstream request,
  and closing the relay ends every upstream connection, idle ones included; each such request is recorded
  with its error. The refused CLI run is judged on the CLI's own requests only.
- After council round 5 (Astra, 2026-09-23; fixed 2026-09-26): the CLI check reads the relay's capture
  after the relay has closed, so a request still open when Claude Code exits is part of the evidence.
  The deployment mutation run uses `--test-force-exit` and a 120-second test timeout, so a mutation that
  leaves a server open fails its suite instead of stopping the run.
### Removed
