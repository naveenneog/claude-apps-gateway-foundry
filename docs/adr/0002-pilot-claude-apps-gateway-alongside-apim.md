# ADR-0002: Pilot the Claude apps gateway with a Foundry upstream alongside APIM; decide after the parity run

- **Status:** Proposed
- **Date:** 2026-09-23
- **Packet:** P-1 (recorded) · P-16 (accept or reject)
- **Deciders:** owner

## Context

- Route A is in production: Claude Code sends an Entra token to APIM (`apim-claude-gw-fzgql9`, Basic v2,
  public), and APIM calls Foundry with its managed identity (`docs/ARCHITECTURE.md`, route A).
- The `claude` binary includes a self-hosted gateway, started with `claude gateway --config gateway.yaml`,
  with Microsoft Foundry as a supported upstream ([overview](https://code.claude.com/docs/en/claude-apps-gateway)).
- Anthropic's documentation states: "If you already run an LLM gateway or API gateway that meets your
  needs, keep using it" ([other gateway implementations](https://code.claude.com/docs/en/claude-apps-gateway#other-gateway-implementations)).
- Verified this session by probe (2026-09-23): the gateway refuses to run on Windows; the Claude
  deployments and their resources (U-7); key auth disabled on every Foundry account; the APIM instance,
  URL and API path; the npm feed proxy on this machine trails the public changelog (U-5).
- Verified in documentation: a provider variable such as `CLAUDE_CODE_USE_FOUNDRY=1` skips the gateway
  sign-in (U-16), so route A stays usable by anyone APIM admits until P-12 removes migrated users.
- Assumed, with a detector: Container Apps managed identity works with `use_azure_ad: true` (U-11).

## Options considered

1. **A1 — APIM only (status quo).** Keeps what works, including CI; developer machines keep an Azure
   credential and the access sync job.
2. **A2 — APIM plus endpoint-managed settings.** Route A with a managed settings file or HKLM profile
   per device group, as the accelerator already generates (`New-ClaudeCodePolicy.ps1`); central client
   policy without a second service; targeting follows device groups, not IdP groups.
3. **B — Claude apps gateway → Foundry.** SSO sign-in, per-IdP-group policy and Claude Desktop from one
   service; a new self-hosted service, private-only access and a smaller Claude Code feature set.
4. **C — Claude apps gateway → separate APIM API → Foundry.** B's client-facing features plus APIM's
   per-minute limits, LLM logs, chargeback queries and CI entry point; two gateways, one more hop, and a
   gateway-to-APIM trust contract (U-18, U-25, U-26).
5. **D — Direct Foundry per developer.** No gateway; every developer needs a Foundry data-plane role;
   no per-user limits or central policy. Rejected for developers; kept as the measurement baseline.

## Comparison

Route A is the current APIM gateway; route B is the Claude apps gateway with a Foundry upstream.
Where route A2 differs from A, the APIM column says so.

Update, 2026-09-27: the APIM column describes the accelerator before 2026-09-23. At commit `ea31a5f`
it also has USD budgets, MDM assignment to Entra user groups, Entra sign-in keys for Claude Desktop, a
Cosmos DB entitlement projection and private network options. [docs/GATEWAY-COMPARISON.md](../GATEWAY-COMPARISON.md)
compares the two routes against that commit and records this repository's measured results.

| Dimension | APIM route (A) | Claude apps gateway route (B) | Evidence |
|---|---|---|---|
| Operating model | Azure-managed service; Basic v2 instance deployed from Bicep | Self-hosted Linux container around the pinned `claude` binary, plus PostgreSQL 14+; the operator patches it with each Claude Code release | [claude-code-foundry-gateway@f237fb9:infra/main.bicep:27-31](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/main.bicep#L27-L31) ; https://code.claude.com/docs/en/claude-apps-gateway-deploy#upgrades |
| Developer sign-in | Entra access token from `DefaultAzureCredential` (typically `az login`) on every request, checked by `validate-azure-ad-token` | Browser device flow through `/login` against Entra; the gateway issues its own session token, 1 h by default, refreshed silently | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:27-36](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L27-L36) ; https://code.claude.com/docs/en/claude-apps-gateway-config#session |
| Credential on the developer machine | Azure CLI or another source that mints a token for the Foundry audience | The gateway session token only; no Azure CLI, API key or subscription | https://code.claude.com/docs/en/microsoft-foundry ; https://code.claude.com/docs/en/claude-apps-gateway#connect-developers |
| Gateway to Foundry | APIM managed identity with `Cognitive Services User` | Managed identity through `use_azure_ad: true`; documented hosts are AKS, ACI and App Service (U-11) | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:140-147](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L140-L147) ; https://code.claude.com/docs/en/claude-apps-gateway-config#microsoft-foundry |
| Membership source and lag | Object-ID allowlists in APIM named values, synced from Entra groups by `Sync-ClaudeAccess.ps1`; lag equals the sync cadence | `groups` or `roles` claim from the id_token at each session re-mint, bounded by `ttl_hours`; no sync job; object IDs; Entra includes nested groups except under "groups assigned to the application"; over 200 groups Entra omits the claim (U-2); group-based assignment needs Entra ID P1 or P2 (U-24) | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:16-19](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L16-L19) ; [claude-code-foundry-gateway@f237fb9:infra/policy.xml:53-65](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L53-L65) ; https://code.claude.com/docs/en/claude-apps-gateway-config#managed ; https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims |
| Model access | Tier policy with model allowlists (accelerator) | `availableModels` per policy, enforced at `/v1/messages` with 400 and reflected in the `/model` picker | [claude-code-foundry-gateway@205a6cc:infra/main.bicep:61-65](https://github.com/naveenneog/claude-code-foundry-gateway/blob/205a6ccc10fb45451afbd048d26884e6175ec8a3/infra/main.bicep#L61-L65) ; https://code.claude.com/docs/en/claude-apps-gateway-config#managed |
| Client policy delivery | APIM does not deliver settings. On route A2, a managed settings file or HKLM profile per device group carries them; the accelerator generates the APIM route `env`, deny rules and locks | Managed settings chosen per IdP group at sign-in (permissions, hooks, `env`, MCP servers), polled hourly; shell-capable keys raise an approval dialog | [claude-code-foundry-gateway@205a6cc:scripts/New-ClaudeCodePolicy.ps1:160-203](https://github.com/naveenneog/claude-code-foundry-gateway/blob/205a6ccc10fb45451afbd048d26884e6175ec8a3/scripts/New-ClaudeCodePolicy.ps1#L160-L203) ; https://code.claude.com/docs/en/managed-settings ; https://code.claude.com/docs/en/claude-apps-gateway-config#what-goes-in-cli |
| Inference rate limits | Tokens per minute and per day per developer through `llm-token-limit`; 120 calls per minute | None on inference; `rate_limits` covers only the sign-in endpoints | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:82-124](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L82-L124) ; https://code.claude.com/docs/en/claude-apps-gateway-config#http-tuning |
| Budgets | Token quotas; the accelerator adds an organisation ceiling and business-unit budgets | USD caps per user, group or organisation, daily, weekly or monthly, through an admin API; Claude Code warns at 75% and 95% | [claude-code-foundry-gateway@205a6cc:infra/main.bicep:58-74](https://github.com/naveenneog/claude-code-foundry-gateway/blob/205a6ccc10fb45451afbd048d26884e6175ec8a3/infra/main.bicep#L58-L74) ; https://code.claude.com/docs/en/claude-apps-gateway-spend-limits |
| Over-limit response | 429 with `Retry-After` per minute; 403 per day | 429 `billing_error` with `x-should-retry: false` and `retry-after` | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:82-124](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L82-L124) ; https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-enforcement-works |
| Cost attribution | Token counts measured at the gateway; streamed tokens estimated; interrupted streams under-count | USD estimate from list price or `pricing.overrides`; aborted streams billed at a floor of about four characters per output token; not an invoice | https://learn.microsoft.com/en-us/azure/api-management/llm-emit-token-metric-policy ; https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-requests-are-priced |
| Usage telemetry | Gateway-side token metrics with UPN, object ID, tier, model and session dimensions in Application Insights; LLM logs and KQL chargeback in the accelerator | Client OTLP/HTTP exports relayed with `user.id`, `user.email` and `user.groups`; metrics by default, logs and traces opt-in; no buffering or retry; no prompt or completion storage | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:129-135](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L129-L135) ; https://code.claude.com/docs/en/claude-apps-gateway-config#telemetry |
| Audit trail | APIM diagnostics to Application Insights | Single-line JSON audit events on stderr, such as `session.mint`, `auth.denied`, `inference` and `spend.blocked` | [claude-code-foundry-gateway@f237fb9:infra/main.bicep:235-248](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/main.bicep#L235-L248) ; https://code.claude.com/docs/en/claude-apps-gateway-deploy#logs |
| Protocol upkeep | The operator keeps header and body forwarding current as Claude Code adds `anthropic-*` values | Released and tested with the CLI; forwards `anthropic-beta` to every upstream without an allowlist | https://code.claude.com/docs/en/llm-gateway-protocol#forward-as-open-lists ; https://code.claude.com/docs/en/claude-apps-gateway#availability-and-limitations |
| Claude Code features | Foundry client behaviour: 1-hour cache TTL with `ENABLE_PROMPT_CACHING_1H=1`; web search on Anthropic-hosted deployments only | WebSearch, 1-hour cache TTL and Remote Control unavailable; beta values limited to the set Bedrock and Agent Platform accept | https://code.claude.com/docs/en/microsoft-foundry ; https://code.claude.com/docs/en/feature-availability#summary-by-provider ; https://code.claude.com/docs/en/claude-apps-gateway#availability-and-limitations |
| Claude Desktop | Claude Desktop 3P with an `inferenceCredentialHelper` script | `bootstrapUrl` plus a `desktop` policy key; the same sign-in and per-group policy for the Cowork, Code and Chat tabs | [claude-desktop-foundry@c2675ff:policy/examples/claude-desktop-gatewayhelper.apply.ps1:10-11](https://github.com/naveenneog/claude-desktop-foundry/blob/c2675ff2aeb67ee0c83e1a919dfecb397d53e147/policy/examples/claude-desktop-gatewayhelper.apply.ps1#L10-L11) ; https://code.claude.com/docs/en/claude-apps-gateway#connect-claude-desktop |
| CI and unattended jobs | An allowlisted Entra service principal or managed identity can call it | No service-token flow; CI calls the provider directly | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:27-36](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L27-L36) ; https://code.claude.com/docs/en/claude-apps-gateway#ci-pipelines-and-remote-machines |
| Upstream resilience | Backend pools of up to 30 backends, priority and weighted balancing, circuit breaker (v2 tiers); not used by the current policy | Ordered failover on 5xx, 429, 401, 403, 404 and timeouts; no memory of failed upstreams; up to one hour waiting for a non-Anthropic upstream to start responding; 256 concurrent upstream requests per replica | https://learn.microsoft.com/en-us/azure/api-management/backends ; https://code.claude.com/docs/en/claude-apps-gateway-config#multiple-upstreams |
| Network exposure | Public endpoint today; Basic v2 has no inbound private endpoint; Standard v2 adds one; Premium v2 adds VNet injection | Private only: Claude Code refuses a gateway hostname with any public address; remote developers need VPN or equivalent | https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts ; https://code.claude.com/docs/en/claude-apps-gateway#prerequisites |
| Identity providers | Entra ID as built | One OIDC issuer per gateway; no SAML; confidential client with a client secret (U-1) | https://code.claude.com/docs/en/claude-apps-gateway-config#oidc ; https://code.claude.com/docs/en/claude-apps-gateway#availability-and-limitations |
| Revocation | Entra token lifetime plus the next allowlist sync | Session ends within `ttl_hours` after the IdP disables the user; no per-session revocation; rotating the JWT secret ends every session | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:16-19](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L16-L19) ; [claude-code-foundry-gateway@f237fb9:infra/policy.xml:53-65](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L53-L65) ; https://code.claude.com/docs/en/claude-apps-gateway-deploy#jwt-secret-rotation |
| Non-Claude models | One AI gateway for Azure OpenAI and other providers | Claude models only | https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities ; https://code.claude.com/docs/en/gateways#other-gateways |
| Platform list price (East US, 730 h) | Basic v2 $0.20548/h ≈ $150/month, public only; Standard v2 $0.9589/h ≈ $700/month; Premium v2 $3.83562/h ≈ $2,800/month; Developer $0.0658/h ≈ $48/month, no SLA, and Anthropic support in the LLM policies is v2-only | No licence fee. PostgreSQL B1ms $0.017/h ≈ $12.41/month plus 32 GiB ≈ $3.68; one always-active 0.5 vCPU / 1 GiB Container Apps replica ≈ $39/month before the free grant; plus load balancer and egress IP | https://azure.microsoft.com/en-us/pricing/details/api-management/ ; https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy ; https://azure.microsoft.com/en-us/pricing/details/container-apps/ ; https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/ |
| Release availability | Managed service; no coupling to the Claude Code version | Minimum versions per feature on the gateway and on clients; the public changelog lists 2.1.280, while the npm feed proxy on this machine lists 2.1.273 as `latest` (U-5) | https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md ; https://code.claude.com/docs/en/claude-apps-gateway-config#static-headers-on-upstream-requests |
| Route bypass | Anyone in the APIM allowlists can use route A; key auth is disabled on every Foundry account | The gateway does not enforce a single route; a machine with `CLAUDE_CODE_USE_FOUNDRY=1` skips the gateway sign-in (U-16) and reaches APIM or Foundry if they admit the user; P-12 closes both for migrated users | [claude-code-foundry-gateway@f237fb9:infra/policy.xml:53-65](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L53-L65) ; https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url ; https://code.claude.com/docs/en/claude-apps-gateway-deploy#deployment |
| Store outage | Counters live in the managed APIM service; no external store | PostgreSQL outage blocks new sign-ins; spend enforcement fails open by default and fails closed with `enforcement.fail_closed_on_error: true` | https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy ; https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#postgres-availability |
| Personal data held | UPN and object ID as metric dimensions in workspace-based Application Insights. On `log-claude-gw-fzgql9` the workspace default is 30 days but `AppMetrics` keeps 90, and the access mode lets resource readers query through resource context (`enableLogAccessUsingOnlyResourcePermissions: true`); Reader and Monitoring Reader can query tables at the default protection level (U-28, U-30) | `principal_emails` holds email, display name and groups, 90 days after last activity by default; OTLP exports carry `user.email` and `user.groups`; logs and traces can carry commands and file paths; P-9 and P-10 limit reads of the gateway's workspace to a named group and its retention to 30 days (T-35, T-39, T-40) | `az monitor log-analytics workspace list` and `az monitor log-analytics workspace table show --name AppMetrics`, 2026-09-23 ; [claude-code-foundry-gateway@f237fb9:infra/policy.xml:129-135](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/policy.xml#L129-L135) ; [claude-code-foundry-gateway@f237fb9:infra/main.bicep:87-111](https://github.com/naveenneog/claude-code-foundry-gateway/blob/f237fb98c23e285fac939af8ca5bfbc886d53c23/infra/main.bicep#L87-L111) ; https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure ; https://learn.microsoft.com/en-us/azure/azure-monitor/logs/manage-access ; https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#data-lifecycle ; https://code.claude.com/docs/en/claude-apps-gateway-config#telemetry |

