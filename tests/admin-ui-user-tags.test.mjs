// T-142: the business-unit tag store (admin-ui/server/user-tags.mjs, ADR-0015) over a recording query function, the
// credential read from the gateway app, and CSV import.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTagStore, gatewayDatabase, parseCsv, TAGS, tagErrors } from '../admin-ui/server/user-tags.mjs';

const ID = '3f2b1c4d-0000-4000-8000-00000000abcd';
const ID2 = '3f2b1c4d-0000-4000-8000-00000000abce';
const ADMIN = '9a9a9a9a-0000-4000-8000-000000000001';

function recorder(answers = {}) {
  const calls = [];
  let opened = 0;
  const connect = async (cred) => {
    opened += 1;
    calls.push({ connect: cred });
    return {
      query: async (text, params = []) => {
        calls.push({ text, params });
        for (const [pattern, rows] of Object.entries(answers)) if (text.includes(pattern)) return { rows: typeof rows === 'function' ? rows(params) : rows };
        return { rows: [] };
      },
      close: async () => { calls.push({ close: true }); },
    };
  };
  return { calls, connect, opened: () => opened };
}
const CRED = { host: 'psql-claude-gw-x.postgres.database.azure.com', user: 'gateway', password: 'p', database: 'gateway' };

test('T-142 the five classifications, and gateway role is not one of them', () => {
  assert.deepEqual(TAGS.map((t) => t.key), ['department', 'costCenter', 'companyName', 'officeLocation', 'division']);
});

test('T-142 values: 1 to 64 characters without control characters, or null; known keys only', () => {
  assert.deepEqual(tagErrors({ department: 'Platform', costCenter: null }), []);
  assert.equal(tagErrors({ department: 'x'.repeat(65) }).length, 1);
  assert.equal(tagErrors({ office: 'a\nb' }).length + tagErrors({ officeLocation: 'a\nb' }).length, 2, 'unknown key and control character');
  assert.equal(tagErrors({ department: '' }).length, 1, 'empty is refused; null clears');
  assert.equal(tagErrors({}).length, 1, 'nothing to change');
});

test('T-142 set creates the schema once, writes by object ID with bound parameters, and records the administrator', async () => {
  const r = recorder({ 'RETURNING': (p) => [{ object_id: p[0], department: 'Platform', cost_center: null, company: null, office: null, division: null }] });
  const store = createTagStore({ credential: async () => CRED, connect: r.connect });
  const out = await store.set(ID, { department: '  Platform ', costCenter: null }, ADMIN);
  await store.set(ID, { department: 'Platform' }, ADMIN);
  const texts = r.calls.filter((c) => c.text).map((c) => c.text);
  assert.equal(texts.filter((t) => /CREATE SCHEMA IF NOT EXISTS admin_console/.test(t)).length, 1, 'schema created once per process');
  assert.equal(texts.filter((t) => /CREATE TABLE IF NOT EXISTS admin_console\.user_tags/.test(t)).length, 1);
  const write = r.calls.find((c) => c.text?.includes('INSERT INTO admin_console.user_tags'));
  assert.deepEqual(write.params, [ID, 'Platform', null, ADMIN]);
  assert.match(write.text, /\(object_id, department, cost_center, updated_at, updated_by\)/);
  assert.match(write.text, /ON CONFLICT \(object_id\) DO UPDATE SET department = EXCLUDED\.department, cost_center = EXCLUDED\.cost_center/);
  assert.ok(!/Platform/.test(write.text), 'no value is written into the SQL text');
  assert.deepEqual(out, { objectId: ID, department: 'Platform', costCenter: null, companyName: null, officeLocation: null, division: null });
  assert.equal(r.calls.filter((c) => c.close).length, 2, 'each operation closes its connection');
});

test('T-142 a bad ID or value is refused before any connection', async () => {
  const r = recorder();
  const store = createTagStore({ credential: async () => CRED, connect: r.connect });
  for (const [id, changes] of [['not-a-guid', { department: 'X' }], [ID, { department: 'x'.repeat(65) }], [ID, { jobTitle: 'X' }], ["'; drop table x; --", { department: 'X' }]]) {
    await assert.rejects(store.set(id, changes, ADMIN), (e) => e.status === 400, JSON.stringify([id, changes]));
  }
  assert.equal(r.opened(), 0);
});

