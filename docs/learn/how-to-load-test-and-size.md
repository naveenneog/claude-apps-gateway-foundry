---
title: Load test the Claude apps gateway and size it for 500 to 25,000 developers
description: Measure one Claude apps gateway process in load_test_mode, then turn the measurements into replica, PostgreSQL, Log Analytics, Foundry quota and cost figures for 500, 1,000, 2,000, 10,000 and 25,000 developers.
author: naveenneog
ms.date: 10/25/2026
ms.topic: how-to
---

# Load test the Claude apps gateway and size it for 500 to 25,000 developers

This article records a load test of Claude apps gateway 2.1.308 and the sizing that follows from it. The gateway ran in
[`load_test_mode`](https://code.claude.com/docs/en/claude-apps-gateway-config#load_test_mode), which answers
`/v1/messages` with canned replies instead of calling Foundry. The measured CPU, memory and log figures feed
`scripts/perf/capacity.mjs`, which produces the sizing table (scripts/perf/capacity.mjs:36).
[Plan capacity for 25,000 developers](concept-plan-for-scale.md) explains the formulas.

## Summary

| Question | Answer from the measurements |
|---|---|
| What limits one replica? | Open requests. At the planning figure of 30 seconds per request, 150 open requests is about 5 requests per second, which uses about 0.13 of a core. |
| How much CPU does a request cost? | 26 ms of CPU per streamed request, below saturation. |
| What happens past saturation? | One gateway process used at most about 1 core. From 512 open requests, latency rose and the gateway's spend checks began to time out. Clients still received HTTP 200. |
| Does memory limit a replica? | No. Idle memory was 165 to 174 MB; the peak was 295 MB at 2,000 open requests. |
| How many replicas for 25,000 developers? | 34, set by open requests (5,000 ÷ 150). CPU alone would need 7. |
| What limits 10,000 and 25,000 developers? | Foundry quota: 1.0 and 2.5 times the enterprise default quota for one deployment. |
| How much Log Analytics data? | 686 billed bytes per inference row; 3.48 GB per day at 25,000 developers. |

The calculator's measured profile holds these figures (scripts/perf/capacity.mjs:36). The sizing figures are in [Sizing for 500 to 25,000 developers](#sizing-for-500-to-25000-developers); the gaps in this
test are in [Limits of this test](#limits-of-this-test).

## Prerequisites

- A Linux x64 host. The `claude gateway` command does not run on Windows; this test used Ubuntu in WSL2.
- The gateway binary for the version under test, checked against the release manifest
  ([install](https://code.claude.com/docs/en/claude-apps-gateway-deploy)).
- PostgreSQL with an empty database used by no other gateway. `load_test_mode` writes usage rows for simulated users
  ([`load_test_mode`](https://code.claude.com/docs/en/claude-apps-gateway-config#load_test_mode)).
- Node.js for the scripts in `scripts/perf/`, which use only built-in modules (scripts/perf/load-run.mjs:12).
- No connection to a gateway developers use. `load_test_mode` turns off upstream calls for every request.

## Start a fake identity provider

The gateway needs a signed-in session even in `load_test_mode`. `scripts/perf/fake-idp.mjs` is an OpenID provider that
approves every sign-in at once and signs an `id_token` for one developer. It refuses to listen on any address other
than loopback, because anyone who reaches it signs in (scripts/perf/fake-idp.mjs:14).

```powershell
node scripts/perf/fake-idp.mjs --port 18081 --email loadtest@contoso.com --groups Gateway.Standard --client-id load-test
```

The token carries the groups in both the `groups` and `roles` claims (scripts/perf/fake-idp.mjs:63).

## Configure the gateway for load_test_mode

The test configuration has one Foundry upstream with placeholder values, one model, and `load_test_mode` turned on.
Sign-in rate limits are raised so that repeated test sign-ins are not refused
([`rate_limits`](https://code.claude.com/docs/en/claude-apps-gateway-config#http-tuning)).

```yaml
listen: { host: 127.0.0.1, port: 18080 }
oidc:
  issuer: http://127.0.0.1:18081
  client_id: load-test
  client_secret: ${LOAD_TEST_CLIENT_SECRET}
  allowed_email_domains: [contoso.com]
  groups_claim: roles
  allowed_groups: [Gateway.Standard]
session: { jwt_secret: ${GATEWAY_JWT_SECRET}, ttl_hours: 1 }
store:
  postgres_url: postgres://postgres@127.0.0.1:5432/gateway_load
  password: ${LOAD_TEST_PG_PASSWORD}
  max_connections: 10
upstreams:
  - provider: foundry
    resource: load-test-not-a-real-resource
    auth: { api_key: load-test-not-a-real-key }
auto_include_builtin_models: false
models:
  - id: claude-sonnet-5
    label: Claude Sonnet 5
    upstream_model: { foundry: claude-sonnet-5 }
rate_limits:
  device_authorization: { max: 1000, window_seconds: 600 }
  device_verify: { max: 1000, window_seconds: 600 }
load_test_mode:
  enabled: true
```

The gateway blocks loopback addresses by default. Version 2.1.308 prints "set CLAUDE_GATEWAY_ALLOW_LOOPBACK=1 in the
gateway environment to allow it" when the issuer is on loopback, so the test sets that variable:

```bash
export CLAUDE_GATEWAY_ALLOW_LOOPBACK=1 GATEWAY_JWT_SECRET=<base64 secret> LOAD_TEST_CLIENT_SECRET=<any value> LOAD_TEST_PG_PASSWORD=<password>
./claude gateway --config gateway.yaml 2> gateway.err.log
```

## Sign in and run the load

`scripts/perf/sign-in.mjs` completes the device sign-in against the fake provider and writes the session token to a
file (scripts/perf/sign-in.mjs:54). The token lasts for `ttl_hours`.

```powershell
node scripts/perf/sign-in.mjs --gateway http://127.0.0.1:18080 --out token.txt
```

`scripts/perf/load-run.mjs` holds a fixed number of streamed requests open for each level. Each request carries an
`x-load-test-user` header from 1 to the population, so the gateway records usage for that many simulated developers
(scripts/perf/load-run.mjs:81).

```powershell
node scripts/perf/load-run.mjs --gateway http://127.0.0.1:18080 --token-file token.txt --population 25000 --levels 50,150,256,512,1000,2000 --duration 60 --json
```

## Sample CPU, memory and PostgreSQL

`scripts/perf/sample.sh` reads the gateway process's CPU ticks and resident memory from `/proc` once a second, and the
database's committed transactions and connections from `pg_stat_database` and `pg_stat_activity`
(scripts/perf/sample.sh:10, scripts/perf/sample.sh:15). Run it for the same period as each load level.

```bash
PGURL=postgres://postgres:<password>@127.0.0.1:5432/gateway_load bash scripts/perf/sample.sh 60 samples-150.jsonl
```

CPU cores used is the change in ticks divided by the clock rate (`getconf CLK_TCK`, 100 on this host) and by the
sampling time. CPU per request is cores used × the run's duration ÷ requests completed in the run. The run lasts about
one 9.5-second reply longer than the level's duration, because open streams finish after the last request starts.

In `load_test_mode` the gateway also writes a line every 10 seconds to standard error that starts with
"load test, last 10 s:". It includes a count of spend checks that failed. That count is the first sign of saturation,
because a failed spend check lets the request through.

## Measurements

One gateway process, `store.max_connections: 10`, 60 seconds per level. Each canned reply streamed about 750 tokens
over about 9.5 seconds. Every level returned only HTTP 200.

| Open requests | Completed per second | Time to first byte p50 / p99 (ms) | CPU cores used | CPU per request | Peak memory | Spend checks failed per 10 s |
|---|---|---|---|---|---|---|
| 50 | 5.2 | 48 / 140 | 0.17 | 32 ms | 202 MB | 0 |
| 150 | 15.6 | 70 / 243 | 0.40 | 26 ms | 216 MB | 0 |
| 256 | 26.3 | 177 / 403 | 0.67 | 26 ms | 229 MB | 0 |
| 512 | 44.2 | 1,087 / 2,667 | 1.04 | n/a (saturated) | 235 MB | 14 to 128 |
| 1,000 | 69.3 | 2,887 / 3,520 | 1.03 | n/a (saturated) | 265 MB | 297 to 583 |
| 2,000 | 86.8 | 7,879 / 21,786 | 0.99 | n/a (saturated) | 295 MB | 1,435 to 1,551 |

- CPU levelled at about 1 core from 512 open requests upward. The calculator counts at most 1 usable core per replica
  for this reason (scripts/perf/capacity.mjs:40).
- Each request made about 2 PostgreSQL transactions.
- With 30 pool connections instead of 10, the 2,000-open run still had 1,988 failed spend checks. The pool is not the
  cause; the single process is out of CPU.
- At 257 open requests the gateway warned that requests exceeded the 256 it sends upstream at once
  ([upstream concurrency](https://code.claude.com/docs/en/claude-apps-gateway-deploy#concurrent-upstream-requests)).
- Spend checks that time out let the request through, so enforcement stops working before clients see any error.

## Measure the Log Analytics billed size

The Azure deployments send the gateway's console output to `ContainerAppConsoleLogs_CL`. The `_BilledSize` column holds
the billed bytes of each row ([standard columns](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/log-standard-columns#_billedsize)).

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30d)
| where Log_s has '"evt":"inference"'
| summarize rows = count(), avgBilledBytes = avg(_BilledSize)
```

On the test deployment, 125 inference rows averaged 686 billed bytes. Sign-in rows averaged 546 to 657 bytes. The
calculator uses 690 and 660 bytes (scripts/perf/capacity.mjs:41).

## Sizing for 500 to 25,000 developers

`node scripts/perf/capacity.mjs --measured` produces this table. The assumptions are the planning figures from
[Plan capacity for 25,000 developers](concept-plan-for-scale.md#gateway-replicas): 20% of developers active at peak,
2 requests per active developer per minute, 30 seconds per request, 150 open requests per replica, 1 vCPU and 2 GiB per
replica, and 2,000 input and 500 output tokens per request (scripts/perf/capacity.mjs:10).

| Developers | Requests/min | Open requests | Replicas (concurrency / CPU / memory) | vCPU | PostgreSQL connections | PostgreSQL smallest / production HA | Log Analytics GB/day | Foundry vs enterprise default quota | Monthly infra (smallest / production) |
|---|---|---|---|---|---|---|---|---|---|
| 500 | 200 | 100 | 2 (1 / 1 / 1) | 2.0 | 50 | B2s / D2ds_v5 ×2 | 0.07 | 0.05× | $124 / $335 |
| 1,000 | 400 | 200 | 2 (2 / 1 / 1) | 2.0 | 50 | B2s / D2ds_v5 ×2 | 0.14 | 0.10× | $125 / $335 |
| 2,000 | 800 | 400 | 3 (3 / 1 / 1) | 3.0 | 70 | B2s / D2ds_v5 ×2 | 0.28 | 0.20× | $149 / $359 |
| 10,000 | 4,000 | 2,000 | 14 (14 / 3 / 1) | 14.0 | 290 | B2s / D2ds_v5 ×2 | 1.39 | 1.00× | $439 / $649 |
| 25,000 | 10,000 | 5,000 | 34 (34 / 7 / 3) | 34.0 | 690 | D2ds_v5 / D2ds_v5 ×2 | 3.48 | 2.50× | $1,052 / $1,182 |

- **Replicas.** The highest of the three counts, with a minimum of 2 for zone loss. Open requests set the count at every
  size.
- **PostgreSQL connections.** 2 × replicas × 10, because old and new revisions run side by side during a rollout,
  plus 10 for the admin console, migrations and operators ([PostgreSQL](concept-plan-for-scale.md#postgresql)). Burstable B2s
  allows 414 user connections (scripts/perf/capacity.mjs:58), so 25,000 developers need a General Purpose server
  ([connection limits](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits)).
- **Foundry quota.** 10,000 developers need the whole enterprise default for one deployment (10,000 requests per minute,
  10 million input and 2 million output tokens per minute); 25,000 need 2.5 times it, so either a quota increase or
  more deployments ([Foundry quota](concept-plan-for-scale.md#foundry-quota)).
- **Monthly infrastructure.** Container Apps, PostgreSQL and Log Analytics at the prices in
  scripts/perf/capacity.mjs:45. It excludes Foundry tokens, the container registry and storage.

Other profiles:

```powershell
node scripts/perf/capacity.mjs --measured --vcpu 0.5 --gib 1 --developers 10000,25000
node scripts/perf/capacity.mjs --measured --seconds-open 9.5 --developers 10000,25000
```

- 0.5 vCPU and 1 GiB per replica: the same 34 replicas at 25,000 developers, $711 / $841 a month.
- Requests that stay open 9.5 seconds instead of 30: 11 replicas at 25,000 developers.

## Recommendations

- Keep 1 vCPU per replica and add replicas rather than vCPU. A second vCPU added no throughput to one process.
- Keep the HTTP scaling target at 150 open requests, below the 256 upstream slots
  (infra/azure-private/Deploy-Gateway.ps1:47).
- Alert on failed spend checks. They appear before any client error and mean budgets are not enforced
  ([gateway logs](https://code.claude.com/docs/en/claude-apps-gateway-deploy#logs)).
- `enforcement.fail_closed_on_error: true` blocks requests when spend enforcement errors instead of letting them
  through, and blocks everyone while the store is unreachable
  ([`enforcement`](https://code.claude.com/docs/en/claude-apps-gateway-config#enforcement)). This test ran with the
  default, fail open.
- Request Foundry quota before onboarding 10,000 developers.
- Measure the real time each request stays open from `inference` events, then rerun the calculator with
  `--seconds-open`.

## Limits of this test

- No Foundry. `load_test_mode` returns canned replies, so Foundry latency, throttling and errors are not measured.
- No upstream TLS. The gateway did not encrypt upstream traffic, so real CPU per request is higher
  ([`load_test_mode`](https://code.claude.com/docs/en/claude-apps-gateway-config#load_test_mode)).
- WSL2 on an AMD EPYC 7763 host, not Azure Container Apps. ACA ingress, its proxy and its scaling delay were not part
  of the test.
- The load generator ran on the same host as the gateway.
- One developer session with simulated users. Sign-in load is sized from rate limits, not measured.
- Spend enforcement ran fail open. Whether a precheck timeout blocks requests under `fail_closed_on_error: true` was
  not tested.
- The binary was checked against the manifest's SHA-256 only; the manifest's GPG signature was not verified.

## Related content

- [Plan capacity for 25,000 developers](concept-plan-for-scale.md)
- [Run the inference tests](how-to-test-inference.md)
- [Script reference](reference-scripts.md)