Monthly figures are hourly list prices multiplied by 730 hours, or per-second prices multiplied by
the seconds in 30 days; they are arithmetic, not quoted prices. Container Apps sizing is assumed and
measured in P-10.

## Pros and cons of route B against route A

Advantages of the Claude apps gateway:

- SSO sign-in through `/login`; developer machines hold no Azure credential (rows "Developer sign-in", "Credential on the developer machine").
- Membership read from the token; no allowlist sync job (row "Membership source and lag").
- Model allowlists enforced by the gateway and shown in the picker (row "Model access").
- Managed settings chosen per IdP group at sign-in; route A2 reaches the same settings per device group through a file or MDM, without the IdP link (row "Client policy delivery").
- USD spend caps with in-client warnings and an explicit over-limit message (rows "Budgets", "Over-limit response").
- Identity-stamped client telemetry, with logs and traces available per destination (row "Usage telemetry").
- Header and body forwarding maintained by Anthropic per release (row "Protocol upkeep").
- One sign-in and policy model for Claude Desktop (row "Claude Desktop").
- Lower list price than the APIM v2 tiers that offer a private endpoint; the classic Developer tier has private networking at a lower price but no SLA, and the LLM policies support Anthropic traffic only on v2 tiers (row "Platform list price").

Disadvantages of the Claude apps gateway:

