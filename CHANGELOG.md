# Changelog

All notable changes to claude-apps-gateway-foundry, written for a **user**, not a compiler.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- The gateway signs in to Microsoft Entra ID with its own certificate instead of a client secret (P-45, ADR-0016 amended). The `app` stage makes a self-signed RSA 2048 certificate, valid for `-CredentialValidityMonths` (1 to 24, default 12), registers it on the gateway's app registration and removes the client secrets the installer made. The new daily job `job-signin-renewer` replaces it 30 days before it ends, in the gateway's rotation order, so developers stay signed in; **Settings** > **Gateway sign-in credential** in the console shows it and has **Renew now**. If the tenant refuses a certificate, the install falls back to a client secret, now 1 to 365 days (`-ClientSecretDays`, default 365), which the same job renews. Tested live on Contoso: Entra accepted the deployed certificate, refused an unregistered one with `AADSTS700027`, and a forced renewal took 57 seconds. Key Vault is not used: the test tenant's policy forces vaults private, which a Container Apps environment without a virtual network cannot reach (U-137).
- The entra stage takes the domain of the installing account's sign-in name when the account has no e-mail address, as in many trial tenants, and says so, instead of stopping.
- Install into an existing resource group (P-46, ADR-0018): `-UseExistingResourceGroup` adds the installer's resources next to what the group holds, such as the Foundry account, and stops if a resource there is named like one it creates. Everything the installer adds, the admin console's resources included, carries the install's `runId` tag; teardown removes only those and never deletes the group.
- A read-only `preflight` stage (P-48, ADR-0018), which `-Plan` also runs: it checks the resource group, the Foundry account and each deployment the admin file names, and whether each database region offers PostgreSQL 16 on Burstable B1ms to the subscription. `-DatabaseLocation` takes a list such as `eastus,centralus,westus3`; the `base` stage creates the managed database first and moves to the next region when one refuses, so a refused region shows in the first minutes instead of at the end.

### Changed
- The gateway image moves to Claude Code 2.1.311 (from 2.1.280) on a refreshed Azure Linux 3.0 base digest; its entrypoint skips the database wait when the database is managed. The admin console's image moves from `node:22-alpine` to Microsoft's distroless Node.js 24 image from mcr.microsoft.com, pinned by digest and run as a non-root user with no shell. A managed-database install no longer imports the `postgres` image into its registry.
- The installer leaves the gateway and the admin console open to every address unless told otherwise (P-47, ADR-0017). Access still needs Entra sign-in: a gateway app role for the gateway, `AdminUi.Admin` for the console. `-TesterCidr` limits the gateway and `-AllowedCidr` the console, each on its own; `-NoSignIn` still requires a range. An install made before this change keeps its recorded range, and `-GatewayAllowAnyAddress`/`-ConsoleAllowAnyAddress` reopen it. Verified that the gateway accepts `0.0.0.0/0` in `access_control.allow_cidrs` (U-134).

### Fixed
- The installer no longer stops when Azure answers a status check with a temporary error, such as the `503` an install's `app` stage got on 2026-11-03 while its deployment kept running: reads to Azure Resource Manager and Microsoft Graph are retried on 429, 500, 502, 503 and 504, honouring `Retry-After`; writes are never repeated (T-149). The tutorial's stops table says how to resume an install that stopped this way.

