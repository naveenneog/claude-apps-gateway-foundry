// P-51 (ADR-0021): image-only gateway upgrade with a data comparison and automatic rollback. Pure logic and the
// orchestration; scripts/admin/upgrade-gateway.mjs supplies the Azure, database and HTTP calls.
//
// What is compared, and through what:
// - The gateway's own data (spend caps, audit trail, period spend) through its documented admin API, so a release that
//   legitimately changes its internal tables does not cause a false rollback
//   (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits, Admin API reference).
// - Our own admin_console schema (chargeback tags, ADR-0015) by SQL, read-only: no gateway release may change it.
// - The gateway's table list and migration versions, reported so each release's schema change is seen (U-159).
// - The undocumented public.spend columns the P-50 backfill relies on: a change is reported, not a failure, because
//   the backfill refuses on its own.
import crypto from 'node:crypto';

const GATEWAY_IMAGE = /^([a-z0-9-]+\.azurecr\.(?:io|us|cn))\/claude-gateway@sha256:[a-f0-9]{64}$/;
const IDENT = /^[a-z_][a-z0-9_]*$/;
export const AUDIT_PAGE = 100;
const SPEND_CONTRACT = [['principal', 'text'], ['period', 'text'], ['cents', 'double precision'], ['updated_at', 'timestamp with time zone']];