- A self-hosted service: Linux container, PostgreSQL, TLS, private DNS, version pinning and patching (row "Operating model").
- Private network only; remote developers need VPN or equivalent (row "Network exposure").
- Fewer Claude Code features on gateway sessions: no WebSearch, no 1-hour cache TTL, no Remote Control (row "Claude Code features").
- No CI path (row "CI and unattended jobs").
- No per-user tokens-per-minute or request-rate limit on inference (row "Inference rate limits").
- No circuit breaker; a hung Foundry upstream can hold a request up to one hour (row "Upstream resilience").
- Entra constraints: client secret, object-ID groups, claim omitted beyond 200 groups, P1 or P2 for group-based assignment (rows "Identity providers", "Membership source and lag").
- A PostgreSQL outage stops inference once spend caps fail closed, or leaves spend unmetered if they fail open (row "Store outage").
- More personal data in more places: a PostgreSQL identity table and identity-stamped telemetry (row "Personal data held").
- Client-originated telemetry without retry, and estimated spend (rows "Usage telemetry", "Cost attribution").
- Claude models only (row "Non-Claude models").
- Version coupling: gateway and client features each need a minimum Claude Code version, and the internal npm feed on this machine trails the public release (row "Release availability").

## Decision

Proposed: route A stays in production and remains the CI route. Route A2 is measured in P-17, route B
is piloted through P-2 to P-14, and route C is tested in P-15. P-16 chooses A2, B, C or none by the
criteria below.

