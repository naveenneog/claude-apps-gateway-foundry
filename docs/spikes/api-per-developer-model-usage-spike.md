---
title: "Per-developer, per-model daily usage and cost through an API"
category: "API Integration"
status: "🟡 In Progress"
priority: "High"
timebox: "3 days"
created: 2026-11-21
updated: 2026-11-21
owner: "naveenneog"
tags: ["technical-spike", "api-integration", "research", "P-42"]
---

# Per-developer, per-model daily usage and cost through an API

## Summary

**Spike objective:** decide which data source gives each developer's daily usage and cost per model, accurately
enough to serve through an API, on the Claude apps gateway with Microsoft Foundry.

**Why it matters:** a customer requires "per-teammate, per-model usage and cost, daily, through an API" before moving
Claude Code to Foundry. Today the console has per-developer totals per day, week and month (`/effective` and, since
P-50, `admin_console.spend_history`), but no model split. P-42 (ADR-0013, Proposed) plans the split from relayed client
telemetry and is blocked by U-112 to U-119.

**Timebox:** 3 days. **Decision deadline:** before P-42 is planned in detail.

## Research questions

**Primary:** can client telemetry split each developer's daily gateway spend by model, and with what error?

**Secondary:**

- Which attributes identify the developer and the model in relayed telemetry, and do they match `/effective`'s
  `scope.user_id` (U-118)?
- Does the gateway record anything per request, server side, with the model?
- What does the API return when telemetry is missing for some of a developer's spend?

## Investigation plan

### Research tasks

- [x] Read the gateway's telemetry, pricing and audit documentation.
- [x] Check what the Contoso deployment collects today.
- [x] Prototype: one request per allowed model through the Contoso gateway with the CLI's console exporter; compare
  the client's `claude_code.cost.usage` with the gateway's `/effective` daily delta for the same user.
- [ ] Relay telemetry on a test gateway (`telemetry.forward_to` to a loopback receiver) and confirm `user.id`,
  `user.email`, `model` and token types arrive (U-113, U-118).
- [ ] Measure export count per active and idle developer-hour (U-115), and Desktop and Cowork coverage (U-112).
- [ ] Measure daily coverage: the share of each developer's `/effective` daily spend that relayed tokens explain.
- [ ] Record the recommendation in an ADR-0013 amendment.

### Success criteria

- [x] The error of client-reported cost per model is measured against the gateway's meter.
- [ ] Identity attributes are confirmed on relayed exports.
- [ ] Daily coverage is measured over at least one working day of real use.
- [x] A recommendation is written (below), to be confirmed by the remaining tasks.

## Technical context

**Related components:** gateway telemetry relay (`telemetry.forward_to`), gateway `pricing` and `/effective`,
`job-spend-pacer` and `admin_console.spend_history` (ADR-0021), the planned `usage-rollup` sidecar (ADR-0013).

**Dependencies:** P-42; U-112 to U-119.

**Constraints:** managed PostgreSQL only; no new Log Analytics table (P-42 criteria); the gateway does not buffer,
retry or store telemetry.

## Research findings

### Documentation (read 2026-11-21)