const pad = (n) => String(n).padStart(2, '0');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** The gateway's current UTC period keys: day YYYY-MM-DD, ISO week YYYY-Www, month YYYY-MM. */
export function periodKeys(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((thursday - jan4) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { day, week: `${isoYear}-W${pad(week)}`, month: day.slice(0, 7) };
}

// Container App settings that an image-only update must not change. Azure adds exact defaults to a new revision and
// returns secret-backed variables with a redacted value, so those are normalized (as in admin-ui/infra/Update-AdminUi.ps1).
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export function appSettings(app) {
  const template = structuredClone(app.properties?.template ?? {});
  for (const c of template.containers ?? []) {
    delete c.image;
    if (c.imageType === 'ContainerImage') delete c.imageType;
    if (c.resources?.ephemeralStorage === '1Gi') { delete c.resources.ephemeralStorage; if (!Object.keys(c.resources).length) delete c.resources; }
    for (const e of c.env ?? []) if (e.secretRef) delete e.value;
  }
  if (template.revisionSuffix === '') delete template.revisionSuffix;
  if (template.scale?.cooldownPeriod === 300) delete template.scale.cooldownPeriod;
  if (template.scale?.pollingInterval === 30) delete template.scale.pollingInterval;
  return JSON.stringify(canonical({ identity: app.identity ?? null, configuration: app.properties?.configuration ?? null, template,
    location: app.location ?? null, tags: app.tags ?? null, workloadProfileName: app.properties?.workloadProfileName ?? null }));
}

/** The running gateway image and any reason the target cannot replace it. */
export function checkTarget(app, image) {
  const errors = [];
  const gateways = (app.properties?.template?.containers ?? []).filter((c) => c.name === 'gateway');
  if (gateways.length !== 1) errors.push('the app must have exactly one container named gateway');
  const previous = gateways[0]?.image ?? null;
  const m = GATEWAY_IMAGE.exec(image ?? '');
  if (!m) errors.push(`the target must be a claude-gateway image pinned by digest (registry/claude-gateway@sha256:<64 hex>), not ${JSON.stringify(image)}`);
  else if (previous && previous.split('/')[0] !== m[1]) errors.push(`the target must come from the same registry as the running image (${previous.split('/')[0]})`);
  return { previous, errors };
}

/** Read-only snapshot of the database: table list, gateway migrations, our schema's content, the spend contract. */
export async function dbSnapshot(db) {
  await db.query('BEGIN READ ONLY');
  try {
    const rows = async (sql, params) => (await db.query(sql, params)).rows;
    const tables = (await rows("SELECT table_schema||'.'||table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1")).map((r) => r.t);
    const migrations = tables.includes('public._migrations')
      ? (await rows('SELECT version::text AS version FROM public._migrations')).map((r) => String(r.version)).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
      : [];
    const ours = {};
    for (const t of tables.filter((x) => x.startsWith('admin_console.'))) {
      const name = t.slice('admin_console.'.length);
      if (!IDENT.test(name)) throw new Error(`refusing an unexpected table name ${JSON.stringify(t)}`);
      const content = (await rows(`SELECT * FROM admin_console.${name}`)).map((r) => JSON.stringify(canonical(r))).sort();
      ours[t] = { count: content.length, hash: hash(content) };
    }
    let spendContract = 'public.spend is missing';
    if (tables.includes('public.spend')) {
      const cols = (await rows("SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema='public' AND table_name='spend' ORDER BY ordinal_position")).map((r) => [r.c, r.t]);
      const diff = SPEND_CONTRACT.find(([c, t], i) => cols[i]?.[0] !== c || cols[i]?.[1] !== t);
      if (diff) {
        const i = SPEND_CONTRACT.indexOf(diff);
        spendContract = cols[i] ? `column ${cols[i][0]} is ${cols[i][1]}, expected ${diff[1]}` : `column ${diff[0]} is missing`;
      } else if (cols.length !== SPEND_CONTRACT.length) spendContract = `public.spend has ${cols.length} columns, expected ${SPEND_CONTRACT.length}`;
      else {
        const odd = Number((await rows(String.raw`SELECT count(*) AS n FROM public.spend WHERE period !~ '^\d{4}-(\d{2}-\d{2}|W\d{2}|\d{2})$'`))[0]?.n ?? 0);
        spendContract = odd ? `${odd} spend periods match no known period format` : 'ok';
      }
    }
    return { tables, migrations, ours, spendContract };
  } finally {
    await db.query('ROLLBACK');
  }
}

/** The admin API's view: caps (order-free hash), newest audit events, and each principal's monthly spend. */
export function summarizeApi({ caps = [], audit = [], effective = [] }) {
  const capRows = caps.map((c) => JSON.stringify(canonical({ id: c.id, scope: c.scope, amount: c.amount, period: c.period }))).sort();
  const ids = audit.map((e) => Number(e.id)).filter(Number.isFinite);
  const monthly = {};
  for (const r of effective) if (r.period === 'monthly' && r.scope?.type === 'user') monthly[r.scope.user_id] = Number(r.period_to_date_spend ?? 0);
  return { caps: { count: capRows.length, hash: hash(capRows) }, auditIds: ids, auditNewest: ids.length ? Math.max(...ids) : null, monthly };
}

/** Failures stop and roll back; notes are reported. */
export function compareSnapshots(before, after) {
  const failures = [];
  const notes = [];
  const b = before.db ?? {};
  const a = after.db ?? {};
  for (const t of b.tables ?? []) if (!(a.tables ?? []).includes(t)) (t.startsWith('admin_console.') ? failures : notes).push(t.startsWith('admin_console.') ? `${t} is missing` : `gateway table ${t} was removed`);
  for (const t of a.tables ?? []) if (!(b.tables ?? []).includes(t)) (t.startsWith('admin_console.') ? failures : notes).push(t.startsWith('admin_console.') ? `${t} appeared during the gateway upgrade` : `new gateway table ${t}`);
  for (const [t, v] of Object.entries(b.ours ?? {})) {
    const w = a.ours?.[t];
    if (!w) { if (!failures.includes(`${t} is missing`)) failures.push(`${t} is missing`); } else if (w.count !== v.count || w.hash !== v.hash) failures.push(`${t} changed (${v.count} rows before, ${w.count} after)`);
  }
  for (const v of b.migrations ?? []) if (!(a.migrations ?? []).includes(v)) failures.push(`gateway migration ${v} is missing`);
  for (const v of a.migrations ?? []) if (!(b.migrations ?? []).includes(v)) notes.push(`new gateway migration ${v}: review the release for changes to the tables the console relies on (U-159)`);
  if (a.spendContract && a.spendContract !== 'ok' && a.spendContract !== b.spendContract) notes.push(`spend table contract changed: ${a.spendContract}; the P-50 backfill will refuse`);
  if (before.api) {
    if (!after.api) failures.push('the admin API did not answer after the upgrade');
    else {
      const newer = after.api.auditIds.filter((id) => before.api.auditNewest === null || id > before.api.auditNewest);
      if (after.api.caps.hash !== before.api.caps.hash) {
        if (newer.length) notes.push(`spend caps changed by audit event ${newer.join(', ')} during the upgrade`);
        else failures.push('spend caps changed with no audit event');
      }
      const truncated = after.api.auditIds.length >= AUDIT_PAGE && Math.min(...after.api.auditIds) > (before.api.auditNewest ?? 0);
      if (before.api.auditNewest !== null && !after.api.auditIds.includes(before.api.auditNewest) && !truncated) failures.push(`audit event ${before.api.auditNewest} is missing`);
      if (before.periods?.month === after.periods?.month) {
        for (const [u, cents] of Object.entries(before.api.monthly)) {
          if (!(u in after.api.monthly)) failures.push(`${u} is missing from the monthly spend`);
          else if (after.api.monthly[u] < cents) failures.push(`${u}'s monthly spend fell from ${cents} to ${after.api.monthly[u]}`);
        }
      } else notes.push(`the month changed during the upgrade (${before.periods?.month} to ${after.periods?.month}); monthly spend not compared`);
    }
  }
  const bc = before.checks ?? {};
  const ac = after.checks ?? {};
  for (const k of ['health', 'inference', 'bootstrap']) if (bc[k] !== undefined && ac[k] !== 200) failures.push(`${k} answered ${ac[k]}`);
  if (bc.connectors && JSON.stringify([...(ac.connectors ?? [])].sort()) !== JSON.stringify([...bc.connectors].sort())) failures.push(`bootstrap connectors changed: ${JSON.stringify(bc.connectors)} to ${JSON.stringify(ac.connectors)}`);
  if (bc.marketplaces !== undefined && ac.marketplaces !== bc.marketplaces) failures.push(`bootstrap marketplaces changed: ${bc.marketplaces} to ${ac.marketplaces}`);
  return { failures, notes };
}

const baselineFailures = (s) => ['health', 'inference', 'bootstrap'].filter((k) => s.checks?.[k] !== undefined && s.checks[k] !== 200).map((k) => `${k} answered ${s.checks[k]}`);

/**
 * io: readApp(), snapshot(phase) -> {periods, db, api?, checks}, swapImage(image), waitReady(previousRevision) ->
 * {ok, revision?, reason?}, saveState(image), log(message). Returns {status, failures, notes, rollback}.
 */
export async function runUpgrade({ io, image, plan = false, noRollback = false, resourceGroup = '<resource-group>', appName = 'ca-claude-gw' }) {
  const appBefore = io.readApp();
  const { previous, errors } = checkTarget(appBefore, image);
  if (errors.length) return { status: 'stopped', failures: errors, notes: [] };
  const rollback = `az containerapp update -g ${resourceGroup} -n ${appName} --container-name gateway --image ${previous}`;
  io.log(`running: ${previous}`);
  io.log(`target:  ${image}`);
  io.log(`rollback: ${rollback}`);
  if (image === previous) return { status: 'unchanged', failures: [], notes: [], rollback };
  let before;
  try { before = await io.snapshot('before'); } catch (e) {
    return { status: 'stopped', failures: [`the snapshot before the upgrade failed, nothing was changed: ${e.message}`], notes: [], rollback };
  }
  const baseline = baselineFailures(before);
  if (baseline.length) return { status: 'stopped', failures: baseline.map((f) => `before the upgrade, ${f}; nothing was changed`), notes: [], rollback };
  if (plan) return { status: 'plan', failures: [], notes: [], rollback, before };

  const previousRevision = appBefore.properties.latestReadyRevisionName;
  await io.swapImage(image);
  const failures = [];
  let notes = [];
  const ready = await io.waitReady(previousRevision);
  if (!ready.ok) failures.push(`the new revision did not become ready: ${ready.reason}`);
  else {
    if (appSettings(io.readApp()) !== appSettings(appBefore)) failures.push('container app settings other than the gateway image changed');
    try {
      const after = await io.snapshot('after');
      const cmp = compareSnapshots(before, after);
      failures.push(...cmp.failures);
      notes = cmp.notes;
    } catch (e) { failures.push(`the snapshot after the upgrade failed: ${e.message}`); }
  }
  for (const n of notes) io.log(`note: ${n}`);
  if (!failures.length) {
    io.saveState(image);
    return { status: 'upgraded', failures, notes, rollback, revision: ready.revision };
  }
  for (const f of failures) io.log(`FAILED: ${f}`);
  if (noRollback) return { status: 'failed', failures, notes, rollback };
  if (notes.some((n) => n.startsWith('new gateway migration'))) {
    notes.push('the new image ran a migration; the previous image may not start on the newer schema. The database keeps point-in-time restore.');
  }
  io.log('rolling back to the previous image');
  await io.swapImage(previous);
  const back = await io.waitReady(ready.revision ?? previousRevision);
  if (!back.ok) failures.push(`the rollback revision did not become ready: ${back.reason}; run: ${rollback}`);
  return { status: 'rolled-back', failures, notes, rollback };
}