The deciding reason for a pilot rather than a switch: facts that gate routes B and C in this
environment are unverified — a client-secret app registration and Entra licensing in the tenant (U-1,
U-24), private connectivity for every pilot developer (U-14), and gateway sign-in from the VS Code
extension (U-21).

### Design decisions inside the pilot (proposed)

| Decision | Reason | Test |
|---|---|---|
| Spend enforcement fails closed from P-8, and readiness uses `/healthz`, so a store outage returns 429 "spend limit unavailable" | Route B has no other per-user inference limit, so the caps are the only per-user spend control | T-18 |
| Migrated users receive a gateway group or app role first, a gateway request is checked, and only then are they removed from the APIM allowlist groups; the gateway never authorises on the APIM groups | Removing a user from a group both routes share would end gateway access as well; a provider variable skips the gateway sign-in, so APIM must refuse migrated users (U-16) | T-20, T-27, T-38 |
| `parentSettingsBehavior: "merge"` arrives only with the five `allowManaged*Only` locks, in P-14 | Merge lets a host process add allow rules and sandbox allowlists unless the locks are set | T-30 |
| Route C uses a separate APIM API with an API-scoped key, an IP filter, quotas keyed on the forwarded subject, and APIM as the gateway's only upstream | The `claude` API accepts only Entra tokens, and failover on 403 would bypass APIM's daily quota | T-24, T-28, T-29 |
| Telemetry destinations take metrics only; `admin.identity_retention_days` is 30; the log workspace requires workspace permissions, runs in DataActionsOnly mode, grants data read only to a named group and purges at 30 days, with each 90-day-default Application Insights table set to 30 days; PostgreSQL backups keep 7 days, which bounds erasure | Logs and traces can carry commands and file paths; `principal_emails`, the audit stream and backups hold personal data; Reader and Monitoring Reader can query tables at the default protection level (U-28); Application Insights tables keep 90 days unless set (U-30) | T-31, T-32, T-35, T-36, T-37, T-39, T-40, T-41 |