test('T-142 all() maps rows by object ID to the five keys', async () => {
  const r = recorder({ 'SELECT object_id': [{ object_id: ID, department: 'Platform', cost_center: 'CC-1', company: null, office: 'Pune', division: null }] });
  const map = await createTagStore({ credential: async () => CRED, connect: r.connect }).all();
  assert.deepEqual(map.get(ID), { department: 'Platform', costCenter: 'CC-1', companyName: null, officeLocation: 'Pune', division: null });
});

test('T-142 the credential is the gateway app\'s GATEWAY_PG_HOST, GATEWAY_PG_USER and pg-password; a sidecar host is unavailable', async () => {
  const appWith = (env) => ({ properties: { template: { containers: [{ name: 'gateway', env }] } } });
  const calls = [];
  const arm = (env) => async (method, path) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET') return { status: 200, json: appWith(env) };
    return { status: 200, json: { value: [{ name: 'pg-password', value: 'secret-pw' }, { name: 'jwt-secret', value: 'x' }] } };
  };
  const rid = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-claude-gw';
  assert.deepEqual(await gatewayDatabase({ arm: arm([{ name: 'GATEWAY_PG_HOST', value: CRED.host }, { name: 'GATEWAY_PG_PASSWORD', secretRef: 'pg-password' }]), resourceId: rid }),
    { host: CRED.host, user: 'gateway', password: 'secret-pw', database: 'gateway' });
  assert.deepEqual(calls, [`GET ${rid}`, `POST ${rid}/listSecrets`]);
  assert.equal((await gatewayDatabase({ arm: arm([{ name: 'GATEWAY_PG_HOST', value: 'h.example' }, { name: 'GATEWAY_PG_USER', value: 'pgadmin' }]), resourceId: rid })).user, 'pgadmin');
  const sidecar = await gatewayDatabase({ arm: arm([{ name: 'GATEWAY_PG_HOST', value: '127.0.0.1' }]), resourceId: rid });
  assert.equal(sidecar.unavailable, true);
  assert.match(sidecar.reason, /managed database/);
  const r = recorder();
  const store = createTagStore({ credential: async () => sidecar, connect: r.connect });
  assert.deepEqual(await store.status(), { available: false, reason: sidecar.reason });
  await assert.rejects(store.set(ID, { department: 'X' }, ADMIN), (e) => e.status === 503 && /managed database/.test(e.message));
  assert.equal(r.opened(), 0);
});

test('T-142 CSV: quoted fields, header aliases and a byte-order mark', () => {
  assert.deepEqual(parseCsv('\ufeffuser,Cost Center\r\n"a@contoso.example","CC, 1"\r\n'), [['user', 'Cost Center'], ['a@contoso.example', 'CC, 1']]);
  assert.deepEqual(parseCsv('a,"b ""q"""\n'), [['a', 'b "q"']]);
});

test('T-142 import resolves users by UPN, email or object ID, writes non-empty cells, and reports unusable lines', async () => {
  const r = recorder({ 'RETURNING': (p) => [{ object_id: p[0] }] });
  const store = createTagStore({ credential: async () => CRED, connect: r.connect });
  const resolve = async (u) => ({ 'ana@contoso.example': ID, [ID2]: ID2 }[u.toLowerCase()] ?? null);
  const csv = 'user,department,costCenter,company,office,division\nana@contoso.example,Platform,,Contoso,,\n' +
    `${ID2},,CC-9,,,\nnobody@contoso.example,X,,,,\n,Y,,,,\nana@contoso.example,${'z'.repeat(70)},,,,\n`;
  const out = await store.importCsv(csv, { resolve, by: ADMIN });
  assert.deepEqual(out.updated, [{ line: 2, objectId: ID }, { line: 3, objectId: ID2 }]);
  assert.deepEqual(out.skipped.map((s) => s.line), [4, 5, 6]);
  assert.match(out.skipped[0].reason, /no Entra user/);
  const writes = r.calls.filter((c) => c.text?.includes('INSERT INTO'));
  assert.deepEqual(writes.map((w) => w.params), [[ID, 'Platform', 'Contoso', ADMIN], [ID2, 'CC-9', ADMIN]]);
  await assert.rejects(store.importCsv('department\nX\n', { resolve, by: ADMIN }), (e) => e.status === 400 && /user/.test(e.message));
  await assert.rejects(store.importCsv('user,jobTitle\na,b\n', { resolve, by: ADMIN }), (e) => e.status === 400 && /jobTitle/.test(e.message));
});
