---
title: Plan Claude apps gateway capacity for 25,000 developers on Azure
description: Size sign-in limits, gateway replicas, PostgreSQL, Foundry quota, identity and private connectivity for a rollout to 25,000 developers.
author: naveenneog
ms.date: 09/29/2026
ms.topic: concept-article
---

# Plan capacity for 25,000 developers

A rollout has six separate capacity boundaries: sign-in limits, gateway replicas, PostgreSQL connections, Foundry
quota, identity, and network/DNS/certificate management. Developer count alone does not determine inference load.
This article covers the internal Container Apps environment, private PostgreSQL store and private-endpoint Foundry
accounts in docs/adr/0005-network-restricted-deployment.md:55-77. Worked examples are assumptions, not measured capacity.

## Limits at a glance

Defaults and repository inputs were checked on September 29, 2026; they are not capacity benchmarks.

| Limit | Default | Setting in this repository | Source |
|---|---|---|---|
| Sign-in starts, per client address | 30 per 600 seconds | `rate_limits.device_authorization`: 1,000 per 600 seconds | [HTTP tuning](https://code.claude.com/docs/en/claude-apps-gateway-config#http-tuning); config/gateway.azure-private.yaml:72 |
| Code submissions, per client address | 10 per 600 seconds | `rate_limits.device_verify`: 100 per 600 seconds | [HTTP tuning](https://code.claude.com/docs/en/claude-apps-gateway-config#http-tuning); config/gateway.azure-private.yaml:73 |
| Concurrent upstream requests, per replica | 256 | `-MaxUpstreamRequests` sets `BUN_CONFIG_MAX_HTTP_REQUESTS` | [Upstream concurrency](https://code.claude.com/docs/en/claude-apps-gateway-deploy#concurrent-upstream-requests); infra/azure-private/lib/AppDefinition.psm1:25 |
| HTTP scale-out target | 10 concurrent requests | `-ConcurrentRequests`: 150 | [HTTP scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app#http); infra/azure-private/Deploy-Gateway.ps1:42 |
| PostgreSQL pool, per replica | 5 connections | `store.max_connections`: 5 | [Store](https://code.claude.com/docs/en/claude-apps-gateway-config#store); config/gateway.azure-private.yaml:33 |
| Readiness grace after a store outage | 0 seconds | `store.readiness_grace_seconds`: 300 | [Store](https://code.claude.com/docs/en/claude-apps-gateway-config#store); config/gateway.azure-private.yaml:35 |
| Gateway session lifetime | 1 hour | `session.ttl_hours`: 1 | [Session](https://code.claude.com/docs/en/claude-apps-gateway-config#session); config/gateway.azure-private.yaml:27 |
| Gateway shutdown drain | 25 seconds | 120 seconds; container termination grace 130 seconds | [Upgrades](https://code.claude.com/docs/en/claude-apps-gateway-deploy#upgrades); infra/azure-private/lib/AppDefinition.psm1:28; infra/azure-private/lib/AppDefinition.psm1:59 |

## Sign-in rate limits

These limits apply to sign-in, not inference. Without `listen.trusted_proxies`, the gateway counts the ingress
address rather than developer addresses ([large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts)).
For evenly distributed sign-ins, `attempts per address per window = developers / addresses × window / rollout duration`.
Set `max = round up(estimated attempts × 2)`: the factor of 2 allows retries and multiple clients.
Calculate starts and browser code submissions separately if their network paths differ.

- **Assumption: distinct private addresses.** Each of the 25,000 developers keeps an individual private address.
  Their CLI, extension, Desktop and browser attempts stay below 30 starts and 10 submissions per 600 seconds.
  Defaults suffice; total headcount does not combine their buckets.
- **Assumption: shared addresses.** Developers share 10 NAT/VPN egress addresses and sign in evenly over 2 hours:
  `25,000 / 10 = 2,500` developers per address; `120 minutes / 10 minutes = 12` windows; about `208.3` sign-ins per window.
  Doubling gives about `416.7`; rounding up to **500** for each limit provides an example rollout setting.

Measure the busiest `client_ip`/window in [sign-in audit events](https://code.claude.com/docs/en/claude-apps-gateway-deploy#logs).
The repository's 100 code submissions would throttle this example even though its 1,000 starts suffice.

Set `deployment.signInsPerAddress` and `deployment.codeSubmissionsPerAddress` to 500 for this example
(config/gateway-admin.azure-private.json:38-39). Windows remain 600 seconds (config/gateway.azure-private.yaml:72-73).
Render, then check, from the repository root:

```powershell
node scripts\admin\new-gateway-config.mjs --topology private
node scripts\admin\new-gateway-config.mjs --topology private --check
```

Options are defined at scripts/admin/new-gateway-config.mjs:239-245; rendering does not deploy the change.
`device_verify` protects against guessing codes: raise it only as needed. Lower limits after rollout if refresh tokens
enable silent renewal; otherwise size for repeated sign-ins
([large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts)).

## Gateway replicas

Use [Little's law](https://en.wikipedia.org/wiki/Little%27s_law): average concurrency = requests/second × average seconds open.
Estimate the busiest sustained interval, then test bursts. Count model requests, including tool turns, not user prompts.

| Input | Assumption for this example | How to measure |
|---|---|---|
| Developers active at peak | 20% of 25,000 = 5,000 | Distinct `sub` values in `inference` events during the peak interval |
| Requests per active developer | 2 per minute | Model request count divided by active developers and interval duration |
| Average time a request stays open | 30 seconds | Time from request start to stream end in the client/load generator |

Audit fields are recorded in docs/UNKNOWNS.md:55; the target is 150, below 256 upstream slots (infra/azure-private/Deploy-Gateway.ps1:42-43).

```text
request rate = 25,000 × 20% × 2 = 10,000 requests/minute
concurrency = (10,000 / 60) × 30 = 5,000 open requests
replicas = ceiling(5,000 / 150) = 34
```

This is a floor, not a production recommendation. Allow for bursts, uneven routing, overlap and zone loss.
`-MinReplicas`, `-MaxReplicas` and `-ConcurrentRequests` control the range/target (infra/azure-private/lib/AppDefinition.psm1:76-80).
The HTTP target is a scaling signal, not a hard cap
([HTTP scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app#http)).

A stream occupies an upstream slot until it ends; queued bodies also consume memory. `-MaxUpstreamRequests` sets
`BUN_CONFIG_MAX_HTTP_REQUESTS` (1–65,535). Measure CPU/memory before raising it, and keep the HTTP target below it
([upstream concurrency](https://code.claude.com/docs/en/claude-apps-gateway-deploy#concurrent-upstream-requests)).

CPU/memory capacity remains unmeasured (U-58, docs/UNKNOWNS.md:69). `-Cpu`/`-Memory` request 1 vCPU/2 GiB (infra/azure-private/Deploy-Gateway.ps1:44-45).
Use [`load_test_mode`](https://code.claude.com/docs/en/claude-apps-gateway-config#load_test_mode) on an isolated deployment with its own empty database,
never a gateway developers use. It returns canned replies without Foundry; `x-load-test-user` simulates distinct users.
The mode needs gateway 2.1.282+; CPU estimates before 2.1.283 are substantially lower. Even newer estimates omit upstream encryption.

Hold one replica fixed; vary duration, body size and concurrency; measure queue onset and CPU/memory growth per open request
with [replica metrics](https://learn.microsoft.com/en-us/azure/container-apps/metrics). Include planned spend enforcement, then test autoscaling and real Foundry.

Create with `-ZoneRedundant` where supported; keep at least 2 minimum replicas, more if the peak cannot wait for scaling
([zone distribution](https://learn.microsoft.com/en-us/azure/reliability/reliability-container-apps)).
Azure allows [1,000 replicas per revision](https://learn.microsoft.com/en-us/azure/container-apps/scale-app#scale-definition).
The Consumption-core [quota](https://learn.microsoft.com/en-us/azure/container-apps/quotas) sums all active replicas' cores across apps; allocations vary.
Read it before selecting `-MaxReplicas`:

```powershell
az containerapp env list-usages --resource-group "<resource-group>" --name "<environment>"
```

Request more through the environment's **Quota** page. The example needs `34 × 1 = 34` cores before overlap/other apps.
The deployment's allocation remains unchecked (U-60, docs/UNKNOWNS.md:71).

`CLAUDE_GATEWAY_DRAIN_TIMEOUT_MS` is 120,000 ms; termination grace is 130 seconds (infra/azure-private/lib/AppDefinition.psm1:28; infra/azure-private/lib/AppDefinition.psm1:59).
Keep grace at least 5 seconds beyond drain; unfinished streams are cut ([upgrades](https://code.claude.com/docs/en/claude-apps-gateway-deploy#upgrades)).
Azure documents a [240-second HTTP ingress timeout](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#http).
A 403.5-second stream completed in the test deployment (U-40, docs/UNKNOWNS.md:51), not a guarantee at every load.
Retest long streams on the private deployment, including scale-in and upgrades.

## PostgreSQL

Budget for the old and new revisions of a rollout, which hold connections at the same time: `2 × replicas × store.max_connections + other connections ≤ max_connections − reserved connections`. On 2026-09-29 a rollout of 2 replicas at 10 connections each, next to the old revision's 2, logged `remaining connection slots are reserved for roles with the SUPERUSER attribute` on Burstable B1ms (tests/azure-private.test.mjs:135-138).
Pools are [per replica, not per developer](https://code.claude.com/docs/en/claude-apps-gateway-config#store).
Azure currently reserves 15 connections. Read `max_connections`, `reserved_connections` and `superuser_reserved_connections`;
defaults do not automatically increase after a SKU change ([PostgreSQL limits](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits)).

| SKU | Default maximum connections | Maximum user connections |
|---|---|---|
| Burstable B1ms | 50 | 35 |
| Burstable B2s | 429 | 414 |
| General Purpose D2ds_v5 | 859 | 844 |
| General Purpose D4ds_v5 | 1,718 | 1,703 |
| General Purpose D8ds_v5 | 3,437 | 3,422 |
| General Purpose D16ds_v5 | 5,000 | 4,985 |

The example's `2 × 34 × 10 = 680` connections, a rollout of 34 replicas at 10 connections each, fit D2ds_v5's 844 before other clients, but do not establish CPU/I/O capacity.
Set the pool through `deployment.storeConnectionsPerReplica` (config/gateway-admin.azure-private.json:40).

The B1ms test ceiling is `-MaxReplicas 3` with 5 connections per replica: `2 × 3 × 5 = 30` of 35 maximum user connections (infra/azure-private/Deploy-Gateway.ps1:38-41).
A test checks this default budget (tests/azure-private.test.mjs:132-142). Production guidance is General Purpose with zone-redundant HA
(docs/adr/0005-network-restricted-deployment.md:69; [HA support](https://learn.microsoft.com/en-us/azure/postgresql/high-availability/concepts-high-availability)).
`-PostgresSku`, `-PostgresTier` and `-PostgresZonalResiliency` apply to new servers, not upgrades (infra/azure-private/lib/Steps.Base.psm1:92-100).

Built-in [PgBouncer](https://learn.microsoft.com/en-us/azure/postgresql/connectivity/concepts-pgbouncer) uses port 6432
on General Purpose/Memory Optimized tiers. Compatibility is unvalidated here: test pooling mode, sign-in, spend writes
and migrations with their [advisory lock](https://code.claude.com/docs/en/claude-apps-gateway-deploy#upgrades) before adopting it.

Startup/liveness probe `/healthz`; readiness probes `/readyz` (infra/azure-private/lib/AppDefinition.psm1:69-71).
The 300-second grace keeps ready replicas in rotation through short failovers. New sign-ins fail; existing tokens validate locally.
Spend enforcement fails open by default; `enforcement.fail_closed_on_error: true` blocks inference even while ready
([outage behavior](https://code.claude.com/docs/en/claude-apps-gateway-deploy#outage-behavior)).
Spend limits add database work per inference request and durable counters, caps and audit tables. Back them up and
test restores ([store](https://code.claude.com/docs/en/claude-apps-gateway-config#store); [Postgres](https://code.claude.com/docs/en/claude-apps-gateway-deploy#postgres)).

## Foundry quota

The [Claude quota reference](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-quotas-limits)
defines subscription pools per model/version and deployment type: Global Standard across all regions; Data Zone Standard
within each data zone. Another account/region in the same pool does **not** multiply quota. RPM, uncached input tokens
per minute (ITPM) and output tokens per minute (OTPM) are separate limits. Cache writes count toward ITPM; cache reads do not.

These published defaults apply to Claude Sonnet 5 and Opus 5, for Global Standard and US Data Zone Standard:

| Subscription offer | RPM | ITPM | OTPM |
|---|---|---|---|
| Enterprise / MCA-E | 10,000 | 10,000,000 | 2,000,000 |
| Pay-as-you-go | 40 | 40,000 | 8,000 |

**Assumption:** all 10,000 requests/minute target one model, averaging 2,000 uncached input and 500 output tokens/request.
Then `ITPM = 10,000 × 2,000 = 20,000,000` and `OTPM = 10,000 × 500 = 5,000,000`, exceeding enterprise defaults.
Recalculate per model from pilot usage responses; measured `inference` events contain no token counts (docs/UNKNOWNS.md:63).
Read granted capacity on Foundry's **Quota** page and submit the [increase form](https://aka.ms/oai/stuquotarequest);
approval is not guaranteed. The deployment's grant remains to be checked (U-59, docs/UNKNOWNS.md:70).

Foundry returns HTTP 429 at a rate limit. The gateway [fails over](https://code.claude.com/docs/en/claude-apps-gateway-config#multiple-upstreams)
in order on 429, 5xx, 401, 403, 404 or timeouts. Every request tries the first upstream; failures are not remembered.
It waits up to one hour for Foundry to start responding: this is not load balancing or guaranteed prompt failover.

**Example fragment:** separate accounts with deployment mappings. The renderer currently emits a single account
(scripts/admin/new-gateway-config.mjs:150-154); adopting this needs a renderer change, not an edit to generated output.

```yaml
upstreams:
  - name: foundry-primary
    provider: foundry
    resource: example-primary
    auth: { use_azure_ad: true }
  - name: foundry-secondary
    provider: foundry
    resource: example-secondary
    auth: { use_azure_ad: true }
auto_include_builtin_models: false
models:
  - id: claude-sonnet-5
    upstream_model: { foundry-primary: claude-sonnet-5, foundry-secondary: claude-sonnet-5 }
  - id: claude-opus-5
    upstream_model: { foundry-primary: claude-opus-5, foundry-secondary: claude-opus-5 }
```

Mappings use upstream `name` ([models](https://code.claude.com/docs/en/claude-apps-gateway-config#models)).
Each account needs private endpoint/DNS, public access and key auth disabled, and `Cognitive Services User` for the
gateway's user-assigned identity ([Foundry auth](https://code.claude.com/docs/en/claude-apps-gateway-config#microsoft-foundry);
docs/adr/0005-network-restricted-deployment.md:70-72). Verify quota before relying on fallback.
Sonnet uses Global Standard here (processing in any Azure region); Opus uses Data Zone Standard (processing within its zone).
Preserve this on fallback; private endpoints do not change [processing residency](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types).

## Identity

Assign `Gateway.Standard`/`Gateway.Premium` to developer groups; Entra emits [`roles`](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps).
The gateway uses `groups_claim: roles` (config/gateway.azure-private.yaml:21-23).
Group assignment requires Entra ID P1/P2 and excludes nested-group members
([assignment requirements](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).
Using app roles avoids relying on a `groups` claim that is omitted above 200 group memberships in JWTs
([group overage](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference#groups-overage-claim)).
Per-role policies restrict models (config/gateway.azure-private.yaml:54-65); `deployment.desktop: true` enables Desktop (config/gateway-admin.azure-private.json:41).

Retain `offline_access` and test silent refresh. Sessions last 1 hour; deprovisioning takes effect at refresh/expiry,
not immediately. There is no individual gateway-token revocation. Rotate signing keys in stages: accept old and new,
sign with new, wait the session lifetime plus a margin, then remove old. Outright replacement signs everyone out
([session](https://code.claude.com/docs/en/claude-apps-gateway-config#session); [JWT rotation](https://code.claude.com/docs/en/claude-apps-gateway-deploy#jwt-secret-rotation)).

## Network, DNS and certificate

Developers need ExpressRoute/VPN routes to the environment's static private IP. App ingress is external to the
**internal environment**, not the internet ([ingress visibility](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#how-ingress-visibility-interacts-with-the-environment-type)).
Conditionally forward the gateway zone to an [Azure DNS Private Resolver inbound endpoint](https://learn.microsoft.com/en-us/azure/dns/dns-private-resolver-overview#inbound-endpoints).
Link the private zone to its VNet. `/login` requires [private-only gateway resolution](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites).

`listen.trusted_proxies` names the ranges a workload profile environment reserves, where the Container Apps ingress
connects from, while `access_control.allow_cidrs` names developer networks from `deployment.developerCidrs`
(config/gateway.azure-private.yaml:12-14; config/gateway.azure-private.yaml:67-68;
config/gateway-admin.azure-private.json:35-37). Developer subnets are never trusted as proxies
(docs/adr/0005-network-restricted-deployment.md:75-87).

Bind a custom domain to a TLS certificate issued by the organization's CA ([Container Apps certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-certificates));
install the CA trust chain on clients. The change to the custom origin also sets `GATEWAY_PUBLIC_URL` and the Entra
redirect URI `<origin>/oauth/callback` to it; `Deploy-Gateway.ps1` derives both from the default host name
(infra/azure-private/lib/AppDefinition.psm1:16; infra/azure-private/lib/Steps.App.psm1:44).
The CLI pins the leaf certificate per hostname. Publish its SHA-256 fingerprint
and plan rotations: each prompts developers again. Put the hostname in `NO_PROXY` to avoid proxy bypass of pin checks
([connect developers](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers)).
Measured on 2026-09-29: the internal default domain served a publicly trusted, platform-managed certificate from
`Microsoft TLS G2 RSA CA OCSP 02`, valid 2026-09-28 to 2027-01-06 (100 days); the platform controls rotation (U-56, docs/UNKNOWNS.md:67).

## Rollout waves

Load test first, then pilot all clients and corporate/VPN paths against real Foundry. Size waves from sign-in concentration
and inference demand, not invitation count ([large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts)).
Pause expansion when queueing, failures or quota use exceed the pilot's agreed operating bounds.

| Component | Signal to watch | Source |
|---|---|---|
| Sign-in | `sign-in refused`, `client_ip`, rate-limited attempts; Claude Code 2.1.274+ displays `The gateway is limiting sign-in attempts right now` | [Large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts) |
| Gateway | `client requests are open`, latency and `drain window over after`; replica count, CPU, memory and restarts | [Concurrency](https://code.claude.com/docs/en/claude-apps-gateway-deploy#concurrent-upstream-requests), [upgrades](https://code.claude.com/docs/en/claude-apps-gateway-deploy#upgrades), [metrics](https://learn.microsoft.com/en-us/azure/container-apps/metrics) |
| PostgreSQL | `active_connections` includes active and idle connections; compare with usable capacity, failed connections, CPU and storage | [PostgreSQL metrics](https://learn.microsoft.com/en-us/azure/postgresql/monitor/concepts-monitoring#default-metrics) |
| Foundry | 429 status in `inference` events; operational logs for upstream 429s hidden by successful fallback; RPM, ITPM and OTPM | [Gateway logs](https://code.claude.com/docs/en/claude-apps-gateway-deploy#logs), [Claude quota](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-quotas-limits) |
| Identity | `auth.denied`, `session.mint` and `session.refresh` outcomes | [Gateway logs](https://code.claude.com/docs/en/claude-apps-gateway-deploy#logs) |
| Network and TLS | Private DNS answers, connection failures and unexpected fingerprint prompts | [Prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites), [certificate pinning](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers) |

## Related content

- [Gateway overview](overview.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Run the inference tests](how-to-test-inference.md)
- [Script reference](reference-scripts.md)
- [Deploy a network-restricted gateway](tutorial-deploy-network-restricted.md)
- [Connect Claude Code, VS Code and Claude Desktop](how-to-connect-clients.md)
