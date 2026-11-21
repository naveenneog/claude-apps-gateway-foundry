# ADR-0021: Spend history and gateway upgrades that keep the console's data

- **Status:** Proposed
- **Date:** 2026-11-21
- **Packets:** P-50 (spend history), P-51 (gateway image-only upgrade) · **Unknowns:** U-156 to U-159
- **Deciders:** owner (2026-11-21: asked whether past spend can be added from the gateway's spend table, and that a
  new Anthropic gateway image not break the console's data; "always prefer managed postgres design only"), agent

## Context
The console's Chargeback page reads only `GET /v1/organizations/spend_limits/effective`, which returns the period in
progress, so it states that past periods are unavailable (U-89). Chargeback tags live in our own schema in the same
database (ADR-0015). The owner asked whether past spend exists and whether a new Anthropic gateway image can break the
console's data.

Facts measured on the Contoso managed PostgreSQL (16.15), read-only, 2026-11-21:

| Fact | Source |
|---|---|
| The gateway's `public.spend(principal, period, cents, updated_at)` keeps one row per principal per day (`YYYY-MM-DD`), ISO week (`YYYY-Www`) and month (`YYYY-MM`), including past periods: 18 rows from 2026-10-25 for the one test user. It has no model, token or surface column. | Live query, `pg-discovery-2.json` in the session folder (U-156) |
| Anthropic documents `spend` as per-principal period-to-date counters kept `admin.spend_retention_months` (default 13), and documents the admin API, not the table, as the interface. | [Spend limits, Data lifecycle](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits), read 2026-11-21 |
| The gateway's own tables are `public._migrations`, `admin_audit`, `kv`, `principal_emails`, `spend`, `spend_limits`; ours is `admin_console.user_tags`. | Same query |
| Upgrading the Contoso gateway image from Claude Code 2.1.280 to 2.1.311 by swapping only the container image left the table list, the migration versions (1 to 6), the `spend` columns and the content hashes of `user_tags`, past `spend` rows, `spend_limits`, `admin_audit` and `principal_emails` unchanged. Inference, `/user/bootstrap`, `/effective`, caps and `/audit` answered 200 afterwards. | Rehearsal 2026-11-21, revisions `ca-claude-gw--0000026` → `--0000027`; `upgrade-snapshot-before/after.json`, `upgrade-live-checks.json` (U-157) |
| Until that rehearsal the Contoso gateway had never changed image: every revision since 2026-10-18 ran the 2.1.280 image, although the repository pins 2.1.311. The installer's only upgrade path is the full `app` stage. | `az containerapp revision list`, `az acr manifest list-metadata`, 2026-11-21 (U-158) |
| The managed server keeps 35 days of point-in-time restore. | `az postgres flexible-server show`, `backup.backupRetentionDays` |

## Options considered
1. **Read past periods from `public.spend` directly.** Up to 13 months already exist. The table is not a documented
   interface: an Anthropic release can rename it, change the period keys or the units.
2. **Snapshot `/effective` daily into our own schema.** Uses the documented API only; no backfill.
3. **Both: daily snapshot as the record, a one-time guarded backfill from `public.spend`** (proposed). The backfill
   runs only when the table matches the contract measured here, and writes into our schema, so later reports never
   depend on the gateway's table.
4. **Per-model history from relayed telemetry (ADR-0013, P-42).** Needed for per-model views; complementary, larger.

## Decision (proposed)
- **History store.** `admin_console.spend_daily(day date, principal text, period_key text, cents numeric, source text,
  captured_at timestamptz)`, keyed on `(principal, period_key)`, in our schema. Managed PostgreSQL only.
- **Daily snapshot.** The existing `job-spend-pacer` image runs a second job each day after 00:10 UTC that pages
  `/effective` for `daily`, `weekly` and `monthly` and upserts yesterday's closed periods. Documented API only.
- **Guarded backfill.** A one-time command reads `public.spend` only if a contract check passes: the columns are
  exactly `principal text, period text, cents double precision, updated_at timestamptz`, and every period matches
  `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM`. Otherwise it writes nothing and names the mismatch. Rows are marked
  `source = 'gateway-table'`.
- **Chargeback** reads past periods from `spend_daily`; the current period stays `/effective`. Still the gateway's
  list-price estimate, still no per-model split.
- **Gateway image-only upgrade (P-51).** A script analogous to `Update-AdminUi.ps1`: build the pinned version, print the
  rollback image, snapshot the hashes above, swap only the `gateway` container image, wait for a Healthy revision,
  snapshot again and compare, run inference and bootstrap, update the installer's state file so a later `app` stage
  does not roll the image back, and fail with the rollback command if any check differs. Our schema is never touched
  by the gateway's migrations (U-127, U-157); the script detects a new migration version and reports it.

## Consequences
+ Past periods become reportable, from 2026-10-25 on Contoso, without relying on the gateway's table after backfill.
+ Each Anthropic release is upgraded the same way, with a data comparison and a rollback, instead of a full redeploy.
- The backfill depends once on an undocumented table; the contract check limits that to a refusal, not wrong data.
- History has no model split until P-42.

## How we'd know this was wrong
- A later gateway release adds a migration that alters `admin_console` or renames `spend` (U-159): the upgrade script's
  comparison fails before the old revision is retired.
- `/effective` snapshots and `public.spend` disagree for the same closed day by more than rounding.

## Amendment — 2026-11-21: P-51 built
- `scripts/admin/upgrade-gateway.mjs` with the pure logic in `scripts/admin/gateway-upgrade.mjs` (T-182). The gateway's
  own data (caps, audit events, monthly spend) is compared through the documented admin API, not by SQL on its tables,
  so a release that legitimately changes its internal schema does not cause a false rollback. Only our `admin_console`
  schema is read by SQL, in a `BEGIN READ ONLY` transaction, together with the gateway's table list, `_migrations`
  versions and the `public.spend` contract of U-156; a new gateway migration or table is reported as a note, a missing
  one is a failure.
- Any failure after the swap (revision not ready, a compared item that changed, a failed check, another app setting
  that changed) swaps the previous image back automatically; `--no-rollback` only prints the command. Managed
  PostgreSQL only: a gateway on the in-app database is refused.
- Live on Contoso, 2026-11-21: a `--build` upgrade to `claude-gateway:2.1.311-202611211600`
  (`sha256:f5f55c6b…4b48`) kept every compared item and recorded the image in the installer state; a non-gateway image
  produced an `ActivationFailed` revision (`--0000029`) and was rolled back to a Healthy revision (`--0000030`) with
  the installer state unchanged (docs/TEST-PLAN.md, T-182). U-159 is ASSUMED with this script as its detector.

## Amendment — 2026-11-21: P-50 built, design changed from the proposal
The proposal's separate daily job and one-time backfill were replaced, for three reasons: a second job needs a Bicep
redeploy on a customer's deployment, a one-time command has to be remembered, and a daily snapshot after 00:10 UTC
loses the last minutes of a day if the job misses that run.
- **Table.** `admin_console.spend_history`, keyed on `(principal, period_key)`, with `period`, `cents`, `source`
  (`effective` or `gateway-table`), e-mail, name, groups and both timestamps (admin-ui/server/spend-history.mjs:11).
  Our schema only; created with `IF NOT EXISTS`, never altered or dropped by a later run.
- **Runs inside `job-spend-pacer`** (every 5 minutes, same image and identity as admin-ui), independently of pacing:
  either failing still runs the other and fails the job run (admin-ui/server/pacer-job.mjs:104).
- **Capture from `/effective`.** The larger value wins, because a period-to-date total only grows, and a period that
  rolled over while `/effective` was being read is skipped, so a new period never gets the previous one's total
  (admin-ui/server/spend-history.mjs:34).
- **Copy from `public.spend`.** Incremental from the last copied `updated_at` minus one hour, on every run, only while
  the table matches the contract of U-156; e-mail, name and groups are joined from `public.principal_emails` only while
  that table matches its own contract (admin-ui/server/spend-history.mjs:55). A mismatch copies nothing, is logged with
  the reason, and history from `/effective` continues.
- **Chargeback.** No key or the current key reads `/effective`; a closed key reads `spend_history`; a later key is
  refused (admin-ui/server/chargeback.mjs:45). `GET /api/chargeback/periods` lists the closed keys. On the in-app
  database the list is empty with the reason.
- Tests T-184 and T-185.