| Finding | Source |
|---|---|
| The gateway relays OTLP metrics verbatim and stamps `user.id`, `user.email` and `user.groups` from its own token on terminal sessions; Desktop and Cowork add `enduser.sub`. | [Configuration, telemetry](https://code.claude.com/docs/en/claude-apps-gateway-config#telemetry) |
| The gateway drops an export it cannot deliver; it does not buffer, retry or store telemetry. | Same page, "When a destination fails" |
| `claude_code.cost.usage` (USD) and `claude_code.token.usage` (tokens, by `type`) carry a `model` attribute. | [Monitoring](https://code.claude.com/docs/en/monitoring-usage) |
| The gateway's documented audit events cover sign-in, admin changes, access and `spend.blocked`; none is emitted per inference request with a model. | [Deployment and operations](https://code.claude.com/docs/en/claude-apps-gateway-deploy) |
| A `pricing` override row matches the model string sent upstream, and `pricing` rates can be pushed to clients as `modelPricing`. | [Configuration, pricing](https://code.claude.com/docs/en/claude-apps-gateway-config#pricing) |
| Opus 5 5-minute cache writes are $6.25/MTok; Opus 5.5 are $5/MTok; Sonnet 5 are $2.50/MTok. | [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) |

### Contoso today

The Contoso gateway has no `telemetry.forward_to` and no collector, so no per-model usage is collected. Without the
relay, the CLI's own exports carry an anonymous `user.id` hash and no `user.email` (session file
`spike-console-metrics.txt`, outside the repository).

### Prototype: client cost against the gateway meter (2026-11-21)

Claude Code 2.1.311 (`npx @anthropic-ai/claude-code@2.1.311`, so the installed CLI was not changed), signed in to the
Contoso gateway, one `-p "Reply with the single word: ok"` request per model, `OTEL_METRICS_EXPORTER=console`. The
gateway's `/effective` daily spend for the user was read before and after each request with the admin API.

| Requested ID | Foundry deployment | Tokens (input, output, cache write) | Gateway delta | Client `cost.usage` | Difference |
|---|---|---|---|---|---|
| `claude-sonnet-5` | `claude-sonnet-5` | 2, 4, 30,312 | 7.583¢ | 7.582¢ | 0.01% |
| `claude-opus-5` | `claude-opus-5-5` | 2, 4, 18,929 | 9.473¢ | 11.842¢ | +25% |

The gateway's 9.473¢ is exactly Opus 5.5's list rates (18,929 × $5 + 4 × $20 + 2 × $4 per MTok); the client's 11.842¢
is Opus 5's ($6.25 cache write). On Contoso the ID `claude-opus-5` is served by the `claude-opus-5-5` deployment
(admin file `models`), so the gateway priced what Foundry served, and the client priced the ID it asked for. The
telemetry `model` attribute was `claude-opus-5`, the requested ID.

## Decision

### Recommendation

1. **Money comes from the gateway, not from client cost.** Each developer's daily total stays the gateway's
   (`/effective`, kept by P-50's history). Client `claude_code.cost.usage` is not used: it prices the requested ID,
   which is wrong whenever an ID routes to a different deployment, and it ignores `pricing` overrides unless they are
   pushed to the client.
2. **Model split comes from client tokens.** `claude_code.token.usage` by `model` and `type`, relayed with the
   gateway's identity, rolled up per day, developer and requested ID into the managed database (ADR-0013's
   `usage-rollup`). Each requested ID is priced with the rates of the deployment the gateway's `models` maps it to,
   and the developer's day is scaled to the gateway's total; the remainder the tokens do not explain is reported as
   "not attributed", because the relay drops undeliverable exports.
3. **API:** `GET /api/usage/daily?from=&to=&user=&model=` on admin-ui returning rows of day, developer (object ID,
   e-mail), requested ID, deployment, tokens by type, cost, `attributed` and `not_attributed`; read-only, admin role,
   CSV with the same columns.

### Rationale

The only server-side per-developer meter is the gateway's, and it has no model column. Client telemetry has the model
but not the served model or the gateway's rates. Combining tokens from the client with rates and totals from the
gateway is the only path found that keeps the money equal to the gateway's meter.

### Implementation notes

- The Contoso label "Claude Opus 5" for deployment `claude-opus-5-5` is itself misleading; a model's `id` and `label`
  should name the model the deployment serves.
- Until the relay tasks above are done, coverage is unmeasured; the API shows "not attributed" rather than spreading
  it across models.

### Follow-up actions

- [ ] Run the remaining research tasks on a test gateway with the relay to a loopback receiver.
- [ ] Amend ADR-0013 with recommendations 1 to 3 and the measured coverage.
- [ ] Plan P-42 against the amended ADR.

## Status history

| Date | Status | Notes |
|---|---|---|
| 2026-11-21 | 🔴 Not Started | Spike scoped from the customer's per-model ask and P-42's open unknowns |
| 2026-11-21 | 🟡 In Progress | Documentation read; client cost measured against the gateway meter on Contoso (U-160) |

---

_Last updated: 2026-11-21 by naveenneog (with GitHub Copilot)_
