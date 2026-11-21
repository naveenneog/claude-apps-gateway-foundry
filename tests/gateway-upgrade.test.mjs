// T-182 (P-51, ADR-0021): image-only gateway upgrade with a data comparison and automatic rollback. The gateway's own
// data is compared through its documented admin API; only our admin_console schema is read with SQL, so a release that
// changes the gateway's internal tables does not trigger a false rollback, while one that breaks our data does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { periodKeys, compareSnapshots, appSettings, checkTarget, runUpgrade, dbSnapshot } from '../scripts/admin/gateway-upgrade.mjs';

const OLD = 'cr.azurecr.io/claude-gateway@sha256:' + 'a'.repeat(64);
const NEW = 'cr.azurecr.io/claude-gateway@sha256:' + 'b'.repeat(64);
const app = (image = OLD, extra = {}) => ({
  identity: { type: 'UserAssigned' },
  properties: {
    latestRevisionName: 'r1', latestReadyRevisionName: 'r1', provisioningState: 'Succeeded',
    configuration: { ingress: { external: true }, secrets: [{ name: 'pg-password' }] },
    template: { containers: [{ name: 'gateway', image, env: [{ name: 'A', value: '1' }, { name: 'K', secretRef: 'pg-password' }], ...extra }], scale: { minReplicas: 1 } },
  },
});
const snapshot = (over = {}) => ({
  periods: { day: '2026-11-21', week: '2026-W47', month: '2026-11' },
  db: { tables: ['admin_console.user_tags', 'public._migrations', 'public.spend'], migrations: ['1', '2'], ours: { 'admin_console.user_tags': { count: 1, hash: 'h1' } }, spendContract: 'ok' },
  api: { caps: { count: 1, hash: 'c1' }, auditNewest: 7, auditIds: [7, 6, 5], monthly: { u1: 100 } },
  checks: { inference: 200, bootstrap: 200, connectors: ['M365'], marketplaces: 3 },
  ...over,
});

test('T-182 period keys are the current UTC day, ISO week and month, including ISO-year edges', () => {
  assert.deepEqual(periodKeys(new Date('2026-11-21T10:00:00Z')), { day: '2026-11-21', week: '2026-W47', month: '2026-11' });
  assert.equal(periodKeys(new Date('2026-01-01T00:00:00Z')).week, '2026-W01');
  assert.equal(periodKeys(new Date('2027-01-01T12:00:00Z')).week, '2026-W53');
  assert.equal(periodKeys(new Date('2024-12-30T12:00:00Z')).week, '2025-W01');
});

test('T-182 identical snapshots pass; a new gateway migration or table is a note, not a failure', () => {
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), { failures: [], notes: [] });
  const after = snapshot({ db: { ...snapshot().db, migrations: ['1', '2', '3'], tables: [...snapshot().db.tables, 'public.new_thing'] } });
  const r = compareSnapshots(snapshot(), after);
  assert.deepEqual(r.failures, []);
  assert.match(r.notes.join('\n'), /new gateway migration 3/);
  assert.match(r.notes.join('\n'), /public\.new_thing/);
});

