---
title: Script reference for the Claude apps gateway tooling
description: Parameters, exit codes, files and environment variables of the developer, admin and test scripts that set up and test Claude Code through the Claude apps gateway on Azure.
author: naveenneog
ms.date: 09/28/2026
ms.topic: reference
---

# Script reference

The developer and admin scripts exit with code 0 on success and 1 on failure, and write their diagnostics to stderr;
the test scripts print progress to stdout and have their own exit codes, listed below. The developer scripts run in
Windows PowerShell 5.1 and PowerShell 7; the admin and test scripts run in Node.js 22 or later.

## Developer scripts

The four PowerShell scripts in `scripts/developer` share `ClaudeGateway.psm1`
(docs/adr/0004-operator-and-developer-tooling.md:46).

### Install-ClaudeGatewayProfile.ps1

Installs the runtime and writes a Claude Code profile for one gateway, then signs in.

| Parameter | Meaning |
|---|---|
| `-GatewayUrl` | Required. The gateway origin; `https`, or `http` for a loopback address |
| `-FastModel` | Model for background tasks, written as `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| `-Model` | Model Claude Code requests by default, written as `ANTHROPIC_MODEL`; without it Claude Code requests its own default, which a role that does not allow it refuses with HTTP 400 |
| `-DisableUpdates` | Writes `DISABLE_UPDATES=1`, for a Claude Code release the administrator distributes, such as the Intune package; Claude Code then does not replace it |
| `-ProfileDir` | Profile directory; default `%USERPROFILE%\.claude-apps-gateway`; `%USERPROFILE%\.claude` is refused |
| `-ClaudePath` | Claude Code's `claude.exe` or `claude.cmd`; default the first on `PATH` |
| `-ReplaceGateway` | Points a profile written for another gateway at this one |
| `-NoBrowser` | Passed to `Connect-ClaudeGateway.ps1` |
| `-NoSignIn` | Writes the profile without signing in |

| Written | Content |
|---|---|
| `%LOCALAPPDATA%\ClaudeAppsGateway\bin\<version>\` | The runtime scripts; `<version>` is a hash of their content |
| `<profile>\settings.json` | `apiKeyHelper`, and in `env`: `ANTHROPIC_BASE_URL`; empty `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_MANTLE`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`; `CLAUDE_CODE_DISABLE_FAST_MODE` and `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` set to `1`; `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` set to `240000`. Other keys in the file are kept |
| `<profile>\gateway.settings.json` | The pinned subset of `settings.json`: `apiKeyHelper` and the `env` values that decide where Claude Code sends the token and which credential it sends, rewritten on every run (scripts/developer/Install-ClaudeGatewayProfile.ps1:227-244). `ANTHROPIC_DEFAULT_HAIKU_MODEL` and the developer's own keys are only in `settings.json`. The launcher passes this file with `--settings`, which ranks above a repository's `.claude/settings.json` and `.claude/settings.local.json` ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)) |
| `<profile>\claude-gateway.cmd` | Clears `ANTHROPIC_*` and `CLAUDE_CODE_USE_*`, sets `CLAUDE_CONFIG_DIR` to the profile, and runs Claude Code by absolute path with `--settings <profile>\gateway.settings.json` before its own arguments. Claude Code uses only the last `--settings` argument, so one given to the launcher replaces that file (docs/UNKNOWNS.md:61) |

### Connect-ClaudeGateway.ps1

Signs in with the device flow (RFC 8628) and saves the session.

| Parameter | Meaning |
|---|---|
| `-GatewayUrl` | Required. The gateway origin |
| `-NoBrowser` | Shows the verification URL without opening a browser |
| `-Force` | Saves the session without asking to confirm the account the gateway names |

The session is `%LOCALAPPDATA%\ClaudeAppsGateway\sessions\<host>-<hash>.bin`, encrypted with DPAPI for the Windows
user ([ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata)).

