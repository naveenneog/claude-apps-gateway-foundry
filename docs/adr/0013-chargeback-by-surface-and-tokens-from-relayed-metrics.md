# ADR-0013: Chargeback by surface and tokens from relayed client metrics, rolled up in PostgreSQL

- **Status:** Proposed
- **Date:** 2026-10-27
- **Packet:** P-42 · **Unknowns:** U-112 to U-119
- **Deciders:** owner (request of 2026-10-26: "the chargeback reports should also contain surfaces and token information
  without increasing much load on log analytics and not increasing the cost of infra"), agent

## Context
The Chargeback page (ADR-0010) reports each person's spend for the current period from the gateway's `/effective` rows,
joined to Entra users by email (U-90). It has no surface (terminal, VS Code, Claude Desktop, Cowork) and no token counts.
The owner asked for both, with two limits: not much more Log Analytics ingestion, and no rise in infrastructure cost.

Facts checked on 2026-10-27:

| Fact | Source |
|---|---|
| The gateway stores spend as per-principal period-to-date counters in cents, kept `admin.spend_retention_months` (default 13). `/effective` returns resolved cap and to-date spend per principal per period; nothing per model, token type or surface. | [Spend limits, Admin API reference and Data lifecycle](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits); [gateway configuration, `admin`](https://code.claude.com/docs/en/claude-apps-gateway-config#admin) |
| The gateway's per-request log line holds `evt: inference`, `request_id`, `sub`, `email`, `path`, `model`, `upstream`, `status` and `ms`; no token counts and no client or surface. | Live `ContainerAppConsoleLogs_CL` rows on the Contoso workspace, 2026-10-26 08:30 to 08:39 UTC, queried 2026-10-27 |
| Claude Code's token counter carries `type` (`input`, `output`, `cacheRead`, `cacheCreation`) and `model`; the cost counter carries `model`. Standard attributes include `terminal.type` and, with `OTEL_METRICS_INCLUDE_ENTRYPOINT=true`, `app.entrypoint` (`cli`, `claude-vscode`, ...). `service.name` is `claude-code` in a terminal and `claude-code-desktop` for the Desktop Code tab. Default export interval 60 s, default temporality `delta`. | [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage): Standard attributes, Cost counter, Token counter, Metrics cardinality control, Common configuration variables |
| The gateway relays client OTLP/HTTP exports verbatim to each `telemetry.forward_to` destination (metrics only by default) and stamps them with the signed-in identity: terminal `user.id` is the IdP subject; Desktop and Cowork carry `enduser.sub`. It pushes `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` to clients. A `http://localhost:<port>` destination needs `CLAUDE_GATEWAY_ALLOW_LOOPBACK=1`. | [gateway configuration, `telemetry`](https://code.claude.com/docs/en/claude-apps-gateway-config#telemetry) |
| On the Consumption plan the CPU and memory of all containers in an app must add up to one allowed pair, such as 1.0 vCPU with 2.0 GiB; the split between containers is free. | [Containers in Azure Container Apps, vCPU and memory allocation requirements](https://learn.microsoft.com/en-us/azure/container-apps/containers#vcpu-and-memory-allocation-requirements) |
| At 1,000 developers the sizing model gives 2 gateway replicas of 1 vCPU and 2 GiB, and 3.06 GB a month of Log Analytics ingestion at 690 billed bytes per inference row, inside the 5 GB monthly free allowance. Container Apps requests cost $0.40 per million. At 10,000 developers ingestion is already above the allowance. | `scripts/perf/capacity.mjs` (`MEASURED`, `PRICES`), measured 2026-10-25 |
| The Contoso gateway runs one container and no telemetry destination; the collector sidecar of ADR-0007 is built only for `infra/azure-private`. | `az containerapp show` on `ca-claude-gw`, revision `--0000014`, 2026-10-27; `infra/azure-private/lib/Steps.Telemetry.psm1` |
| Claude deployments in Foundry report Azure Monitor platform metrics per `ModelDeploymentName`, one for each token type: `InputTokens` (uncached input only), `ephemeral5mInputTokens` and `ephemeral1hInputTokens` (cache writes), `cacheReadInputTokens` and `OutputTokens`. Two requests through the Contoso gateway, a cache write and then a cache read, each matched its `usage` exactly: 15 input, 18,002 cache-write, 18,002 cache-read and 5 output tokens. Each value is stamped in the minute after the request. Platform metrics are kept 93 days and cost nothing to collect. Reading them needs `Microsoft.Insights/metrics/read` on the Foundry account, for example Monitoring Reader (U-119). | Probe on the `claude-sonnet-5` deployment of the gateway's Foundry account, 2026-10-27 02:46 and 02:47 UTC, `az monitor metrics list --interval PT1M`; [Azure Monitor metrics retention](https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/data-platform-metrics#retention-of-metrics); [Monitoring Reader](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/monitor#monitoring-reader) |
| ADR-0002 (Proposed) bounds personal data: telemetry data that carries `user.email` is kept no more than 30 days. The gateway itself keeps anonymous spend counters for 13 months and identity rows (`principal_emails`) for `identity_retention_days`. | `docs/adr/0002-pilot-claude-apps-gateway-alongside-apim.md:130`; ADR-0007 Context |

## Options considered
1. **ADR-0007 as it stands: collector sidecar to Application Insights, report with KQL.** Every client export becomes
   `AppMetrics` rows. With 200 developers active at peak (`activeShare` 0.2) exporting every 60 s and about six data
   points per export, that is about 13 million rows a month (200 × 60 × 8 h × 22 days × 6); at 300 bytes a row, 3.8 GB,
   which with the 3.06 GB of inference rows passes the 5 GB allowance. History is 30 days, and the rows carry
   `user.email`. Fails both of the owner's limits.
2. **Option 1 with pre-aggregation in the collector** (drop attributes, emit hourly). Fewer rows, still growing with
   developers × surfaces × models × token types, still 30 days of history in Log Analytics, still a second container.
3. **Relay the metrics to a small rollup sidecar that adds them to daily rows in the existing PostgreSQL.** Nothing new
   goes to Log Analytics. The sidecar takes 0.25 vCPU and 0.5 GiB out of the gateway app's existing 1 vCPU and 2 GiB, so
   the replica size and its price stay the same. Rows are keyed by the anonymous `sub`, not by email, and kept as long as
   the gateway keeps spend (13 months), which also gives the report past periods (U-89). Costs: a decoder for the OTLP
   protobuf subset written in this repository (it has no package dependencies), a database role for writing and one for
   reading, and the relay's extra requests. Needs a managed PostgreSQL that admin-ui can reach (ADR-0012's persistent
   topology).
4. **Basic or Auxiliary Log Analytics tables for the metrics.** Cheaper ingestion, but queries are charged per GB scanned
   and the console would run them on every page load; does not meet "no rise in cost".
5. **More fields in the gateway's own log line.** The gateway is Anthropic's binary; its log line is not configurable.
   Not available.

## Decision
Option 3, because it is the only option that adds no Log Analytics ingestion and no Azure resource.

- **Data path.** Each policy's `cli.env` sets `OTEL_METRICS_INCLUDE_ENTRYPOINT=true`, `OTEL_METRICS_INCLUDE_SESSION_ID=false`,
  `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` and `OTEL_METRIC_EXPORT_INTERVAL=300000`. `telemetry.forward_to` has one
  destination, `http://localhost:4319`, with `metrics: true`, `logs: false`, `traces: false`; the gateway gets
  `CLAUDE_GATEWAY_ALLOW_LOOPBACK=1`, as ADR-0007 already accepted.
- **Rollup sidecar** (`usage-rollup`, Node, image built from this repository). It accepts `POST /v1/metrics` on
  `localhost:4319` only, decodes the OTLP protobuf subset it needs, keeps only Claude Code's token and cost counters with
  delta temporality, and adds them in one transaction to `usage_daily(day, sub, surface, model, token_type, tokens,
  client_cost_micros)`. It answers 200 only after the commit. It drops `user.email`, `user.groups` and every other
  attribute. It writes no line per export to its console: one summary line an hour, and errors.
- **Surface** is derived in one tested table: `service.name = claude-code-desktop` → Desktop (Code tab); `app.entrypoint =
  claude-vscode` → VS Code; `app.entrypoint = cli` → Terminal; Desktop and Cowork entrypoints (`claude-desktop`,
  `claude-desktop-3p`, `local-agent`) → Desktop or Cowork once U-112 shows which is which; anything else → Other.
- **Resources.** The gateway app stays at 1 vCPU and 2 GiB per replica: gateway 0.75 vCPU and 1.5 GiB, sidecar 0.25 vCPU
  and 0.5 GiB. The sidecar connects as a `usage_writer` role with rights on its own table only; admin-ui reads as a
  `usage_reader` role with `SELECT` on it.
- **Report.** The money stays the gateway's: each person's total is still `/effective` spend. Tokens per surface and model
  come from `usage_daily`. Spend per surface is the person's gateway spend split by their client-reported cost share per
  surface; spend with no telemetry behind it (an old client, a surface that sends none, a lost export) is shown as
  **Not attributed**, never spread over the others. Business units add up their people. The CSV gains one row per person,
  surface and model with the four token types. On the mounted-database topology the page says the breakdown needs the
  managed database.
- **Two independent checks.** The storage choice does not change accuracy: Log Analytics and PostgreSQL would hold the same client-reported numbers. So the report checks them against two sources the client cannot change. (1) Each person's total is the gateway's `/effective` spend, which the gateway meters on every response; the sum over people is compared with the Azure invoice in Cost Management, which bills one Claude meter with no model split. (2) Each token type's total per deployment and day in `usage_daily` is compared with the matching Foundry metric (`InputTokens`, `ephemeral5mInputTokens` plus `ephemeral1hInputTokens`, `cacheReadInputTokens`, `OutputTokens`). Foundry counts every request the gateway sends, so a gap shows lost, double-counted or false client exports. Comparing whole days keeps the one-minute stamp offset from mattering. admin-ui reads the metrics with Monitoring Reader on the Foundry account. Where its identity cannot hold that role, as on Contoso, where the Foundry account is in another tenant (U-80), the operator runs the same comparison with their own sign-in. The console shows the gap and does not correct it.
- **Bounds the packet must meet** (P-42 criteria): no new Log Analytics table and Console-log bytes per inference request
  within 5% of the baseline on the same workload; the gateway replica stays 1 vCPU and 2 GiB; the 1,000-developer monthly
  estimate rises by no more than $1 (relayed exports, at most 12 an active developer-hour: 200 × 12 × 8 h × 22 days ≈
  0.42 million requests ≈ $0.17); `usage_daily` stays under 100 MB a year at 1,000 developers; and the measured requests
  per replica at target utilization with the sidecar are at least what `capacity.mjs` uses.

## Consequences
+ Surfaces and tokens per person and business unit, with 13 months of history, and no new Log Analytics data.
+ No email in the new table; it is resolved at report time through `/effective` and Entra, as today.
- Token counts are client-reported. The gateway attributes them to the signed-in user, but a developer can send false
  metrics. Money is still the gateway's own figure, so a false metric moves spend between that person's surfaces only.
- OTLP has no idempotency key: an export the client retries after a lost answer is counted twice. Bounded by answering
  only after the commit; measured by U-114's reconciliation.
- One more image to build and patch, and two database roles for the installer to create.
- admin-ui needs Monitoring Reader on the Foundry account for the token check. Where the account is in another tenant,
  the check is run by the operator instead (U-119).
- The gateway container has 0.25 vCPU less. U-116 and T-133 check that the relay and the capacity model still hold.
- The mounted-database topology gets no breakdown.

## How we'd know this was wrong
- Client-reported cost differs from gateway spend by more than 10% per person per day on the live test (U-114). The
  split would then misattribute, and the gateway's own data would need a different source.
- Desktop or Cowork send no token counters through the gateway (U-112). Then the surfaces the owner asked for most are
  missing.
- The Log Analytics or cost bounds above are not met when measured (T-131, T-133).
- Anthropic adds per-model or per-surface usage to the gateway's Admin API. Then this sidecar should be retired in its
  favour.
