# ADR-0007: Telemetry through a collector sidecar to Application Insights

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** owner (request: "please switch on the telemetry"), agent
- **Packet:** P-9 · **Unknowns:** U-10 (resolved here), U-29, U-69, U-70

## Context
The owner asked to switch on telemetry, for usage analytics and chargeback. The gateway relays the OTLP/HTTP exports of
signed-in clients to each `telemetry.forward_to` destination and stamps the user's identity (`user.email`,
`user.groups`) on them. A destination URL uses `https://`, except `http://localhost:<port>` for a collector on the
gateway's own loopback, which needs `CLAUDE_GATEWAY_ALLOW_LOOPBACK=1`; the default is metrics only
([gateway configuration, telemetry](https://code.claude.com/docs/en/claude-apps-gateway-config#telemetry)).

ADR-0002 is Proposed until P-16 accepts or rejects it; this ADR adopts its telemetry bounds now: telemetry destinations
take metrics only, and data that carries `user.email` is kept no more than 30 days, in a workspace that grants data read
only to a named group. P-9's criteria name Application Insights, and U-10 asked which path carries OTLP exports there.

| Fact | Source |
|---|---|
| Azure Monitor's generally available OTLP ingestion, through an OpenTelemetry Collector, stores metrics in an Azure Monitor workspace and logs and traces in Log Analytics | [OTLP ingestion](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-protocol-ingestion), [OpenTelemetry options](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-options) |
| An Azure Monitor workspace keeps data for 18 months, and "is not intended for storing any personal data", naming usernames in label values | [Prometheus technical details](https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/prometheus-metrics-details), updated 2026-01-13 |
| The collector's `azuremonitor` exporter writes to Application Insights; metrics land in the `AppMetrics` table of the component's Log Analytics workspace, whose retention can be set per table (U-30) | [azuremonitorexporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/azuremonitorexporter), [table retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure) |
| The exporter's default authentication is the connection string's instrumentation key; it accepts an authenticator extension, while its document says Entra ID authentication is not supported directly | [AUTHENTICATION.md](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/azuremonitorexporter/AUTHENTICATION.md) |
| The `azure_auth` extension attaches a managed identity's token to an exporter's requests, with a configurable scope | [azureauthextension](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/extension/azureauthextension/README.md) |
| Release v0.161.0 of the contrib distribution, of 2026-09-16, holds the OTLP receiver, the memory limiter and batch processors, the `azuremonitor` exporter and the `azure_auth` and health check extensions | [manifest at v0.161.0](https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.161.0/distributions/otelcol-contrib/manifest.yaml) |

## Options considered
1. **A collector sidecar with the `azuremonitor` exporter to Application Insights.** Per-user metrics in `AppMetrics`,
   queried with KQL, kept 30 days in the deployment's workspace. The exporter is beta.
2. **A collector sidecar exporting to Azure Monitor's OTLP ingestion.** The supported path, with managed identity
   authentication. Metrics carrying `user.email` would be kept 18 months in a store not intended for personal data,
   which ADR-0002 rules out.
3. **Option 2 with `user.email` removed in the collector.** Keeps the supported path, but per-user usage is gone;
   chargeback by group only.
4. **Logs instead of metrics**, keeping only the per-request event of Claude Code in Log Analytics. Changes ADR-0002's
   metrics-only decision, and logs can carry commands and file paths.

## Decision
Option 1.

- An `opentelemetry-collector-contrib` v0.161.0 container, imported into the deployment's registry by the digest of its
  manifest list and referenced by that digest, runs as a sidecar in the gateway Container App. The telemetry step stops
  before any change when the tag in the registry is at another digest, and reads the digest again after an import. Containers of one app "share hard disk and network
  resources", so the gateway reaches the collector on `localhost`
  ([multiple containers](https://learn.microsoft.com/en-us/azure/container-apps/containers#multiple-containers)).
- The collector receives OTLP/HTTP on `localhost:4318` and has one pipeline, for metrics, through the memory limiter
  and the batch processor to the `azuremonitor` exporter. With no logs or traces pipeline it holds no receiver for
  them, and answers 404 on their paths (T-32, measured 2026-09-30).
- The gateway's configuration gains one destination, `http://localhost:4318` with `metrics: true`, `logs: false` and
  `traces: false`, and the gateway's environment `CLAUDE_GATEWAY_ALLOW_LOOPBACK=1`. Each policy's `cli.env` sets
  `OTEL_METRICS_INCLUDE_SESSION_ID=false` and `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`, so a series is per user and
  model, not per session, for 25,000 developers
  ([monitoring usage](https://code.claude.com/docs/en/monitoring-usage)).
- A workspace-based Application Insights component on `log-claude-gw` receives the metrics. Every table of the workspace keeps
  30 days, except `Usage` and `AzureActivity`, which keep at least 90 (U-30); the step lists the tables, since the component
  adds tables over time (`AppGenAIContent`, measured 2026-09-30). The workspace keeps 30 days, purges at 30 days and
  requires workspace permissions; the step checks all three (T-39).
- The collector authenticates with its managed identity: the `azure_auth` extension and the gateway's user-assigned
  identity, which holds Monitoring Metrics Publisher on the component. Its connection string is a Container App secret.
  Local authentication is disabled on the component, so the instrumentation key in the connection string does not
  authorise ingestion
  ([Entra authentication for Application Insights](https://learn.microsoft.com/en-us/azure/azure-monitor/app/azure-ad-authentication)).
  T-78 showed on 2026-09-30 that the identity's token does (U-69). A changed connection string restarts the latest
  revision, as a changed secret reaches no running revision. The exporter's current name is `azure_monitor`; v0.161.0
  logs `azuremonitor` as deprecated.
- Read access limited to a named group in DataActionsOnly mode (T-35, U-29) becomes packet P-32. Until P-32 is done,
  the app registration assigns a role only to the operator, so only the operator can sign in and the only personal
  data in the workspace is the operator's; P-32 comes before a role is assigned to anyone else. While telemetry is on,
  the app step refuses to deploy when anyone but the operator holds a role (T-79), and the verify step checks the
  holders (T-78). The holders are read from every page, and a page that cannot be read stops the step, so a partial
  list never passes the rule.

## Consequences
+ Token and cost metrics per user and model are queryable with KQL in `AppMetrics`, kept 30 days, as ADR-0002 requires.
+ The instrumentation key in the connection string does not authorise ingestion, since local authentication is off;
  ingestion needs the identity's token (U-69). The sidecar reaches the ingestion endpoint over the environment's existing
  outbound path.
- Until P-32 is done, every reader of `log-claude-gw` can read the operator's email in `AppMetrics`.
- The exporter is beta and community-maintained; a new image version is checked with the synthetic metric (T-78)
  before it is deployed.
- An export that the ingestion endpoint refuses leaves no line in the collector's log at the default level: with the
  publisher role removed, T-78's negative on 2026-09-30 lost its metric and the last 200 log lines named no refusal. A
  refusal shows only as missing rows, so the verify step runs T-78 after each deployment.
- Every client exports on an interval, so `AppMetrics` grows with active developers; the ingestion volume for
  25,000 developers is measured with P-28.
- The sidecar takes CPU and memory from each replica: 0.25 CPU and 0.5 GiB, making the replica 1.25 CPU and 2.5 GiB.
- Ingestion uses Application Insights' public endpoint; a private link scope is left for later.

## How we'd know this was wrong
The synthetic metric does not reach `AppMetrics`, or arrives without its attributes (U-70); the exporter's release
notes deprecate it; or an `App*` table keeps data past 30 days (T-39).