### Criteria for P-16

The owner sets the values marked *proposed* and lists the required capabilities before P-16 runs.
Candidate capabilities: SSO without an Azure credential on the device, USD spend caps, policy per IdP
group, Claude Desktop through the same control point, per-minute token limits, CI through the same
control point.

Hard gates. A route that fails one is rejected:

| Gate | Routes | Threshold | Measured by |
|---|---|---|---|
| Required capabilities | A2, B, C | Every capability on the owner's list is present | PS-1 to PS-11 |
| Sign-in in the target tenant | B, C | T-04 passes | P-3 |
| Private reachability | B, C | T-19 passes on every pilot machine | P-11 |
| Bypass closed | B, C | T-20 and T-27 pass | P-12 |
| Authenticated ingress | C | T-24, T-28 and T-29 pass | P-15 |
| Revocation | A2, B, C | ≤ 1 h from group removal to denial | T-11, PS-2 |
| Latency | B, C | p95 time to first token ≤ route A p95 + 200 ms (*proposed*) | PS-6 |
| Cache economics | B, C | Cache-read share within 10 points of route A (*proposed*) | PS-7 |
| Spend accuracy | B, C | Meter within 5% of Foundry cost for the fixed prompt set (*proposed*) | T-14 |
| Availability | B, C | ≥ 99% of pilot requests succeed, excluding upstream 5xx (*proposed*) | `inference` audit events |
| Platform cost | A2, B, C | ≤ the owner's monthly ceiling at pilot scale, for the full estate: APIM counts for every route while CI uses it | PS-10 |

