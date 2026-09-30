---
title: Run the inference tests through the Claude apps gateway
description: Test Messages API features, Claude Code and latency through the Claude apps gateway on the Azure test deployment, with one browser sign-in, and compare time to first token with the APIM route.
author: naveenneog
ms.date: 09/28/2026
ms.topic: how-to
---

# Run the inference tests through the Claude apps gateway

`tests/live/inference-suite.mjs` sends requests through the gateway with the developer profile's session. After each
check it matches every successful `/v1/messages` answer from the gateway to a request that carried the session token
to the gateway's `inference` audit event by `x-request-id`, whether a check sent the request or Claude Code sent it
through the loopback capture relay, and requires the event to name the tester, the model and the Foundry upstream
(tests/live/inference-runner.mjs:58-70, tests/live/inference-runner.mjs:101-111, tests/live/inference-runner.mjs:122-125).
The stream the `stream` check closes early gets the same audit. A request sent without a token is not audited: the
request without a token in `concurrency` fails the check unless it gets 401 (tests/live/inference-lib.mjs:157), and
in the run without a session in `profile`, the check fails unless Claude Code exits by itself with a non-zero status
(tests/live/inference-checks.mjs:186-188), its report on stderr shows that the helper exited 1 and carries its sign-in
command (tests/live/inference-checks.mjs:192-197, U-53), and each model request that reaches the gateway, with Claude
Code's placeholder key, gets 401 (tests/live/inference-checks.mjs:200-203). The
APIM samples of `latency` are not matched: the APIM route has no gateway
audit, and `ctx.sendExternal` sends only to another origin, over `https` (tests/live/inference-runner.mjs:91-99).
Each check ends PASS, FAIL or BLOCKED; BLOCKED means the evidence to decide was missing, such as a session or a log
line, and is not a pass.

## Prerequisites

