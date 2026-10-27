# ADR-0014: Soft limit at a share of the monthly cap, then pace the rest per day

- **Status:** Proposed
- **Date:** 2026-10-27
- **Packet:** P-43 · **Unknowns:** U-120 to U-124
- **Deciders:** owner (request of 2026-10-27: "once 80 percent usage is done user will be throttled and also notified so
  usage doesn't cross the limit"), agent

## Context
The owner's other gateway (claude-code-on-foundry, its ADR-0035) adds a soft limit: past a set share of a person's monthly
budget the person is warned, and the rest of the budget is paced so it cannot all be spent at once. It was needed there
because that gateway's budget check read a log ledger about nine minutes behind real spend.

This gateway's situation, checked on 2026-10-27:

| Fact | Source |
|---|---|
| The gateway checks a developer's caps and period-to-date spend in PostgreSQL before every `/v1/messages` request and adds each response's cost to the daily, weekly and monthly counters after it. A developer over any cap gets `429` with the period and reset time, followed by `admin.blocked_message`. There is no lag of minutes as in the other gateway. | [Spend limits, How enforcement works](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-enforcement-works) |
| Nothing is reserved when a request starts, so requests already admitted when a cap is reached still finish and are metered: spend can pass a cap by the cost of the requests in flight at that moment. | Same page: a pre-check before the request, the meter after the response |
| The gateway has no per-user request or token rate limit; `rate_limits` covers sign-in per IP address only. Caps are daily, weekly or monthly, and a developer is blocked when over any of them. A per-user cap overrides the role and organization caps of that period. | [gateway configuration](https://code.claude.com/docs/en/claude-apps-gateway-config), HTTP tuning; [Spend limits, Set a cap](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#set-a-cap) |
| Claude Code warns a developer past 75% and again past 95% of their most-consumed cap, shows the cap in `/usage` and the status line, and shows the gateway's `429` message as it is. | [Spend limits, Usage warnings in Claude Code](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#usage-warnings-in-claude-code) |
| Every cap change is written to `/audit` with the actor `admin-key:<id>` of the key that made it. `write_keys` takes several named keys. | [Spend limits, Admin API reference](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#admin-api-reference); [gateway configuration, `admin`](https://code.claude.com/docs/en/claude-apps-gateway-config#admin) |

So, for accuracy: the gateway's count is already exact to the request, and the soft limit does not make it more exact.
What it changes is how fast the last part of a budget can go. Past the soft limit, a person can spend at most one day's
share before the gateway stops them for the day, instead of the whole remainder in one afternoon. The overshoot at the
monthly cap stays what it is today: the requests in flight when the cap is reached.

## Options considered
1. **Lower the monthly cap to 80%.** Simple and exact, but the person loses a fifth of the budget they were given, and
   the overshoot at the lower cap is the same.
2. **Soft limit with a per-day pace, set as a per-user daily cap by a scheduled job (chosen).** Uses only the gateway's
   own caps, so the gateway enforces it on every request; Claude Code's own warnings and `429` message notify the person.
3. **A per-user token or request rate limit at the gateway.** The gateway has none, and adding a proxy in front of it
   would put new code on every request.
4. **E-mail or Teams messages at the soft limit.** Needs a mail permission (`Mail.Send` covers every mailbox unless an
   Exchange application access policy narrows it) or a new resource. Left for later; the client already warns.

## Decision
Option 2.

- **Setting.** The admin file gains `spendPacing: { "softLimitPercent": 80 }` (a whole number from 1 to 99). It needs
  `deployment.adminApi`. Without `spendPacing`, nothing is paced. The console sets it on **Access & models** > **Soft limit**, through the same reviewed save as every other edit, so a gateway whose console has saved its configuration can turn it on.
- **Rule**, for each person with a monthly cap, every five minutes, in whole cents and UTC days:
  - Past the soft limit (monthly spend ≥ cap × percent ÷ 100): daily cap = ⌊(monthly cap − spend before today) ÷ days left
    in the month, today included⌋, or the person's role or organization daily cap if that is lower, in which case no
    cap is set. The amount stays the same all day and is recomputed each day.
  - Below the soft limit, or with pacing off: the job deletes the daily cap it set.
  - A per-user daily cap that an administrator set is never changed or deleted; the person is reported as not paced.
- **Ownership.** The job writes with its own key, `spend-pacer`, so `/audit` shows it as the actor. A user daily cap is
  the job's while the newest audit event for it names `admin-key:spend-pacer`. An administrator who edits that cap
  takes it over, and the job leaves it alone. Deletes use the pacer key, or admin-ui's key when pacing was turned off
  and the gateway no longer accepts the pacer key.
- **Notification.** No new channel. With the daily cap in place Claude Code warns at 75% and 95% of it, and the `429`
  names the daily reset. With pacing on, the rendered `admin.blocked_message` says that past the soft limit the rest of
  the monthly budget is spread over the remaining days. The console's Audit page lists each pace as
  `spend-pacer (admin key)`.
- **Where it runs.** A Container Apps job, `job-spend-pacer`, in the gateway's environment, every five minutes, from
  the admin-ui image and identity (`node server/pacer-job.mjs`). It reads the admin file and both keys from the gateway
  app's secrets with the Container Apps Contributor role admin-ui already holds, so no key is passed at deploy time.
- **Key.** Both installers create the secret `admin-pacer-key` (`GATEWAY_ADMIN_PACER_KEY`) whenever `adminApi` is on,
  and keep its value on later runs. The renderer lists it in `admin.write_keys` only with `spendPacing`. The console
  refuses to turn pacing on for a gateway that lacks the variable, since the gateway would not start.

## Consequences
+ The gateway enforces the pace on every request, as it does every other cap.
+ No new Azure resource besides the job; at 0.25 vCPU and 0.5 GiB for about 10 seconds every 5 minutes it is about
  16,000 vCPU-seconds a month, about $0.50 at list price or nothing within the monthly free grant.
- A person can pass the soft limit and keep spending for up to five minutes before the pace is set.
- The overshoot at a cap stays the cost of the requests in flight when it is reached (U-124).
- A person with an administrator-set daily cap is not paced. The gateway's create-or-replace has no condition, so the job lists the per-user caps again just before writing and skips anyone whose daily cap changed since it planned (council, Coder seat); a cap set in the milliseconds between that read and the write can still be replaced.
- Two more installer secrets and a scheduled job to keep healthy; the job logs one summary line a run, with no names or
  addresses.

## How we'd know this was wrong
- A paced person's spend passes the monthly cap by more than one burst of parallel requests (T-139).
- The job's caps are not attributed to `admin-key:spend-pacer` (U-121), or a role or organization daily cap stops
  applying to a paced person (U-120).
- Developers report being stopped for the day without having seen a warning (U-123).

## Live test (2026-10-27, Contoso test gateway, managed database)

| Step | Result |
|---|---|
| Job deployed from the `pacerJob` resource, gateway given `admin-pacer-key` | Executions ended Succeeded; with pacing off each logged `{"evt":"spend_pacer.run","percent":null,...,"errors":0}` (U-122) |
| Soft limit 50% saved through admin-ui's configuration store | Revision `ca-claude-gw--0000016` started healthy with the `spend-pacer` key in `admin.write_keys` |
| Test user: monthly cap 120 cents, 81.009 spent, 4.877 today, 5 days left | The job set a daily cap of 8 cents, actor `admin-key:spend-pacer` (U-121); the monthly cap stayed 120 (U-120) |
| Bursts of four parallel requests | Two bursts answered 200; the third got four `429`s naming the daily reset, with the pacing message; Claude Code showed the same (U-123). The day ended at 8.105 cents, 0.105 over (U-124) |
| Monthly cap raised to 130 cents | The next run changed the daily cap to 10 cents |
| Soft limit turned off | The next run deleted the job's daily cap with admin-ui's key and left the administrator's monthly cap |

Evidence: docs/TEST-PLAN.md, T-139; `tests/live/pacer-p43.mjs`.