Tie-break among routes that pass every gate: the smaller operated estate wins, so A2 (APIM only) comes
before B and C (APIM, gateway and PostgreSQL each; C adds one APIM API, not a service). Between B and C,
the lower measured monthly cost wins (PS-10), then the lower p95 time to first token (PS-6).

## Consequences

+ If B or C is accepted, onboarding becomes one managed settings file and `/login`, and group-based
  policy replaces the allowlist sync job.
+ If A2 is accepted, no service is added and the accelerator's policy generator is the delivery path.
− Under B or C, a new service to operate and patch, plus PostgreSQL backups and an erasure procedure
  once spend limits hold personal data (P-8, P-10).
− CI keeps route A, so APIM is not retired while CI uses Claude models.
− DataActionsOnly mode for the log workspace is in preview (U-29), and Application Insights-centric
  alert rules lose access to a workspace in that mode, so gateway alerts are workspace-centric.
− Chargeback moves from APIM KQL to OTLP metrics and the spend API under B, or stays on APIM under A2
  and C (P-16).

## How we'd know this was wrong

- P-2 finds that the tenant blocks client secrets for app registrations: routes B and C are not viable in this tenant.
- A pilot developer cannot reach a private address: route B needs network work outside this plan.
- PS-6 or PS-7 misses its threshold: the gateway costs more than it returns.
- PS-11 shows endpoint-managed settings cover every required setting and target: A2 meets the need without a second service.
- A Claude Code release changes the gateway protocol so a pinned gateway breaks newer clients; the docs state that breaking changes are announced in advance.
- APIM gains managed-settings delivery, or Claude Code gains an SSO sign-in for Foundry: route A closes the gap without a second service.
