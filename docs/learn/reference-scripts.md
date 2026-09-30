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
| `-ProfileDir` | Profile directory; default `%USERPROFILE%\.claude-apps-gateway`; `%USERPROFILE%\.claude` is refused |
| `-ClaudePath` | Claude Code's `claude.exe` or `claude.cmd`; default the first on `PATH` |
| `-ReplaceGateway` | Points a profile written for another gateway at this one |
| `-NoBrowser` | Passed to `Connect-ClaudeGateway.ps1` |
| `-NoSignIn` | Writes the profile without signing in |

| Written | Content |
|---|---|
| `%LOCALAPPDATA%\ClaudeAppsGateway\bin\<version>\` | The runtime scripts; `<version>` is a hash of their content |
| `<profile>\settings.json` | `apiKeyHelper`, and in `env`: `ANTHROPIC_BASE_URL`; empty `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_MANTLE`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`; `CLAUDE_CODE_DISABLE_FAST_MODE` and `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` set to `1`; `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` set to `240000`. Other keys in the file are kept |
| `<profile>\gateway.settings.json` | The pinned subset of `settings.json`: `apiKeyHelper` and the `env` values that decide where Claude Code sends the token and which credential it sends, rewritten on every run (scripts/developer/Install-ClaudeGatewayProfile.ps1:217-234). `ANTHROPIC_DEFAULT_HAIKU_MODEL` and the developer's own keys are only in `settings.json`. The launcher passes this file with `--settings`, which ranks above a repository's `.claude/settings.json` and `.claude/settings.local.json` ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)) |
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
admin file it was rendered from (scripts/admin/new-gateway-config.mjs:170, scripts/admin/new-gateway-config.mjs:225).
The private topology reads the admin file's `deployment` block: the developer networks for `access_control.allow_cidrs`,
the per-address sign-in limits, `store.max_connections`, the Claude Desktop opt-in on each policy, and `telemetry`, which adds
the one metrics-only destination on the OpenTelemetry Collector sidecar and sets each policy's
`OTEL_METRICS_INCLUDE_SESSION_ID` and `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` to `false` (ADR-0007)
(scripts/admin/new-gateway-config.mjs:200-255).

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

### new-client-policy.mjs

Writes `login\managed-settings.json`, `login\ClaudeCode-HKLM.reg` and `login\ClaudeCode.mobileconfig`, and a
`developer` folder with every script of `scripts\developer`; a machine takes one of the two folders.

| Option | Meaning |
|---|---|
| `--gateway-url` | Required. The gateway origin, `https`, with a host name or a private IPv4 address |
| `--out` | Required. Output directory; refused when it is not empty |
| `--fast-model` | Written into the developer folder's install command |
| `--policy-id` | The configuration profile's identity; default `default`. The same ID with a new URL updates the profile |
| `--force` | Writes into a directory that is not empty |

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