### Get-ClaudeGatewayToken.ps1

The profile's `apiKeyHelper`: prints the access token on stdout and nothing else.

| Parameter | Meaning |
|---|---|
| `-GatewayUrl` | Required. The gateway origin |
| `-ExpectedBaseUrl` | An origin `ANTHROPIC_BASE_URL` may name instead of the gateway, such as a test relay |

| Condition | Result |
|---|---|
| More than 300 seconds left | The saved token, with no request |
| 300 seconds or fewer left | One refresh grant under the session's lock file; the new tokens are saved |
| The refresh gets `invalid_grant` | The session is deleted; exit 1 with the sign-in command |
| The refresh fails otherwise, or the lock stays taken | The saved token while more than 30 seconds remain; otherwise exit 1 |
| `ANTHROPIC_BASE_URL` is empty, unset or names another host | Exit 1; no token is printed. Claude Code sends the token to `ANTHROPIC_BASE_URL`, or to `https://api.anthropic.com` when it is empty or unset |
| A `CLAUDE_CODE_USE_*` provider switch is set | Exit 1; no token is printed. Claude Code would send the token to that provider's endpoint ([environment variables](https://code.claude.com/docs/en/env-vars)) |

`CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS` sets how long it waits for the lock; the default is 60. To run the helper by hand,
set `ANTHROPIC_BASE_URL` to the gateway first.

### Disconnect-ClaudeGateway.ps1

Signs out: when the gateway advertises a `revocation_endpoint`, sends the access token and then the refresh token to
it, as a best effort ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)); a failed revocation is reported on
stderr. The session is deleted in every case (scripts/developer/Disconnect-ClaudeGateway.ps1:35-48). With no saved
session the script reports that and exits 0.

| Parameter | Meaning |
|---|---|
| `-GatewayUrl` | Required. The gateway origin |

## Admin scripts

The admin scripts reuse the deployment's libraries in `infra/azure-test/lib`
(docs/adr/0004-operator-and-developer-tooling.md:52-54).

### new-gateway-config.mjs

Renders `config/gateway.azure-test.yaml` from `config/gateway-admin.azure-test.json`, or with `--topology private`
`config/gateway.azure-private.yaml` from `config/gateway-admin.azure-private.json`. The header of the output names the
admin file it was rendered from (scripts/admin/new-gateway-config.mjs:238, scripts/admin/new-gateway-config.mjs:301).
The private topology reads the admin file's `deployment` block: the developer networks for `access_control.allow_cidrs`,
the per-address sign-in limits, `store.max_connections`, the Claude Desktop opt-in on each policy, and `telemetry`, which adds
the one metrics-only destination on the OpenTelemetry Collector sidecar and sets each policy's
`OTEL_METRICS_INCLUDE_SESSION_ID` and `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` to `false` (ADR-0007)
(scripts/admin/new-gateway-config.mjs:274-332).

| Option | Meaning |
|---|---|
| `--topology` | `test`, the ADR-0003 test deployment, or `private`, the network-restricted deployment of ADR-0005; default `test` |
| `--admin` | Admin file; default `config/gateway-admin.azure-<topology>.json` |
| `--out` | Output; default `config/gateway.azure-<topology>.yaml` |
| `--entra-app` | Entra app manifest with the app roles; default `infra/azure-test/entra-app.json` |
| `--check` | Exit 1 when the output differs from the rendering, without writing |

### set-developer.mjs

Grants, removes or lists the gateway's app roles through Microsoft Graph, with the Azure CLI sign-in. It grants only a
role that the admin file admits. It reads the admin file, and checks it with the rules of `new-gateway-config.mjs`,
before any Graph request, so a file that fails them changes nothing (scripts/admin/set-developer.mjs:41-52).

