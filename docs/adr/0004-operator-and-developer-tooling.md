# ADR-0004: Operator and developer tooling for the Azure test deployment

- **Status:** Accepted
- **Date:** 2026-09-28
- **Packet:** P-18, P-19, P-20, P-21
- **Deciders:** owner

## Context

- The owner asked for admin and developer scripts for the Claude apps gateway, similar to those of the
  APIM accelerator, plus thorough inference tests and documentation in Microsoft Learn style.
- The accelerator ships an admin installer, onboarding and policy generators, and a developer
  workstation setup for three clients
  ([README](https://github.com/naveenneog/claude-code-foundry-gateway/blob/ea31a5fd242ee11fcb94c5ee2d2e6935d6ebcbdc/README.md?plain=1#L111-L122)).
- Claude Code's `/login` accepts only a gateway whose name resolves to private addresses
  ([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)); the test gateway
  has a public Container Apps address (ADR-0003). The gateway URL for `/login` comes only from a managed
  source on the machine ([set the gateway URL](https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url)),
  and this machine has no administrator rights (U-4).
- `apiKeyHelper` runs a command through `cmd` on Windows, sends its output as `Authorization: Bearer`,
  and reruns it after five minutes, after a 401 or 403, and before a request when its cached JWT has
  expired ([settings reference](https://code.claude.com/docs/en/settings-reference#apikeyhelper)).
- The gateway's token endpoint implements the RFC 8628 device grant and a refresh grant that returns a
  new refresh token; `401 invalid_grant` requires a new sign-in (`GET /protocol` on the test gateway,
  saved as `tests/live/out/protocol.txt`).
- Measured 2026-09-28: Windows PowerShell 5.1 protects and unprotects data with DPAPI
  (`System.Security.Cryptography.ProtectedData`, CurrentUser scope), also when started from `cmd`.
- Three device-flow sign-ins expired on 2026-09-23 and one on 2026-09-28 with no one at the browser,
  so live inference evidence waits on a person each time.

## Options considered

1. **Developer sign-in through `/login`.** The documented client path; managed settings per group reach
   the client. Needs a private address (M3) and machine-level managed settings, which need
   administrator rights. Not possible for the test deployment.
2. **A session token in `ANTHROPIC_AUTH_TOKEN`.** What the live harness does. The token lasts one hour
   and the developer repeats the device flow each time.
3. **A developer credential helper behind `apiKeyHelper`.** One device-flow sign-in; the refresh token is
   kept encrypted with DPAPI for the Windows user; each call returns a valid access token, refreshing
   when needed. Claude Code reruns the helper on expiry and on 401.
4. **Tokens minted by the operator with the gateway's JWT secret.** Tests inference without a person but
   skips the sign-in, depends on an undocumented claim layout, and the harness would hold a signing key.

## Decision

- **Developer side: option 3**, in Windows PowerShell 5.1 compatible scripts under `scripts/developer/`,
  so a developer machine needs no Node.js. A dedicated Claude Code profile (its own `CLAUDE_CONFIG_DIR`)
  carries `ANTHROPIC_BASE_URL` and the helper, and leaves the developer's existing settings untouched
  (U-38). macOS and Linux are a later packet: nothing here can run them (U-4).
- **Test side:** the live checks take their session from the same helper, so one sign-in serves every
  later run until the refresh grant fails.
- **Admin side:** Node.js scripts under `scripts/admin/`, built on the tested libraries in
  `infra/azure-test/lib/`: a gateway configuration generated from one admin file, developer onboarding
  through app role assignments, model changes, client policy payloads for the `/login` topology, and
  checks of the live controls.
- **Documentation:** articles in Microsoft Learn format under `docs/learn/`, with a `toc.yml`.
- Option 4 is not used.

## Consequences

- One browser sign-in unblocks all later live inference runs, until the refresh grant returns
  `invalid_grant`.
- In the helper profile Claude Code treats the gateway as an LLM gateway, not a signed-in gateway
  session: the gateway still enforces model access and spend, but per-group managed settings and pushed
  telemetry settings do not reach the client. The `/login` path stays with P-11.
- The refresh token is a bearer credential at rest on the developer machine, readable by any process
  running as that Windows user; DPAPI protects it from other users and other machines, not from malware
  running as the user.
- Two languages: PowerShell for developers, Node.js for operators and tests.

## Amendment, 2026-09-28: council round 1 on P-18

The five council seats reviewed commit `23cfd36`. These decisions follow from their findings (docs/STATUS.md):

- **Runtime versions.** The installer copies the runtime to `%LOCALAPPDATA%\ClaudeAppsGateway\bin\<version>`, where
  `<version>` is the first 12 hexadecimal characters of a SHA-256 over the runtime files, through a temporary directory
  and one rename. A profile's `apiKeyHelper` names its version, so a newer runtime leaves older profiles on theirs.
  Old versions are not removed.
- **Session format.** The DPAPI entropy prefix `claude-apps-gateway/v1` versions the session file. A later format uses
  a new prefix; an older runtime then reports an unreadable session and names the sign-in command.
- **One gateway per profile.** Installing another gateway into an existing profile stops unless `-ReplaceGateway` is
  given; the message names `-ProfileDir %USERPROFILE%\.claude-apps-gateway-<host>`. Sessions are kept per origin.
- **Credential precedence.** The installer removes `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` from the profile's
  `env`, and the launcher clears them from the calling shell, because both outrank `apiKeyHelper`
  ([authentication](https://code.claude.com/docs/en/authentication)).
- **Helper cache lifetime.** The profile sets `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` to 240000, below the helper's
  300-second refresh window, so a token Claude Code caches has at least 60 seconds left when its cache ends. User
  settings `env` values apply at startup ([settings reference](https://code.claude.com/docs/en/settings-reference#when-claude-code-applies-env-values)).
  A rerun after a 401 returns the same token until that window; a session the gateway ends early recovers at the next
  refresh or through `Connect-ClaudeGateway.ps1`.
- **Host names.** A gateway host is ASCII letters, digits, dots, hyphens and underscores, or an IP address, because the
  origin is written into a cmd command line; an internationalised name is given in its `xn--` form. An IPv6 host is
  compared in its RFC 5952 short form, which Windows PowerShell 5.1 and PowerShell 7 both produce through
  `IPAddress.ToString()`.
- **Proxy.** The scripts use .NET `HttpClient` with the Windows proxy settings (Internet Options) and do not read
  `HTTPS_PROXY`; a connection failure message says so.
- **Launcher target.** Behind npm's `claude.cmd` the launcher runs the native `claude.exe` from
  `node_modules\@anthropic-ai\claude-code\bin`. Any other `.cmd` runs through `call`, because a batch file started
  without `call` does not return and its `endlocal` would undo the launcher's environment. Paths under
  `%LOCALAPPDATA%`, `%APPDATA%` or `%USERPROFILE%` are written relative to that variable, because cmd reads the
  launcher in the console code page.
- **Sign-out.** `Disconnect-ClaudeGateway.ps1` sends both tokens to the gateway's `revocation_endpoint` when it is
  advertised (RFC 7009, tests/live/out/protocol.txt:40-47) and deletes the session.
- **Concurrency.** `Connect-ClaudeGateway.ps1` saves under the helper's lock, so a refresh in progress cannot overwrite
  or delete a new sign-in. A save retries for five seconds while another process has the file open.
- **Tokens and PowerShell logging.** With module logging on (event 4103 in Microsoft-Windows-PowerShell/Operational,
  readable by interactive users on this machine), Windows PowerShell 5.1 records each parameter value of a logged
  command: a PSCustomObject and a byte array with their content, a dictionary by its type name only (measured
  2026-09-28). So token-bearing JSON is parsed and written with .NET methods (JavaScriptSerializer in 5.1,
  Newtonsoft.Json in PowerShell 7) inside the function that holds it, and sessions and token answers travel as
  dictionaries. A test turns on pipeline logging for the module and the core modules, signs in, refreshes, and finds no
  token or device code in the new 4103 events.
- **Where the token goes.** Claude Code passes its settings `env` to the helper, and a repository's
  `.claude/settings.json` can set `ANTHROPIC_BASE_URL`. The helper prints the token only when `ANTHROPIC_BASE_URL` is
  unset, names the gateway, or names the origin given with `-ExpectedBaseUrl` (a test relay). The profile empties
  `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` rather than removing them, because an empty value cancels a shell
  export ([settings reference](https://code.claude.com/docs/en/settings-reference#env)), and turns fast mode and its
  availability check off, because that check sends an `apiKeyHelper` key to `api.anthropic.com`
  ([fast mode](https://code.claude.com/docs/en/fast-mode)). Measured with TLS interception on 2026-09-28: `-p` runs of
  Claude Code 2.1.272 through the profile sent `GET /mcp-registry/v0/servers` and `POST /api/event_logging/v2/batch`
  to `api.anthropic.com`, neither with the gateway token (U-49).
- **Loopback http.** The scripts accept `http://` for a loopback address, which the tests use. On a machine shared with
  other users, a process of another user that holds the port would receive the refresh token.

## Amendment, 2026-09-28: council round 2 on P-18 to P-21

The five seats reviewed commit `56faa79`; their findings and the fixes are in docs/STATUS.md. These decisions follow:

- **Pinned settings.** The launcher passes `--settings <profile>\gateway.settings.json`, which holds `apiKeyHelper`
  and the `env` values that decide where the token goes: `ANTHROPIC_BASE_URL`, empty `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_API_KEY` and five provider switches, fast mode off, and the helper cache lifetime. `--settings` ranks
  above a repository's `.claude/settings.json` and `.claude/settings.local.json`, and the profile's `settings.json`,
  a user-level file, ranks below them ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)).
  Before the pin, eight repository settings files sent the model requests to another host or to `api.anthropic.com`,
  and two more replaced the helper's token with their own credential; with it, none did (U-50). The pinned file comes
  before the developer's arguments. Claude Code uses only the last `--settings`, so one the developer passes replaces
  the pinned file; the docs say so, and a test fails when a release merges them. Options not taken: the pinned file
  after the arguments, which would drop the developer's `--settings` without a message and would become prompt text
  after a `--` argument; `--setting-sources user`, which drops every project setting, including permissions and MCP
  servers; and a check in the launcher for a `--settings` argument, which cmd splits differently from `claude.exe`.
- **Helper checks.** The helper prints no token when `ANTHROPIC_BASE_URL` is empty or unset, because Claude Code then
  sends it to `https://api.anthropic.com`; this replaces the round-1 rule that let an unset value pass. It prints none
  while a provider switch (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`, `_MANTLE`) has a value,
  because a switch with its skip-auth variable sends the helper's output to that provider's base URL
  ([environment variables](https://code.claude.com/docs/en/env-vars)); the skip-auth and base URL variables act only
  with a switch on. A person who runs the helper by hand sets `ANTHROPIC_BASE_URL` first.
- **Installer JSON.** The installer parses the profile's `settings.json`, which can already hold credentials, into
  dictionaries: JavaScriptSerializer in Windows PowerShell 5.1, and in PowerShell 7 Newtonsoft's token tree converted
  to dictionaries and lists without passing a token object to a command, with date-like strings kept as strings. It
  writes the file with `ConvertTo-Json` (5.1) or Newtonsoft (7). With module logging on, an API key and a bearer token
  already in the profile no longer reach event 4103 (T-50).
- **Model labels.** The gateway expands `${VAR}` inside any value and a whole `${file:/path}` value
  ([secret expansion](https://code.claude.com/docs/en/claude-apps-gateway-config#secret-expansion)) and serves labels
  to every signed-in user, so `new-gateway-config.mjs` refuses a `$` in a label, and its renderer refuses a `$` in
  every value it takes from the admin file.
- **Admin files.** The config renderer keeps the ADR-0003 topology in code, next to the rendering of the admin file,
  and the golden test compares the checked-in configuration with its rendering. `set-developer.mjs` grants only a
  role the admin file admits; removal is always allowed.
- **Client topologies.** The `login` folder, whose managed settings force the gateway sign-in, and the `developer`
  folder are alternatives for one machine: with `forceLoginMethod` set to `"gateway"` in managed settings, Claude Code
  skips `apiKeyHelper` ([authentication](https://code.claude.com/docs/en/authentication)). START-HERE.txt and the admin
  how-to say so. The installer does not read the machine policy, which lives in HKLM or under Program Files, where the
  tests cannot write without elevation.
- **Lock wait.** A process that finds the session lock taken prints one line to stderr. The tests wait for that line
  instead of sleeping, so a script that ignored the lock fails the wait.

Consequences: a repository can still run commands through hooks once its folder is trusted
([permissions](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder)), and such a command
runs as the developer and can read the DPAPI session. The pin guards against a repository's settings naming another
endpoint, not against a hostile repository the developer trusts. Claude Code started without the launcher, or with a
`--settings` of the developer's own, has only the helper's checks, which apply once the helper sees the repository's
values.

## Amendment, 2026-09-28: council round 3 on P-18 to P-21

Architect, QA and UX reviewed commit `273a004` and blocked; the Coder and Security replies were withheld by a content
filter. The findings and fixes are in docs/STATUS.md. These decisions follow:

- **The inference suite's structure.** The checks are in `tests/live/inference-checks.mjs` and reach the network only
  through their context. The runner, `tests/live/inference-runner.mjs`, records each gateway request a check sends and
  matches every 200 answer on `/v1/messages` to its `inference` event, and `ctx.auditCaptured` does the same for the
  answers Claude Code gets through the capture relay. The APIM samples of T-64 go through a sender that is not
  audited, because the APIM route has no gateway audit. A static test fails when a check sends, fetches or starts a
  process by itself, and offline tests run the checks against fakes of the gateway, its log and Claude Code. The
  temporary profile is registered for removal as soon as it exists, and a failed removal is reported.
- **T-57's negative.** The gateway bills a stream the client closes early at a floor of about four characters per
  output token for the text sent to the client
  ([how requests are priced](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-requests-are-priced)).
  The check requires output tokens of at least ceil(characters received / 4), at most `max_tokens`, and a total cost
  above zero. The per-token rate is Claude Code's cost table on the gateway and is not checked.
- **One admin file.** `set-developer.mjs --admin` reads the admin file `new-gateway-config.mjs` renders from, checks
  it with the renderer's rules before any Graph request, and grants only a role it admits; `setDeveloper()` refuses a
  grant without the admitted roles. The rendered configuration's header names its admin file.
- **The macOS configuration profile's identity.** `new-client-policy.mjs` derives the profile's `PayloadIdentifier`
  and `PayloadUUID` from `--policy-id`, default `default`, not from the gateway URL. A new gateway address with the
  same policy ID therefore updates the profile an MDM already holds, where a URL-derived identity would leave the old
  profile installed, still forcing the old gateway. `default` assumes one gateway policy per organisation; an
  organisation with two, such as a staged rollout to a second gateway, passes a distinct ID for each, and two
  policies with the same ID replace each other on a device. Options not taken: identifiers from the URL, for the
  reason above, and random identifiers, which add a profile on every run.
- **The supported Claude Code version.** The documented minimum is 2.1.272: the settings precedence and the
  last-`--settings` rule the launcher depends on were measured with it (U-50), and the CI job installs it. The
  protection is not claimed for older releases. When the CI pin moves, the repository cases and the characterization
  test in `tests/developer-profile.test.mjs` run against the new release.
- **The developer folder stands alone.** `START-HERE.txt` states the prerequisites, the commands to run from the
  folder, the common messages with their fixes, and the sign-out; a test runs its install command from the folder.
- **Learn checks.** A message in a troubleshooting table matches its source line in order, part by part; a code
  citation lands on a line with code or a comment; every message the developer scripts print on failure has a row.
- **Open notes.** The shared audit reader and the profile-owned helper option are P-22; the project settings
  diagnostic is P-23.

## Amendment, 2026-09-28: council round 4 on P-18 to P-21

Five seats reviewed commit `db679b3`. Architect, QA and UX blocked; Coder and Security passed with notes. The findings
and fixes are in docs/STATUS.md. These decisions follow:

- **One audit for every successful model answer.** The stream that the `stream` check closes early is audited by the runner
  like every 200 answer on `/v1/messages`: status, upstream, model and subject. T-57's floor price is checked on the
  same event as well. The suite expects status 200 for that event, the status the gateway sent before the close
  (U-51). `ctx.sendExternal` refuses a request without a URL or to the gateway's origin, so no gateway answer leaves
  the audit through it. Offline tests run every check against fakes, and the stream check with its closed stream's
  event varied.
- **The APIM route only on request.** The suite sends nothing to an APIM route unless `--apim-url` names one. It no
  longer reads `ANTHROPIC_FOUNDRY_BASE_URL` from the tester's Claude Code settings (owner's instruction, 2026-09-28).
- **The Azure account.** The suite reads the gateway's log with the state file's subscription, and stops with exit
  code 2 when the Azure CLI does not hold that subscription in the deployment's tenant.
- **Learn checks.** A cited range starts at line 1 or later and ends at or after its start. A developer script's
  message is covered only by a row whose Source cites its file within one line and whose message parts match it in
  order; a reason that another message prints as its `<reason>` is covered by that message's row when the row quotes
  it. START-HERE's quoted messages are compared part by part, in order, on one script line.
- **A mutation entry names one site.** In `mutate-deploy.ps1` and `mutate-ledger.ps1`, as in the admin and developer
  mutation scripts, a literal entry whose text does not occur exactly once is NOT APPLIED.
- **The header path.** `new-gateway-config.mjs` also refuses C1 controls, U+2028 and U+2029 in the admin file path,
  which YAML 1.1 reads as line breaks.
- **Open notes.** P-22 is the shared audit reader only. The profile-owned helper option is P-24, and the installer's
  version check P-25. The launcher does not refuse a `--settings` argument of the developer's own (U-50); P-23's
  diagnostic names the keys that argument would let through.

## Amendment, 2026-09-28: council round 5 on P-18 to P-21

Five seats reviewed commit `5c66b56`. Architect, QA and UX blocked; Coder and Security passed with notes. The findings
and fixes are in docs/STATUS.md. These decisions follow:

- **The APIM route over https only.** `--apim-url` is checked before any request: an `https` URL without credentials,
  a query or a fragment, since the suite sends it a bearer token; its base path is kept. `ctx.sendExternal` refuses
  `http` as well. The APIM token is for `--apim-tenant`, by default the deployment's tenant, which the account check
  confirms the Azure CLI holds. The account check stays in the runner module, which holds the suite's testable
  adapters; the suite wires them to Azure.
- **Which failures name the sign-in.** The credential helper adds the sign-in command only where a sign-in is the fix:
  no session, an unreadable one, an expired one without a refresh token, `invalid_grant`, and, after the token
  expired, another HTTP 4xx refusal than 429, because how the gateway refuses a replaced refresh token is open
  (U-48). A refresh the gateway did not answer names no command; HTTP 429, a server error, a redirect or a 200
  without a usable token names the gateway operator; a session the helper cannot save names neither, since the
  sign-in saves the same way. START-HERE sends Claude Code's generic `apiKeyHelper` failure to the helper diagnostic,
  whose message then says which of these applies.
- **`latency` fails on a failed request.** A failed sample on either route makes T-64 FAIL, with the failures and no
  percentiles, since the comparison needs every request of both routes to succeed.
- **One reading of the scripts' messages.** T-66 and START-HERE's check take messages from `tests/message-rules.mjs`:
  throw, `Write-Diagnostic` and stderr lines, not comments. A message matches one script line. A reason that another
  message prints as its `<reason>` is covered by that message's row only when it is listed in `WRAPPED_REASONS`, so a
  message cannot borrow another message's row.
- **Mutation runs on a shared machine.** The developer mutation run takes about 90 minutes of four parallel suites
  that start Windows PowerShell and Claude Code. It slowed another agent on the same machine, and the owner stopped it
  on 2026-09-28. The runs are started only with the owner's agreement; docs/TEST-PLAN.md gives each script's last
  completed run and its current number of mutations, and a change is checked meanwhile by breaking the property in a
  copy and running the one test file that guards it.

## Amendment, 2026-09-28: council round 6 on P-18 to P-21

Architect and QA passed commit `31263a1` with notes; UX blocked. The findings and fixes are in docs/STATUS.md. These
decisions follow:

- **What counts as `invalid_grant`.** Only an HTTP 4xx answer other than 429 with `error: invalid_grant` deletes the
  session. A 200 or 429 answer with that body is a gateway fault or a throttle, keeps the session, and names the
  operator, as a 200 without a usable token does.
- **The diagnostic runs as the launcher does.** START-HERE's and the troubleshooting article's diagnostic set every
  `env` value `gateway.settings.json` pins, in a new window, so a variable left in the developer's shell cannot change
  which message the helper prints.
- **A refused URL is not echoed.** `--apim-url` can hold a key in its query or a password; its errors name only the
  scheme.

## Amendment, 2026-09-28: the first live inference run

After the owner's sign-in, the suite ran against the Azure test deployment; docs/TEST-PLAN.md holds the results. Five
checks failed for reasons in the suite, which change these decisions:

- **The models think adaptively.** On Claude Opus 5 and Sonnet 5 thinking is on by default, a manual budget
  (`thinking.type` `enabled`) gets 400, and thinking tokens count toward `max_tokens`
  ([thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)). T-60 asks for adaptive thinking with
  its summary shown and `effort` `high`; since no setting guarantees a thinking block, a turn without one is BLOCKED,
  and the manual budget is the negative. Requests that expect text ask for 1024 tokens, and T-56's `max_tokens` stop
  may hold only a thinking block.
- **A failing `apiKeyHelper` still sends requests.** Claude Code then uses a placeholder key
  ([gateway troubleshooting](https://code.claude.com/docs/en/llm-gateway-connect)), so T-51's run without a session
  requires a 401 for each request that reaches the gateway, not the absence of requests. Two did in the run, and each
  got 401. In `-p` mode Claude Code's report on stderr, `apiKeyHelper failed: exited 1: <message>`, holds the helper's
  exit status and its sign-in command, and T-51 requires both, and that Claude Code exits by itself before the suite's
  time limit (U-53; QA follow-up reviews of the live-run fixes). Every Claude Code run of T-51 and T-65 counts only
  when it ended by itself with the status its case expects: a run the time limit stopped can carry status 0.
- **The sender is testable offline.** The suite's HTTP sender is `tests/live/inference-http.mjs`; a loopback server
  shows that a stream closed after its first text returns without an error, that redirects are not followed, and that
  each request carries the bearer token, its body and a deadline. The cut waits for text, since adaptive thinking can
  start a stream with thinking deltas; a floor check with no text received is BLOCKED (council review of the
  live-run fixes).
- **T-57's floor price needs another record.** The `inference` event holds no token or cost field, so the floor price
  of a stream closed early cannot be read from it. The gateway keeps spend only as per-person counters in USD cents,
  which `GET /v1/organizations/spend_limits/effective` serves once P-8 adds the `admin:` block (U-52); the negative
  stays BLOCKED until then. It is decided with an output rate of one cent per token and input and cache rates of 0.01
  USD per million tokens, since no override rate can be 0, so the input charge cannot reach the floor estimate, and
  with a control pair of reads (ROADMAP P-8; QA follow-up review of the live-run fixes).

## Amendment, 2026-10-01: Learn articles that GitHub renders

The owner reported that the documentation on GitHub showed no screenshots. GitHub's renderer showed each of the 20
`:::image:::` references in `docs/learn/` as a paragraph of text, and the two `> [!div ...]` blocks of the tutorial as
text too; the 19 PNG files and the SVG were intact (docs/TEST-PLAN.md, T-72).

| Fact | Source |
|---|---|
| Learn parses CommonMark through Markdig; Markdown's `![<alt text>](<folderPath>)` embeds an image, and for standard images "the older Markdown syntax will still work", while `:::image:::` is recommended for features such as a localization scope | [Markdown reference for Microsoft Learn](https://learn.microsoft.com/en-us/contribute/content/markdown-reference#images), updated 2024-03-05, read 2026-10-01 |
| Content that relies on Learn's extensions is not rendered in the GitHub view of an article | The same reference, "Included Markdown files" |

- **Images** in `docs/learn/` use Markdown's `![alt](relative path)`, with alt text, which both Learn and GitHub render.
- **No Learn extension that GitHub shows as text:** no `:::` extension and no `[!div]`, `[!INCLUDE]` or `[!VIDEO]`
  block. GitHub's alerts, such as `> [!NOTE]`, render on both. The tutorial's tabs, `# [Azure portal](#tab/portal)`,
  stay: GitHub shows each as a heading with its content, and Learn shows them as tabs.
- T-72 enforces both rules (tests/learn-media.test.mjs).
- Consequence: Learn's image border, localization scope, checklist style and next-step button are not used. The
  repository has no Learn build; the articles are read on GitHub and in the PDF and Word copies.

## How we'd know this was wrong

- The gateway refuses the helper's token when Claude Code sends it through `apiKeyHelper`, or accepts
  it only in `ANTHROPIC_AUTH_TOKEN` (U-47).
- A refresh invalidates tokens held by other processes in a way the cache cannot follow (U-48).
- Claude Code fetches `/managed/settings` in the helper profile, which would change the consequence
  above.
- A Claude Code release ranks project settings above `--settings`, or merges `--settings` arguments: the repository
  cases or the characterization test in tests/developer-profile.test.mjs fail (U-50).
- An MDM tells configuration profiles apart by something other than `PayloadIdentifier`, so a new gateway URL
  with the same `--policy-id` installs a second profile.
- The gateway records the `inference` event of a stream the client closed with a status other than 200: T-57 fails
  and names the status (U-51).