test('T-182 our schema, caps, audit, spend, bootstrap and checks that change are failures', () => {
  const base = snapshot();
  const cases = [
    [{ db: { ...base.db, ours: { 'admin_console.user_tags': { count: 1, hash: 'h2' } } } }, /admin_console\.user_tags changed/],
    [{ db: { ...base.db, ours: {} } }, /admin_console\.user_tags is missing/],
    [{ db: { ...base.db, migrations: ['1'] } }, /migration 2 is missing/],
    [{ api: { ...base.api, caps: { count: 0, hash: 'c0' } } }, /spend caps changed/],
    [{ api: { ...base.api, auditIds: [9, 8], auditNewest: 9 } }, /audit event 7 is missing/],
    [{ api: { ...base.api, monthly: { u1: 40 } } }, /u1's monthly spend fell from 100 to 40/],
    [{ api: { ...base.api, monthly: {} } }, /u1 is missing from the monthly spend/],
    [{ checks: { ...base.checks, inference: 502 } }, /inference answered 502/],
    [{ checks: { ...base.checks, connectors: [] } }, /bootstrap connectors changed/],
    [{ checks: { ...base.checks, marketplaces: 0 } }, /bootstrap marketplaces changed/],
  ];
  for (const [over, message] of cases) {
    const r = compareSnapshots(base, snapshot(over));
    assert.match(r.failures.join('\n'), message, JSON.stringify(over));
  }
});

test('T-182 changes that the comparison explains are notes: admin edits during the upgrade, a new month, the backfill contract', () => {
  const base = snapshot();
  const edited = compareSnapshots(base, snapshot({ api: { ...base.api, caps: { count: 2, hash: 'c2' }, auditIds: [8, 7, 6], auditNewest: 8 } }));
  assert.deepEqual(edited.failures, []);
  assert.match(edited.notes.join('\n'), /caps changed by audit event 8/);
  const newMonth = compareSnapshots(base, snapshot({ periods: { ...base.periods, month: '2026-12' }, api: { ...base.api, monthly: {} } }));
  assert.deepEqual(newMonth.failures, []);
  const contract = compareSnapshots(base, snapshot({ db: { ...base.db, spendContract: 'column cents is numeric, expected double precision' } }));
  assert.deepEqual(contract.failures, []);
  assert.match(contract.notes.join('\n'), /P-50 backfill will refuse/);
});

test('T-182 app settings ignore the image, Azure defaults and redacted secret values, and see real changes', () => {
  const a = appSettings(app(OLD));
  assert.equal(appSettings(app(NEW, { imageType: 'ContainerImage', resources: { ephemeralStorage: '1Gi' } })), a);
  const changed = app(NEW);
  changed.properties.template.containers[0].env[0].value = '2';
  assert.notEqual(appSettings(changed), a);
  const ingress = app(NEW);
  ingress.properties.configuration.ingress.external = false;
  assert.notEqual(appSettings(ingress), a);
});

test('T-182 the target must be a digest of claude-gateway in the running registry, and the app needs one gateway container', () => {
  assert.deepEqual(checkTarget(app(), NEW), { previous: OLD, errors: [] });
  for (const [image, message] of [
    ['other.azurecr.io/claude-gateway@sha256:' + 'b'.repeat(64), /same registry/],
    ['cr.azurecr.io/claude-gateway:2.1.400', /digest/],
    ['cr.azurecr.io/claude-gateway@sha256:' + 'b'.repeat(12), /digest/],
    ['cr.azurecr.io/claude-gateway@sha256:' + 'b'.repeat(65), /digest/],
    ['cr.azurecr.io/admin-ui@sha256:' + 'b'.repeat(64), /claude-gateway/],
  ]) assert.match(checkTarget(app(), image).errors.join('\n'), message);
  const two = app();
  two.properties.template.containers.push({ name: 'gateway', image: OLD });
  assert.match(checkTarget(two, NEW).errors.join('\n'), /exactly one container named gateway/);
});

test('T-182 the database snapshot is read-only, reads only our schema, and checks the spend contract', async () => {
  const sent = [];
  const db = { async query(text, params = []) {
    sent.push(text);
    if (/information_schema\.tables/.test(text)) return { rows: [{ t: 'admin_console.user_tags' }, { t: 'public._migrations' }, { t: 'public.spend' }] };
    if (/_migrations/.test(text)) return { rows: [{ version: '1' }] };
    if (/information_schema\.columns/.test(text)) return { rows: [{ c: 'principal', t: 'text' }, { c: 'period', t: 'text' }, { c: 'cents', t: 'numeric' }, { c: 'updated_at', t: 'timestamp with time zone' }] };
    if (/admin_console\.user_tags/.test(text)) return { rows: [{ object_id: 'x', department: 'Eng' }] };
    return { rows: [] };
  } };
  const s = await dbSnapshot(db);
  assert.equal(sent[0], 'BEGIN READ ONLY');
  assert.ok(sent.at(-1) === 'ROLLBACK' || sent.at(-1) === 'COMMIT');
  assert.ok(!sent.some((q) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(q)), 'no write statements');
  assert.ok(!sent.some((q) => /FROM public\.(spend_limits|admin_audit|principal_emails)\b/.test(q)), 'gateway data is compared through the admin API');
  assert.deepEqual(s.ours['admin_console.user_tags'].count, 1);
  assert.match(s.spendContract, /cents is numeric, expected double precision/);
});

test('T-182 the admin API summary hashes caps order-free and keeps monthly user spend and audit ids', async () => {
  const { summarizeApi } = await import('../scripts/admin/gateway-upgrade.mjs');
  const caps = [{ id: 'spl_1', scope: { type: 'organization' }, amount: '50000', period: 'monthly', updated_at: 'x' }, { id: 'spl_2', scope: { type: 'user', user_id: 'u1' }, amount: '0', period: 'daily' }];
  const s = summarizeApi({ caps, audit: [{ id: 9 }, { id: 8 }], effective: [
    { scope: { type: 'user', user_id: 'u1' }, period: 'monthly', period_to_date_spend: '12.5' },
    { scope: { type: 'user', user_id: 'u1' }, period: 'daily', period_to_date_spend: '1' }] });
  assert.deepEqual(s.monthly, { u1: 12.5 });
  assert.equal(s.auditNewest, 9);
  assert.equal(summarizeApi({ caps: [...caps].reverse() }).caps.hash, s.caps.hash, 'order-free');
  assert.equal(summarizeApi({ caps: [{ ...caps[0], updated_at: 'y' }, caps[1]] }).caps.hash, s.caps.hash, 'timestamps ignored');
  assert.notEqual(summarizeApi({ caps: [{ ...caps[0], amount: '1' }, caps[1]] }).caps.hash, s.caps.hash);
});

function fakeIo({ before = snapshot(), after = snapshot(), baselineFail = false, dbFail = false, revision = 'ready', appAfter } = {}) {
  const calls = [];
  let current = OLD;
  let n = 0;
  return {
    calls,
    io: {
      readApp: () => (n++ === 0 ? app(current) : appAfter ? appAfter(current) : app(current)),
      snapshot: async (phase) => {
        calls.push(['snapshot', phase]);
        if (dbFail) throw new Error('PostgreSQL: connect ETIMEDOUT');
        const s = phase === 'before' ? before : after;
        return baselineFail && phase === 'before' ? { ...s, checks: { ...s.checks, inference: 503 } } : s;
      },
      swapImage: async (image) => { calls.push(['swap', image]); current = image; },
      waitReady: async (prev) => { calls.push(['wait', prev]); return current === NEW && revision !== 'ready' ? { ok: false, reason: revision } : { ok: true, revision: 'r2' }; },
      saveState: (image) => calls.push(['save', image]),
      log: () => {},
    },
  };
}

test('T-182 a clean upgrade swaps only the gateway image once, compares, and records the image', async () => {
  const { io, calls } = fakeIo();
  const r = await runUpgrade({ io, image: NEW });
  assert.equal(r.status, 'upgraded');
  assert.deepEqual(calls.filter((c) => c[0] === 'swap'), [['swap', NEW]]);
  assert.deepEqual(calls.at(-1), ['save', NEW]);
});

test('T-182 plan, an unchanged image, an unreachable database and a failing baseline change nothing', async () => {
  for (const [opts, status] of [[{ plan: true }, 'plan'], [{ image: OLD }, 'unchanged'], [{ dbFail: true }, 'stopped'], [{ baselineFail: true }, 'stopped']]) {
    const { io, calls } = fakeIo(opts);
    const r = await runUpgrade({ io, image: opts.image ?? NEW, plan: opts.plan }).catch((e) => ({ status: 'stopped', error: e.message }));
    assert.equal(r.status, status, JSON.stringify(opts));
    assert.ok(!calls.some((c) => c[0] === 'swap' || c[0] === 'save'), `${status}: no swap, no state write`);
  }
});

test('T-182 a failed revision, a data difference, a failed check or changed settings roll back to the previous image', async () => {
  const changedSettings = (current) => { const a = app(current); a.properties.configuration.ingress.external = false; return a; };
  for (const opts of [
    { revision: 'ActivationFailed' },
    { after: snapshot({ db: { ...snapshot().db, ours: { 'admin_console.user_tags': { count: 0, hash: 'h0' } } } }) },
    { after: snapshot({ checks: { ...snapshot().checks, bootstrap: 500 } }) },
    { appAfter: changedSettings },
  ]) {
    const { io, calls } = fakeIo(opts);
    const r = await runUpgrade({ io, image: NEW });
    assert.equal(r.status, 'rolled-back', JSON.stringify(Object.keys(opts)));
    assert.deepEqual(calls.filter((c) => c[0] === 'swap').map((c) => c[1]), [NEW, OLD]);
    assert.ok(!calls.some((c) => c[0] === 'save'));
    assert.ok(r.failures.length > 0);
  }
  const { io, calls } = fakeIo({ revision: 'ActivationFailed' });
  const kept = await runUpgrade({ io, image: NEW, noRollback: true });
  assert.equal(kept.status, 'failed');
  assert.deepEqual(calls.filter((c) => c[0] === 'swap').map((c) => c[1]), [NEW]);
  assert.match(kept.rollback, /--image cr\.azurecr\.io\/claude-gateway@sha256:a{64}/);
});