| Checks | Need |
|---|---|
| All | Node.js 22 or later; a machine address inside the deployment's tester range (config/gateway.azure-test.yaml:49-50); a gateway session from `Connect-ClaudeGateway.ps1` ([quickstart](quickstart-developer.md)), which the suite reads through `Get-ClaudeGatewayToken.ps1`, so one browser sign-in serves every later run until the gateway refuses the refresh token |
| All | The [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli), signed in to the deployment's tenant with `az login --tenant <tenantId>` (the `tenantId` in `infra/azure-test/.state/<resource group>.json`) with an account that can read the Container App's console log through `az containerapp logs show` ([log streaming](https://learn.microsoft.com/en-us/azure/container-apps/log-streaming)); the account that deployed it can. The suite reads the log to audit each 200 answer on `/v1/messages` to a request with the session token, the gateway samples of `latency` included. It names the state file's `subscriptionId` in each log read, so the Azure CLI's default subscription does not matter; when the CLI does not hold that subscription in the deployment's tenant, the suite stops before the checks with exit code 2 and names the `az login` command (tests/live/inference-suite.mjs:67, tests/live/inference-runner.mjs:35-43, tests/live/inference-suite.mjs:111-115) |
| `profile`, `agentic` | Windows PowerShell 5.1 and Claude Code on `PATH` |
| `latency` | For the APIM half only, the APIM route's base URL in `--apim-url`, an `https` URL without credentials, a query or a fragment, which the suite checks before any request (tests/live/inference-runner.mjs:23-30). The suite takes it from no other place: without `--apim-url` it sends nothing to an APIM route, and the APIM half is BLOCKED (tests/live/inference-suite.mjs:104, tests/live/inference-checks.mjs:166-168). With it, the suite gets the APIM token itself from the signed-in Azure CLI, with `az account get-access-token --resource https://cognitiveservices.azure.com --tenant <tenant>`, before the timed requests; the tenant is `--apim-tenant`, by default the deployment's (tests/live/inference-suite.mjs:102-103), so the account needs access to the APIM route in that tenant |

## What the suite checks

| Check | Test | Positive | Negative |
|---|---|---|---|
| `models` | T-55 | `/v1/models` lists exactly the admin file's models; each answers | A model outside the list gets `400 invalid_request_error` |
| `messages` | T-56 | Usage, and `end_turn`, `stop_sequence` or `max_tokens` as requested, with text for the first two; a `max_tokens` stop may hold only a thinking block, since thinking tokens count toward `max_tokens` ([thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)) | A body without `max_tokens` gets `400` |
| `stream` | T-57 | `message_start`, content blocks, `message_delta` with usage, `message_stop` | A stream closed after its first delta has an `inference` event whose output tokens are at least the floor estimate of four characters per token for the text received, at most `max_tokens`, and whose total cost is above zero ([how requests are priced](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-requests-are-priced)); an event without an output token or total cost field is BLOCKED, and on the test deployment the event has neither (docs/UNKNOWNS.md:63). The event also gets the audit of every answer. The per-token rate is not checked |
| `count` | T-58 | `count_tokens` within 10% of the same body's `usage.input_tokens` | A model outside the list gets `400` |
| `tools` | T-59 | `tool_use`, then a final answer that uses the `tool_result` | An unknown `tool_use_id` gets `400` |
| `thinking` | T-60 | With adaptive thinking, its summary shown and `effort` `high`, a thinking block before the text; no setting guarantees one, so a turn without it is BLOCKED ([steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)) | A manual budget, `thinking.type` `enabled`, gets `400` on Claude Opus 5 and Sonnet 5 |
| `cache` | T-61 | The first request writes the prompt cache, the second reads it | A 200 answer to a prompt below the minimum length reports no cache tokens |
| `image` | T-62 | A generated red PNG is named red | Invalid base64 gets `400` |
| `concurrency` | T-63 | Eight parallel requests answer 200 with their own request IDs and events | A request without a token gets `401` |
| `latency` | T-64 | Time to first token, p50 and p95 over `--samples` streamed prompts, through the gateway, each answer audited, and through the APIM route when `--apim-url` names one | A route with a failed request is reported with its failures and no percentiles |
| `profile` | T-51 | `claude -p` through a helper profile ends by itself with status 0 and answers, and the gateway logs `inference` events for its requests | With no saved session Claude Code ends by itself with a non-zero status and reports that the helper exited 1, with its sign-in command; its requests carry a placeholder key ([gateway troubleshooting](https://code.claude.com/docs/en/llm-gateway-connect)), and each one that reaches the gateway gets `401` |
| `agentic` | T-65 | Claude Code reads a marker file with a tool and quotes it, in more than one request, each answer audited, and ends by itself with status 0 | With `Read`, `Grep`, `Glob` and `Bash` disallowed Claude Code ends by itself with status 0 and does not quote the marker, and those answers are audited too |

The evaluators have unit tests (tests/inference-lib.test.mjs:1), and the checks run offline against fakes of the
gateway, its log and Claude Code (tests/inference-runner.test.mjs:1); the formats come from the Messages API
([messages](https://platform.claude.com/docs/en/api/messages),
[streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)).

## Run the suite

The suite exits 0 when every selected check passed, 1 when one failed, and 2 when one was BLOCKED
(tests/live/inference-runner.mjs:18).

1. Sign in once, if the helper has no session:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\developer\Connect-ClaudeGateway.ps1 -GatewayUrl https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io
   ```

1. Run every check, or some of them:

   ```powershell
   node tests/live/inference-suite.mjs
   node tests/live/inference-suite.mjs --check models,messages,stream --samples 10
   ```

1. Read the summary line and the result file:

   ```output
   [infer] results: models=PASS messages=PASS ...; saved tests\live\out\inference-2026-09-28T09-07-43-585Z.json
   ```

The result file holds each check's result, notes, and the request IDs and event field names of the audited answers.
Tokens are registered with the redaction list and do not appear in it.

## Results so far

The runs of 2026-09-28 are in docs/TEST-PLAN.md, sections "Results — inference suite, 2026-09-28"
(docs/TEST-PLAN.md:159), "Results — inference suite, 2026-09-28, after council round 2" (docs/TEST-PLAN.md:204) and
"Results — inference suite, 2026-09-28, live, after sign-in" (docs/TEST-PLAN.md:215):

- Before a browser sign-in, every gateway check was BLOCKED. The APIM route
  (`https://apim-claude-gw-fzgql9.azure-api.net/claude`), `claude-sonnet-5`, 20 streamed prompts, had no failures:
  time to first token p50 1,286 ms and p95 1,985 ms in the first run, and p50 1,295 ms and p95 1,980 ms in the second.
- After the sign-in, T-51, T-55, T-56, T-58, T-59, T-60, T-61, T-62, T-63 and T-65 passed through the gateway, each
  successful answer matched to its `inference` event. T-57's floor price is BLOCKED: the event holds no token or
  cost field (docs/UNKNOWNS.md:63). Through the gateway, 20 streamed prompts to `claude-sonnet-5` had no failures:
  time to first token p50 909 ms and p95 1,137 ms; the APIM half was not run, since no `--apim-url` was given.

## Related content

- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Troubleshoot the developer profile](troubleshoot.md)
- [Test plan](../TEST-PLAN.md)