### Added
- Business-unit tags in the gateway database (P-44, ADR-0015): **Chargeback** > **Business units** sets each person's department, cost center, company, office and division, and **Import CSV** sets many at once. Tags are kept in the managed PostgreSQL by Entra object ID; Entra ID is not changed. `Deploy-AdminUi.ps1` no longer offers `-GrantUserWrite`, and the console no longer needs `User.ReadWrite.All`; a leftover grant is reported with the command that removes it. Chargeback reads departments from tags only, so values set in Entra earlier are entered again in the console or imported. Tags need the managed database option.
- Soft limit with daily pacing (P-43, ADR-0014): past a share of a person's monthly spend cap, for example 80%, the scheduled job `job-spend-pacer` gives them a daily cap of the rest of the cap over the days left in the month, under its own `spend-pacer` key, and deletes only the daily caps it set. A lower role or organization daily cap applies instead, and an administrator's per-user daily cap is never changed. The admin console's **Access & models** page has a **Soft limit** card; the gateway's refusal explains the daily limit, and Claude Code warns at 75% and 95% of it. Both installers add the `admin-pacer-key` secret (`GATEWAY_ADMIN_PACER_KEY`), and the console refuses to turn the soft limit on for a gateway without it. Tested live on the Contoso gateway: [how-to](docs/learn/how-to-admin-configure.md#pace-the-last-part-of-a-monthly-cap-with-a-soft-limit).
- Client kit and Help in the admin console (P-41): **Settings** > **Client onboarding** downloads, for a model of the admin file, the files `new-client-policy.mjs` writes for this gateway as `client-policy.zip`, or one of them, through `GET /api/client-kit`. A new `desktop` folder holds Claude Desktop's `bootstrapUrl` policy as `ClaudeDesktop-HKLM.reg`, the Intune platform script `Set-ClaudeDesktopPolicy.ps1` (it stops in a 32-bit PowerShell host) and `DESKTOP.txt`; `New-IntunePackage.ps1` is copied to the top of the folder. A **Help** page lists each administrator task with its steps and article. New article: [Group developers into departments and teams](docs/learn/how-to-organize-departments.md), with screenshots on made-up data.- Per-role Claude Desktop switches (P-40): a policy's `desktopSettings` in the admin file sets `chatTabEnabled`, `coworkTabEnabled` and `isClaudeCodeForDesktopEnabled`, which the gateway serves from `/user/bootstrap` and Desktop applies as read-only values. Tested live on the public Contoso gateway with Claude Desktop 2.42304.2.0: device-code sign-in, inference through the gateway, and the sidebar following each switch (U-106 and U-109 resolved). `tests/live/desktop-p40.mjs` applies a setting through admin-ui's own configuration store and reads the bootstrap response.
- A first-install tutorial for a reader new to the project (P-39, [tutorial-first-install](docs/learn/tutorial-first-install.md)), linked from a "Start here" table at the top of README.md: prerequisites with who holds each role, the values to set, one installer command, the expected output, what to do when the Microsoft Graph grant stops the last stage, the console's first sign-in, giving developers access, onboarding one machine or many through Intune, an end-to-end check and clean-up. `config/gateway-admin.example.json` is a starting admin file with two roles and an organization cap.
- Intune packaging (P-39): `new-client-policy.mjs` now also writes `client-policy/intune/`, two Win32 app folders: one installs Claude Code from Anthropic's download with a pinned release and SHA-256 checksum, the other installs the developer profile for the signed-in user and leaves a `sign-in.cmd` for the one-time sign-in; `INTUNE.txt` lists every Intune field. `scripts/admin/New-IntunePackage.ps1` runs Microsoft's Content Prep Tool over both folders. Not yet run in an Intune tenant (U-107).
- The installer deploys the admin console admin-only (ADR-0011 amendment): `-SignInAdmins` names who may open it, `-NoSignIn` is the explicit opt-out, and the base and app stages require `-FoundryResourceGroup` and `-FoundryAccount` instead of falling back to another deployment's account. `-DatabaseLocation` places a managed database in another region. `-ClientSecretDays` (`deploy.mjs --client-secret-days`, 1 to 30, default 7) sets the gateway's client-secret lifetime; the tutorial installs with 30 and says to run the `app` stage again before it ends, which a novice review found undocumented. The tutorial and troubleshooting also cover **Need admin approval** in tenants that stop user consent (U-108).
- Day-2 operations for a first install (P-39), each found by an independent novice review of the tutorial and fixed test-first:
  - The `app` stage keeps what the admin console saved (`gateway-admin-file`, `CONFIG_UPDATED_AT` and its `gateway-config`) instead of refusing to run (ADR-0010 amendment); `-RotateClientSecret` forces a new client secret; a run without `-TesterCidr` uses the range the state file records, so a later run does not narrow the gateway to one machine.
  - `Install-ClaudeGatewayProfile.ps1 -Model` pins `ANTHROPIC_MODEL`, and `-Model`/`-FastModel` are written to `gateway.settings.json`, so Claude Code does not ask for a default model the developer's role refuses (HTTP 400, T-88); `-DisableUpdates` writes `DISABLE_UPDATES=1` for the Intune-distributed release.
  - `new-client-policy.mjs --model` and `--claude-version`/`--claude-checksum` reach START-HERE and the Intune package; it warns without `--model`.
  - The Intune scripts write install logs on the device (App 1 inside its Program Files folder, so a standard user cannot redirect the SYSTEM write), name a running Claude Code, and pass the profile script's refusal to the log; App 1 is detected by a per-release marker, so a newer package replaces an older install.
  - `set-developer.mjs --topology` (default `test`) accepts the example admin file; `Deploy-AdminUi.ps1` picks the app registration by exact name (`az ad app list --display-name` matches prefixes, which also returned `<name>-admin-ui-signin` on Contoso).
  - A root `.dockerignore` cuts the admin-ui build upload from 6.9 MiB to 268 KiB.

- The test topology's database is a deployment choice (P-38, ADR-0012): `deployment.database: "sidecar"`, the default and today's in-app PostgreSQL that each new revision empties, or `"managed"`, an Azure Database for PostgreSQL flexible server (B1ms, PostgreSQL 16, 35-day point-in-time restore) whose spend, caps and audit trail survive configuration saves. `deploy.mjs` creates the server and keeps its firewall on the app's outbound addresses; `--database-location` places it in another region when B1ms is refused (U-105). `scripts/admin/move-to-managed-database.mjs` moves an existing sidecar deployment, and `scripts/admin/sync-database-firewall.mjs` re-syncs the firewall. The Contoso gateway now uses `psql-claude-gw-<suffix>-centralus`; an unchanged save kept its spend and cap (T-116).
- Documentation for a reader new to Azure and the gateway (T-112): a [glossary](docs/learn/glossary.md), an [admin console how-to](docs/learn/how-to-use-admin-console.md) covering every page, troubleshooting for `RBAC: access denied`, the no-access page and `Authorization_RequestDenied`, and a "Where to start" table in the overview. Deploy commands that use `203.0.113.0/26` now say it is a documentation range that admits nobody. The script reference documents `Deploy-AdminUi.ps1`, each install stage says who performs it, and the inference-test article opens with its purpose.
- A load test and sizing guide for 500 to 25,000 developers (P-36, [how-to-load-test-and-size](docs/learn/how-to-load-test-and-size.md)). Gateway 2.1.308 in `load_test_mode` used 26 ms of CPU per request and at most about 1 core per process; past about 500 open requests on one process, latency rose and spend prechecks timed out and failed open while clients still received HTTP 200. Log Analytics bills 686 bytes per inference row. `scripts/perf/capacity.mjs --measured` turns these into replicas, PostgreSQL connections and tier, Log Analytics volume, Foundry quota and monthly cost: 2 replicas at 500 and 1,000 developers, 3 at 2,000, 14 at 10,000 and 34 at 25,000, where Foundry quota is 2.5 times the enterprise default. `scripts/perf/load-run.mjs`, `fake-idp.mjs`, `sign-in.mjs` and `sample.sh` reproduce the test on a Linux host.
- admin-ui is administrators-only when sign-in is on (ADR-0011, T-108): every API route except `/api/health` and `/api/me` needs the `AdminUi.Admin` role, a signed-in user without it sees an access-denied page that names the account and where the role is assigned, and `Deploy-AdminUi.ps1` warns when it deploys without sign-in. Responses carry a Content-Security-Policy and other security headers, and writes must be same-site `application/json` of at most 1 MiB (U-95).
- admin-ui can change the gateway configuration (models, each role's models and Desktop access), create app roles, and report this period's spend by department, company, office, cost center, division or role, with CSV export and tagging of users (P-35, ADR-0010). Write actions need Container Apps sign-in with the new `AdminUi.Admin` role (`Deploy-AdminUi.ps1 -EnableSignIn -SignInAdmins ...`); a Settings page lists which permissions the deployment holds. On the test topology, saving the configuration resets spend data, and admin-ui asks for confirmation first (U-92).
- The admin console is branded “Claude apps gateway - Foundry”. Settings includes a collapsible onboarding guide and download of the gateway-specific Claude Code/VS Code `managed-settings.json`; Desktop/Cowork uses a separate `bootstrapUrl` policy, and no custom `onboarding.json` is needed.
- Settings permission guidance uses Azure Portal steps where supported. It explicitly notes that Microsoft Entra has no Portal workflow for granting Microsoft Graph application permissions to a managed identity, and that the `AdminUi.Admin` app role must exist before it can be assigned.
- The Chargeback page has a Business units card (`GET /api/business-units`, T-107). It lists every gateway role holder, with or without spend, by Entra department, and an admin creates a unit by typing a new department name for a user. Before this, only users with spend in the period could be tagged, and the page had no visible way to create a unit.
- A stage-based installer for the test topology, `infra/azure-test/Install-ClaudeGateway.ps1` (P-34, ADR-0009). One
  command renders the operator's admin file, builds the deployment (`base`, `entra`, `image`, `app`), sets the admin
  file's spend caps and deploys admin-ui, in that order; `-Plan` prints every command first, `-Steps` runs a subset,
  and a failed stage stops the run and names the section of the new
  [stage-by-stage guide](docs/learn/how-to-install-stage-by-stage.md) with that stage's Azure portal or Cloud Shell
  steps. admin-ui runs last because its Microsoft Graph grant needs a directory role many operators do not hold;
  when that grant is refused, every other stage is already done. Proven on 2026-10-21 by a run into an empty
  resource group.
- Initial spend caps from the admin file: a `budgets` array of `{scope, amountUsd, period}` rows, validated with the
  rest of the file, and `scripts/admin/bootstrap-budgets.mjs`, which sets each cap through the gateway's own admin
  API. Running it again replaces caps rather than adding new ones.
- A guide to managing users, groups and budgets after installation
  ([how-to-manage-users-and-groups.md](docs/learn/how-to-manage-users-and-groups.md)).
- The test topology now creates the gateway's admin API key (`admin-write-key`, `GATEWAY_ADMIN_WRITE_KEY`) itself,
  once, and keeps it on every later deployment; before, admin-ui and the spend caps worked on a test-topology
  gateway only where the key had been added by hand. `deploy.mjs --config` deploys a rendering other than
  `config/gateway.azure-test.yaml`.
- A policy can now set its own `desktop: true` or `false`, which wins over `deployment.desktop`'s default when
  present, so one role can carry the terminal and VS Code/JetBrains extensions (the `cli` key) without Claude
  Desktop while another role also gets Desktop. Previously `deployment.desktop` was one switch applied identically
  to every policy, and took effect only on the private topology; the test topology's own `deployment.desktop` was
  silently a no-op. Desktop sign-in is now independent of topology, since it is the gateway's own managed-policy
  opt-in (`/user/bootstrap` answers 404 without a `desktop` key on the matching policy), not a network concern.
- The admin API and admin-ui now also work on the ADR-0003 test topology, not only the network-restricted one
  (P-33). `deployment.adminApi: true` renders the same `admin:` block on either topology, plus the Container Apps
  environment's own reserved routing range in `access_control.allow_cidrs` (needed since admin-ui's own calls to
  the gateway arrive from that range, not the developer VNet or tester CIDR). `Deploy-AdminUi.ps1` reaches the
  gateway over its internal DNS name rather than its public FQDN, and takes `-AllowedCidr` for environments with
  no VNet. Live-proven on a second gateway, non-network-restricted, with Foundry served from a different Azure
  subscription of the same Entra tenant: a signed-in developer's real inference request, and the real spend, shown
  in admin-ui.
- An admin UI for the gateway's spend-limits API (P-33, ADR-0008): `admin-ui/`, a second Container App in the
  gateway's own environment. Set, list and audit spend caps by organization, RBAC group or user from a browser
  (`/v1/organizations/spend_limits`, `/effective`, `/audit`), and grant or remove Entra developer roles, reusing
  `scripts/admin/set-developer.mjs` unmodified against a Microsoft Graph client authenticated by the admin-ui's own
  managed identity. `deployment.adminApi: true` in the admin file adds an `admin:` block to `gateway.yaml`.
  `admin-ui/infra/Deploy-AdminUi.ps1` builds the image, deploys `admin-ui/infra/main.bicep` and grants the
  identity's three Microsoft Graph application permissions, which needs a tenant Global Administrator or Privileged
  Role Administrator (`admin-ui/README.md`, "Permissions this needs, and why"); without that grant the Developers
  page answers a clean 403, and Budgets/Dashboard/Audit still work. Scales to zero between admin sessions
  (`minReplicas: 0`), costing cents a month rather than an always-warm replica's roughly $6.

### Fixed
- Saving the gateway configuration from admin-ui failed with 502 "returned no ETag" on every attempt, because Container Apps returns no ETag (U-94). admin-ui now sends `If-Match` only when ARM returns an ETag; otherwise it reads the app again just before the write and answers 409 if it changed, and saves run one at a time so two admins saving together cannot overwrite each other. Found and verified by the T-106 live run (ADR-0010 amendment).
- The install article's manual Microsoft Graph grant posted to the managed identity instead of Graph's service principal and left out `Application.ReadWrite.OwnedBy`; it now matches `Deploy-AdminUi.ps1` (T-112).
- P-36 is no longer marked done before P-35, which it depends on.
- `Deploy-AdminUi.ps1 -SignInAdmins` skipped a user who held any role on the admin-ui sign-in app, so a user with default access never received `AdminUi.Admin`; it now checks for that role (T-108).
- Concurrent gateway-configuration writes now use ARM `If-Match` with the app ETag; stale conditional writes return 409, and writes fail closed if ARM supplies no ETag (U-94 remains to be verified against the live Container Apps provider). The user-tagging route now refuses with 403 naming `User.ReadWrite.All` before calling Graph when that permission is absent.
- admin-ui's Dashboard showed every developer's spend as $0.00 and every cap as "Unlimited": it read `spend` and `cap`
  fields that the gateway's `/effective` rows do not have. It now reads `period_to_date_spend` and `amount`, and
  shows which cap applies (`source`). The row mapping lives in `admin-ui/web/spend-view.js`, covered by
  `tests/admin-ui-web.test.mjs` with rows copied from the live gateway.
- admin-ui's Budgets page sent a user cap's e-mail target as the `user_id`; the gateway keys users by OIDC subject,
  so such a cap applied to no one. An e-mail address now resolves to the subject through `/effective`, and an address
  the gateway has not seen yet is refused with a message.
- The admin-ui installer now grants Microsoft Graph app roles through the resource service principal's
  `appRoleAssignedTo` relationship, as Microsoft Graph requires. The previous URL targeted the client identity's
  `appRoleAssignedTo` relationship and did not grant the permissions; `tests/deploy-artifacts.test.mjs` guards the
  resource/principal IDs and endpoint.
- Explained the gap measured in the $30 run: the gateway's spend was 6.3% above the sum of Claude Code's own
  `total_cost_usd` because 7 of the 101 calls Foundry served were never added to Claude Code's total. The gateway's
  figure matches the list-price cost of every served call to 0.005 cents (U-84).
- `deploy.mjs --step app` no longer deletes settings that were added to a gateway by hand: it stops before any change
  when the live app holds secrets or variables its template does not define, such as the Contoso gateway's
  cross-tenant Foundry credential, and names them. It also stops when the configuration references a `${VAR}` the
  template does not set, which would keep the gateway from starting.
- The installer as first committed targeted `deploy.mjs`'s default resource group whatever `-ResourceGroup` said,
  deployed the default configuration instead of the operator's admin file, needed the registry name before the
  registry existed, and limited admin-ui to an address range this topology does not have. All four are fixed and
  tested; values containing characters that cmd.exe interprets are now refused before anything runs.
- The Learn article checks skipped the commands of an article saved with Windows line endings, and did not know the
  `admin-ui/` scripts, so a command the CI run would reject passed on a Windows working copy.
- admin-ui's frontend rendered a blank page: `admin-ui/web/index.html` was an unfinished
  `<!doctype html><title>admin-ui</title>` stub, with no `#app` element, no nav and no `<script>` tag to load
  `app.js` at all, so no frontend code ever ran. Fixed the file and the test that was silently rewriting it back
  to that stub on every run.
- admin-ui crash-looped on every replica when deployed against a test-topology admin file, such as the public
  demo's (`{ "deployment": { "adminApi": true } }`, no `developerCidrs`): `buildDeps()` validated the admin file
  without naming a topology, which defaults to `private` and requires `deployment.developerCidrs`, a gateway
  network-access-control setting (ADR-0005) admin-ui's own code never reads. Fixed by always validating as the
  permissive `test` topology; the private gateway's admin file already lists `developerCidrs` and was unaffected.

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
- The console's **Settings** onboarding card on the test topology gives the developer-profile command, because Claude Code's `/login` requires a gateway whose name resolves to private addresses; managed settings stay on the network-restricted topology (U-106 records that Claude Desktop on a public gateway is untested).
- admin-ui has a new visual design (P-33): a sidebar layout with route icons, card-framed forms and tables, metric
  cards with icons, right-aligned amounts, and distinct loading, empty and error states. It follows the browser's
  light or dark preference, dark by default; below 880px the sidebar becomes a top tab bar, and on phones rows with
  actions, and audit events, reflow instead of scrolling sideways. The Budgets form's field explanations moved from
  its labels into one line of help text. Presentation only: the same API calls, form fields and behaviour, checked
  in Chromium (Playwright) at desktop, tablet and phone widths in both schemes, including WCAG AA text contrast.
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
- Soft limit with daily pacing (P-43, ADR-0014): past a share of a person's monthly spend cap, for example 80%, the scheduled job `job-spend-pacer` gives them a daily cap of the rest of the cap over the days left in the month, under its own `spend-pacer` key, and deletes only the daily caps it set. A lower role or organization daily cap applies instead, and an administrator's per-user daily cap is never changed. The admin console's **Access & models** page has a **Soft limit** card; the gateway's refusal explains the daily limit, and Claude Code warns at 75% and 95% of it. Both installers add the `admin-pacer-key` secret (`GATEWAY_ADMIN_PACER_KEY`), and the console refuses to turn the soft limit on for a gateway without it. Tested live on the Contoso gateway: [how-to](docs/learn/how-to-admin-configure.md#pace-the-last-part-of-a-monthly-cap-with-a-soft-limit).
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
- Soft limit with daily pacing (P-43, ADR-0014): past a share of a person's monthly spend cap, for example 80%, the scheduled job `job-spend-pacer` gives them a daily cap of the rest of the cap over the days left in the month, under its own `spend-pacer` key, and deletes only the daily caps it set. A lower role or organization daily cap applies instead, and an administrator's per-user daily cap is never changed. The admin console's **Access & models** page has a **Soft limit** card; the gateway's refusal explains the daily limit, and Claude Code warns at 75% and 95% of it. Both installers add the `admin-pacer-key` secret (`GATEWAY_ADMIN_PACER_KEY`), and the console refuses to turn the soft limit on for a gateway without it. Tested live on the Contoso gateway: [how-to](docs/learn/how-to-admin-configure.md#pace-the-last-part-of-a-monthly-cap-with-a-soft-limit).
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