| Option | Meaning |
|---|---|
| `--upn` | The user's principal name or object ID |
| `--role` | `Gateway.Standard` or `Gateway.Premium`, from `infra/azure-test/entra-app.json` |
| `--remove` | Removes the role instead of granting it; the admin file is still read and checked |
| `--list` | Lists each gateway role's holders |
| `--admin` | Admin file whose `roles` may be granted; default `config/gateway-admin.azure-test.json`, the file `new-gateway-config.mjs` renders from |
| `--resource-group` | Deployment state to read; default `rg-claude-apps-gateway-test` |
| `--topology` | `test` (default) or `private`: the rules the admin file is checked against, as `new-gateway-config.mjs` applies them |

### new-client-policy.mjs

Writes `login\managed-settings.json`, `login\ClaudeCode-HKLM.reg` and `login\ClaudeCode.mobileconfig`, a
`developer` folder with every script of `scripts\developer`, and an `intune` folder with two Win32 app folders and
`INTUNE.txt`, the Intune field values (scripts/admin/intune-package.mjs:1-9), a `desktop` folder with Claude Desktop's
`bootstrapUrl` policy as `ClaudeDesktop-HKLM.reg`, the Intune platform script `Set-ClaudeDesktopPolicy.ps1` and
`DESKTOP.txt` (scripts/admin/desktop-policy.mjs:1-4), and `New-IntunePackage.ps1` at the top. The admin console's
**Settings** page downloads the same files (scripts/admin/new-client-policy.mjs:164-184). A machine takes the `login` policy or
the gateway profile, not both. `login` needs a gateway on private addresses; `developer` and `intune` work with any
([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)).

| Option | Meaning |
|---|---|
| `--gateway-url` | Required. The gateway origin, `https`, with a host name or a private IPv4 address |
| `--out` | Required. Output directory; refused when it is not empty |
| `--fast-model` | Written into the developer folder's install command |
| `--model` | Written as `-Model` into the developer folder's install command and the Intune profile app |
| `--claude-version`, `--claude-checksum` | Together: the Claude Code release the Intune package installs and its `win32-x64` checksum from the release's `manifest.json`; default the pinned release |
| `--policy-id` | The configuration profile's identity; default `default`. The same ID with a new URL updates the profile |
| `--force` | Writes into a directory that is not empty |

### New-IntunePackage.ps1

Packages the two Intune Win32 apps `new-client-policy.mjs` writes into `<policy folder>\intune`, with the Microsoft
Win32 Content Prep Tool, and prints the two `.intunewin` files (scripts/admin/New-IntunePackage.ps1:40-47;
[prepare a Win32 app](https://learn.microsoft.com/en-us/intune/app-management/deployment/create-win32-package)).
The Intune field values for each app are in `<policy folder>\intune\INTUNE.txt`.

| Parameter | Meaning |
|---|---|
| `-PolicyFolder` | The folder `new-client-policy.mjs` wrote; default `.\client-policy` |
| `-ToolPath` | Required. `IntuneWinAppUtil.exe`, kept outside the policy folder |
| `-OutputFolder` | Where the `.intunewin` files go; default `.\intunewin` |

### bootstrap-budgets.mjs

Sets every spend cap the admin file's `budgets` array declares (ADR-0009), through the gateway's own admin API
(reusing `admin-ui/server/gateway-client.mjs`'s `setSpendLimit`, no parallel HTTP client). Idempotent: `POST` on an
unchanged `{scope, period}` replaces the cap rather than duplicating it, so re-running after `amountUsd` changes in
the admin file is a plain redeploy. Continues past one row's own failure so it does not stop the rows after it
(scripts/admin/bootstrap-budgets.mjs:43-59), and exits 1 naming each failed row when any did
(scripts/admin/bootstrap-budgets.mjs:91-94).

| Option | Meaning |
|---|---|
| `--admin` | Admin file whose `budgets` are set; default `config/gateway-admin.azure-test.json` |
| `--resource-group` | Deployment state to read; default `rg-claude-apps-gateway-test` |
| `--gateway-app` | The gateway Container App's name; default `ca-claude-gw` |
| `--topology` | Passed to the admin file's validation; default `test` |
| `--plan` | Prints every call it would make and sends none |

A `budgets` row is `{"scope": {...}, "amountUsd": <number or null>, "period": "daily"|"weekly"|"monthly"}`; `scope` is
`{"type": "organization"}`, `{"type": "rbac_group", "rbac_group_id": "<a role in roles>"}` or `{"type": "user",
"user_id": "<the developer's OIDC sub>"}` (scripts/admin/new-gateway-config.mjs:97-127).

### move-to-managed-database.mjs

Moves a test-topology gateway from the in-app PostgreSQL sidecar to a managed Flexible Server (ADR-0012). It registers
`Microsoft.DBforPostgreSQL` when needed, deploys the server and `gateway` database defined in
`infra/azure-test/gateway-test.json`, sets the firewall to the app's outbound addresses, then saves the admin file with
`deployment.database: "managed"` and removes the sidecar in one write through the admin console's configuration
store (`admin-ui/server/gateway-config.mjs`). That write starts one revision with an empty database; spend is not
copied. Running it again after a partial run repeats only what is missing.

| Option | Meaning |
|---|---|
| `--resource-group` | The gateway's resource group; required |
| `--gateway-app` | The gateway Container App's name; default `ca-claude-gw` |
| `--database-location` | Region for the server, when the app's region refuses B1ms (U-105); default the app's region |
| `--client-secret-days` | Lifetime, 1 to 30 days, of a client secret the `app` step creates; default 7 (infra/azure-test/lib/plan.mjs:91-96) |
| `--plan` | Prints the steps and changes nothing |
| `--acknowledge-data-loss` | Required to run: the move empties the sidecar database once |

### sync-database-firewall.mjs

Sets the managed database's `aca-outbound-<address>` firewall rules to the gateway app's current outbound addresses
and removes rules for addresses the app no longer has; other rules are kept (ADR-0012, U-101). The address
`0.0.0.0`, which would allow every Azure service, is refused.

| Option | Meaning |
|---|---|
| `--resource-group` | The gateway's resource group; required |
| `--gateway-app` | The gateway Container App's name; default `ca-claude-gw` |
| `--check` | Changes nothing; exits 1 when the rules differ from the app's addresses |

## Installer script

### Install-ClaudeGateway.ps1

Runs the test deployment's stages in a fixed order regardless of `-Steps`' own order: `config`
(`new-gateway-config.mjs` renders the admin file), `base`, `entra`, `image`, `app` (each a step of `deploy.mjs`; `app`
deploys the rendering with `--config`), `budgets` (`bootstrap-budgets.mjs`), `admin-ui` (`Deploy-AdminUi.ps1`)
(infra/azure-test/Install-ClaudeGateway.ps1:120). Requesting `app` also runs `config`, so a stale rendering is never
deployed (infra/azure-test/Install-ClaudeGateway.ps1:136). `admin-ui` runs last because its final step, the
Microsoft Graph grant, needs a directory role many operators do not hold (docs/UNKNOWNS.md, U-75). Before any stage
runs, the script refuses a value holding a character cmd.exe interprets, which `Deploy-AdminUi.ps1` would pass to
`az` (infra/azure-test/Install-ClaudeGateway.ps1:125-129), and an admin file without `deployment.adminApi: true` when
`admin-ui`, or `budgets` with budgets declared, is requested (infra/azure-test/Install-ClaudeGateway.ps1:178-183). It
makes no `az`, ARM or Graph call of its own and runs every stage from the repository root; a stage that fails stops
every later one and names the stage, the exit code and the matching section of
[Install the Claude apps gateway, stage by stage](how-to-install-stage-by-stage.md)
(infra/azure-test/Install-ClaudeGateway.ps1:197-205).

| Parameter | Meaning |
|---|---|
| `-ResourceGroup` | Required. The resource group every stage targets |
| `-AdminFile` | Required. The admin file `config` renders and `budgets` and `admin-ui` read |
| `-TesterCidr` | Required when `base`, `entra`, `image` or `app` is requested, unless the state file records a range, which a run without it uses; passed to `deploy.mjs --tester-cidr`, and the default of `-AllowedCidr` |
| `-ConfigFile` | Where `config` writes the rendering `app` deploys; default `gateway.<name>.yaml` next to `gateway-admin.<name>.json`, or `<name>.gateway.yaml` for another file name |
| `-AppRegistrationName` | The Entra app registration's display name, given to `deploy.mjs --app-display-name` and `Deploy-AdminUi.ps1`; default `claude-apps-gateway-test` |
| `-Location` | Passed to `deploy.mjs --location` when given |
| `-FoundryResourceGroup` | Passed to `deploy.mjs --foundry-resource-group` when given |
| `-FoundryAccount` | Passed to `deploy.mjs --foundry-account` when given |
| `-EmailDomain` | Passed to `deploy.mjs --email-domain` when given; needed when the signed-in account has no mail address |
| `-AcrName` | The registry for admin-ui's image; default the `acrName` the `base` stage records in `deploy.mjs`'s state file |
| `-GatewayAppName` | Forwarded to `bootstrap-budgets.mjs` and `Deploy-AdminUi.ps1`; default `ca-claude-gw` |
| `-EnvironmentName` | Forwarded to `Deploy-AdminUi.ps1`; default `cae-claude-gw`, the environment the test template creates |
| `-AllowedCidr` | The range admin-ui admits, forwarded to `Deploy-AdminUi.ps1`; default `-TesterCidr`, since the test topology has no virtual network |
| `-SignInAdmins` | Required for `admin-ui` unless `-NoSignIn`: who may open the console, as user principal names separated by commas; forwarded with `-EnableSignIn` and `-Topology test` (ADR-0011) |
| `-NoSignIn` | Deploys the console without sign-in, so anyone inside `-AllowedCidr` can use it (ADR-0008) |
| `-DatabaseLocation` | Passed to `deploy.mjs --database-location` for `app`: the managed database's region (docs/UNKNOWNS.md, U-105) |
| `-ClientSecretDays` | Passed to `deploy.mjs --client-secret-days` for `app`: 1 to 30 days for a new client secret; default 7 |
| `-RotateClientSecret` | Passed to `deploy.mjs --rotate-client-secret` for `app`: a new client secret whatever the current one's end date |
| `-Steps` | Which stages to run: `config`, `base`, `entra`, `image`, `app`, `budgets`, `admin-ui`; default all seven. A comma-separated list also works from `pwsh -File` |
| `-Plan` | Prints every requested stage's command line and runs none of them; a registry `base` has not recorded yet shows as a placeholder |
| `-ConfigScript`, `-DeployScript`, `-BudgetsScript`, `-AdminUiScript`, `-StateDir` | The four sub-scripts' paths and `deploy.mjs`'s state folder; default the real ones. Overridden only by `tests/install-orchestrator.test.mjs`, which points them at fake stand-ins |

## Deployment scripts

`infra/azure-private/Deploy-Gateway.ps1` deploys the network-restricted design of ADR-0005 with the Azure CLI, one
step at a time; [Deploy the Claude apps gateway on Azure in a network-restricted environment](tutorial-deploy-network-restricted.md)
shows each step's commands (docs/adr/0005-network-restricted-deployment.md:56-60).

### Deploy-Gateway.ps1

Runs in PowerShell 7.2 or later with the Azure CLI signed in. Each step creates what is missing and reports what it
finds with `FOUND`. A step that stops, on a failed `az` command among other causes, writes `Deploy-Gateway.ps1: <message>`
to standard error without the line breaks PowerShell's error view adds at the console width, so a command or URL in
the message stays whole; a message that holds line breaks of its own keeps them, and the script's line number is not
printed. The run exits with code 1 (infra/azure-private/Deploy-Gateway.ps1:144-149). Secrets reach the Azure CLI as `@<file>` arguments in a temporary folder
that the script deletes at the end (infra/azure-private/lib/Az.psm1:1-10).

| Parameter | Meaning |
|---|---|
| `-Step` | One or more of `network`, `dns`, `foundry`, `postgres`, `registry`, `identity`, `environment`, `telemetry`, `entra`, `app`, `devvm`, `verify`, or `all` (default); a comma-separated list also works from `pwsh -File`. A step that needs names from earlier steps reads them without changing them |
| `-Plan` | Reads the subscription and prints each command that would change it, then `Plan: <n> command(s) would change the subscription`; changes nothing |
| `-ResourceGroup` | Default `rg-claude-gw-internal`; the six-digit suffix of global names derives from it and the subscription ID |
| `-Location` | Region of the network, the gateway, PostgreSQL and the test machine; default `northcentralus` |
| `-FoundryLocation` | Region of the Foundry account; default `eastus2` |
| `-ClaudeOrganizationName` | The organization's legal name, recorded on each Claude deployment; required to create one |
| `-ClaudeCountryCode` | Two-letter country code for the Claude deployments; default `US` |
| `-ClaudeIndustry` | Industry for the Claude deployments; default `technology` |
| `-MinReplicas` | Gateway minimum replicas; default 2 |
| `-MaxReplicas` | Gateway maximum replicas; default 3, which keeps twice replicas × `store.max_connections`, for the old and new revisions of a rollout, within Burstable B1ms's 35 user connections |
| `-ConcurrentRequests` | Concurrent requests per replica for the HTTP scale rule; default 150 |
| `-MaxUpstreamRequests` | `BUN_CONFIG_MAX_HTTP_REQUESTS`, requests a replica sends upstream at once; default 256 |
| `-Cpu` | vCPU per replica; default `1.0` |
| `-Memory` | Memory per replica; default `2Gi` |
| `-PostgresSku` | PostgreSQL compute size; default `Standard_B1ms` |
| `-PostgresTier` | PostgreSQL tier; default `Burstable` |
| `-PostgresZonalResiliency` | `Disabled` (default) or `Enabled`, zone-redundant high availability |
| `-ZoneRedundant` | Creates the Container Apps environment zone redundant |
| `-OperatorRole` | App role the signed-in operator receives; default `Gateway.Premium` |
| `-AllowedEmailDomain` | Email domain the gateway admits; default the signed-in operator's domain |
| `-ClientSecretDays` | Lifetime of the gateway's client secret; default 7 |
| `-RotateClientSecret` | Adds a new client secret to the app registration and deploys it |
| `-ShowDevVmPassword` | Prints the test machine's user name and password, saved for the current Windows user with DPAPI, and exits |

The parameters and their defaults are in infra/azure-private/Deploy-Gateway.ps1:29-61.

## Admin console script

`admin-ui/infra/Deploy-AdminUi.ps1` builds and deploys the admin console as a second Container App in the gateway's
environment ([Use the admin console](how-to-use-admin-console.md), ADR-0008, ADR-0011). It runs in PowerShell 7 with
the Azure CLI signed in.

### Deploy-AdminUi.ps1

The steps print as they run: **Build image** (`az acr build`), **Read gateway context**, **Ensure the admin-ui sign-in
app registration** (with `-EnableSignIn` only), **Deploy Bicep**, **Grant Microsoft Graph application permissions** and
**Make admin-ui an owner of the gateway app registration** (`admin-ui/infra/Deploy-AdminUi.ps1`, lines 119-248). The
Graph step needs a Global Administrator or Privileged Role Administrator
([grant an app role to a service principal](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto));
an already granted permission is skipped. Without `-EnableSignIn` the script prints a warning that anyone in the
allowed range can use the console.

| Parameter | Meaning |
|---|---|
| `-ResourceGroup` | Required. The resource group the gateway already runs in |
| `-EnvironmentName` | The Container Apps environment; default `cae-claude-gw` |
| `-GatewayAppName` | The gateway Container App; default `ca-claude-gw` |
| `-AcrName` | Required. The container registry's name, not its login server |
| `-AppRegistrationName` | Required. The display name of the gateway's Entra app registration |
| `-AdminFile` | The admin file; default `config/gateway-admin.azure-private.json` |
| `-ImageTag` | The image tag to build; default today's date as `yyyy-MM-dd` |
| `-AllowedCidr` | The only address range the console's ingress admits; default `10.40.0.0/16`, the VNet of the network-restricted deployment. `203.0.113.0/26` in these articles is a documentation range that admits nobody |
| `-Topology` | `private` (default) or `test`; the console renders the configuration it saves for this topology (ADR-0010) |
| `-EnableSignIn` | Turns on Container Apps authentication with a `<app registration>-admin-ui-signin` registration that carries the `AdminUi.Admin` role; saving the configuration, creating roles and tagging users need it |
| `-SignInAdmins` | User principal names to assign `AdminUi.Admin`, as several values or one comma-separated value; required with `-EnableSignIn`, and checked before any Azure call |
| `-Plan` | Prints each step without building, deploying or granting anything |

The parameters and their defaults are in `admin-ui/infra/Deploy-AdminUi.ps1`, lines 75-89.

## Test scripts

The test scripts write their results under `tests/live/out`, which git ignores.

### inference-suite.mjs

`tests/live/inference-suite.mjs` runs the checks in [Run the inference tests](how-to-test-inference.md). It exits 0
when every selected check passed, 1 when one failed and 2 when one was BLOCKED
(tests/live/inference-runner.mjs:18).

| Option | Meaning |
|---|---|
| `--check` | Comma-separated checks; default all |
| `--resource-group` | Deployment state to read; default `rg-claude-apps-gateway-test` |
| `--samples` | Streamed prompts per route for `latency`; default 20 |
| `--apim-url` | APIM route base URL for the APIM half of `latency`, an `https` URL without credentials, a query or a fragment; no default. Without it, the suite sends nothing to an APIM route and that half is BLOCKED (tests/live/inference-suite.mjs:104, tests/live/inference-runner.mjs:23-30, tests/live/inference-checks.mjs:166-168) |
| `--apim-tenant` | Tenant of the Azure CLI token the suite sends to the APIM route; default the deployment's `tenantId` from the state file, which the suite's account check confirms the Azure CLI holds (tests/live/inference-suite.mjs:102-103, tests/live/inference-suite.mjs:111-115, tests/live/inference-runner.mjs:35-43) |

### Mutation checks

`tests/mutate-developer.ps1` and `tests/mutate-admin.ps1` break one guarded property at a time in a temporary copy of
the scripts and require a test to fail for each. They exit 1 when a mutation survives, does not apply exactly once, or
breaks the syntax.

| Parameter | Meaning |
|---|---|
| `-Repo` | Repository root; default the parent of `tests` |
| `-Parallel` | Mutants run at once; default 4 and 6 |
| `-Only` | Regular expression that selects mutations by name |
| `-DryRun` | `mutate-developer.ps1` only: checks that each mutation's text occurs exactly once |
| `-Shard` | `k/n`: runs every n-th selected mutation from the k-th, so shards `1/n` to `n/n` run each mutation once between them; the GitHub workflow `.github/workflows/mutation.yml` runs the admin script in 2 shards and the developer script in 4 (tests/mutate-developer.ps1:142-154) |
| `-List` | Prints the index, file and name of each selected mutation and runs nothing (tests/mutate-developer.ps1:155-158) |

## Related content

- [Quickstart: connect Claude Code on Windows](quickstart-developer.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Troubleshoot the developer profile](troubleshoot.md)
