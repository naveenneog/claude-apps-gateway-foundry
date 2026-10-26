// T-100, T-101: admin-ui/server/chargeback.mjs - chargeback by business unit from the gateway's /effective rows joined
// to Entra users by email (ADR-0010, U-89, U-90), and tagging a user's department or cost center.
// Row shape copied from the live Contoso gateway's /effective answer (tests/admin-ui-web.test.mjs); users invented.
// CSV neutralisation: https://owasp.org/www-community/attacks/CSV_Injection
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChargeback, chargebackCsv, collectEffective, listBusinessUnits, tagUser } from '../admin-ui/server/chargeback.mjs';

const row = (sub, email, cents, groups = ['Gateway.Standard'], amount = null, period = 'monthly') => ({
  scope: { type: 'user', user_id: sub }, groups, actor: email ? { type: 'user_actor', user_id: sub, name: `Name ${sub}`, email_address: email } : null,
  amount, currency: 'USD', period, source: null, spend_limit_id: null, period_to_date_spend: String(cents),
});

const USERS = {
  'ana@contoso.example': { id: 'u1', displayName: 'Ana', userPrincipalName: 'ana@contoso.example', department: 'Engineering', companyName: 'Contoso', officeLocation: 'Pune', jobTitle: 'Dev', employeeOrgData: { costCenter: 'CC-100', division: 'R&D' } },
  'bo@contoso.example': { id: 'u2', displayName: 'Bo', userPrincipalName: 'bo@contoso.example', department: 'Finance', companyName: 'Contoso', officeLocation: null, jobTitle: null, employeeOrgData: null },
  'cy@contoso.example': { id: 'u3', displayName: 'Cy', userPrincipalName: 'cy@contoso.example', department: null, companyName: 'Contoso', officeLocation: null, jobTitle: null, employeeOrgData: { costCenter: null, division: null } },
  'dee@contoso.example': { id: 'u4', displayName: 'Dee', userPrincipalName: 'dee@contoso.example', department: 'Engineering', companyName: 'Contoso', officeLocation: null, jobTitle: null, employeeOrgData: { costCenter: '=HYPERLINK("x")', division: null } },
};

function fakeGraph(users = USERS) {
  const calls = [];
  async function graph(method, p, body) {
    calls.push({ method, path: p, body: structuredClone(body) });
    const m = p.match(/^\/users\/([^?]+)(\?.*)?$/);
    if (method === 'GET' && m) {
      const u = users[decodeURIComponent(m[1]).toLowerCase()];
      return u ? { status: 200, json: structuredClone(u) } : { status: 404, json: { error: { code: 'Request_ResourceNotFound' } } };
    }
    if (method === 'GET' && p.startsWith('/users?')) return { status: 200, json: { value: [] } };
    if (method === 'PATCH' && m) return { status: 204, json: null };
    throw Object.assign(new Error(`fake Graph: no route for ${method} ${p}`), { status: 500 });
  }
  return { graph, calls };
}

const ROWS = [
  row('s1', 'Ana@Contoso.example', '1000.5', ['Gateway.Premium'], '5000'),
  row('s2', 'bo@contoso.example', '250.25'),
  row('s3', 'cy@contoso.example', '100'),
  row('s4', 'dee@contoso.example', '49.25', ['Gateway.Standard', 'Gateway.Premium']),
  row('s5', 'gone@contoso.example', '10'),
  row('s6', null, '5'),
  row('s1', 'Ana@Contoso.example', '7', ['Gateway.Premium'], null, 'daily'),
];

test('T-100 collectEffective pages through /effective for one period until next_page is null', async () => {
  const seen = [];
  const list = async (_deps, q) => { seen.push(q); return q.page ? { data: [ROWS[1]], next_page: null } : { data: [ROWS[0]], next_page: 'p2' }; };
  const rows = await collectEffective({ gateway: {}, period: 'monthly', listEffective: list });
  assert.equal(rows.length, 2);
  assert.deepEqual(seen.map((q) => [q.period, q.page]), [[['monthly'], undefined], [['monthly'], 'p2']]);
});

test('T-100 groups by department, and every group total adds up to the overall total', async () => {
  const { graph } = fakeGraph();
  const r = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'department', now: () => new Date('2026-10-24T00:00:00Z') });
  const by = Object.fromEntries(r.groups.map((g) => [g.key, g]));
  assert.equal(by.Engineering.totalCents, 1049.75);
  assert.equal(by.Engineering.users, 2);
  assert.equal(by.Finance.totalCents, 250.25);
  assert.equal(by['(unassigned)'].totalCents, 100);
  assert.equal(by['(unresolved)'].totalCents, 15, 'a row whose email is unknown to Entra, and a row with no email, are unresolved, not dropped');
  assert.equal(r.totalCents, 1415);
  assert.equal(r.groups.reduce((a, g) => a + g.totalCents, 0), r.totalCents);
  assert.equal(r.rows.length, 6, 'the daily row is not part of a monthly report');
  assert.equal(r.groups[0].key, 'Engineering', 'largest first');
  assert.equal(by.Engineering.sharePct, 74.2);
  const ana = r.rows.find((x) => x.userId === 's1');
  assert.deepEqual({ name: ana.name, email: ana.email, capCents: ana.capCents, resolved: ana.resolved, costCenter: ana.costCenter }, { name: 'Ana', email: 'ana@contoso.example', capCents: 5000, resolved: true, costCenter: 'CC-100' });
  assert.equal(r.rows.find((x) => x.userId === 's5').resolved, false);
  assert.equal(r.generatedAt, '2026-10-24T00:00:00.000Z');
  assert.ok(r.notes.some((n) => /list price/i.test(n)));
});

test('T-100 only per-user rows count: an organisation or group row in /effective is not charged back again', async () => {
  const { graph } = fakeGraph();
  const org = { ...row('org', null, '9999'), scope: { type: 'organization' }, actor: null };
  const group = { ...row('g', null, '5000'), scope: { type: 'group', group: 'Gateway.Standard' }, actor: null };
  const r = await buildChargeback({ rows: [ROWS[1], org, group], graph, period: 'monthly', groupBy: 'department' });
  assert.equal(r.totalCents, 250.25);
  assert.equal(r.rows.length, 1);
});

test('T-100 groups by cost center, division and gateway role', async () => {
  const { graph } = fakeGraph();
  const cc = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'costCenter' });
  assert.equal(cc.groups.find((g) => g.key === 'CC-100').totalCents, 1000.5);
  const role = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'role' });
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Premium').totalCents, 1000.5);
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Premium + Gateway.Standard').totalCents, 49.25);
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Standard').totalCents, 365.25);
  await assert.rejects(buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'salary' }), (e) => e.status === 400);
  await assert.rejects(buildChargeback({ rows: ROWS, graph, period: 'yearly', groupBy: 'role' }), (e) => e.status === 400);
});

test('T-100 looks each email up once, case-insensitively', async () => {
  const { graph, calls } = fakeGraph();
  await buildChargeback({ rows: [...ROWS, row('s7', 'ANA@contoso.example', '1')], graph, period: 'monthly', groupBy: 'department' });
  const anaLookups = calls.filter((c) => /\/users\/ana%40contoso\.example/i.test(c.path));
  assert.equal(anaLookups.length, 1);
});

test('T-100 the CSV neutralises cells that start with = + - @ and quotes commas', async () => {
  const { graph } = fakeGraph();
  const r = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'costCenter' });
  const csv = chargebackCsv(r);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'period,group,name,email,roles,department,cost_center,spend_usd,cap_usd,resolved');
  const dee = lines.find((l) => l.includes('dee@contoso.example'));
  assert.ok(dee.startsWith('monthly,"\'=HYPERLINK(""x"")"'), dee);
  assert.ok(!/(^|,)[=+\-@]/.test(csv.replace(/"/g, '')), 'no cell starts with a formula character');
  const ana = lines.find((l) => l.includes('ana@contoso.example'));
  assert.match(ana, /,10\.0050,50\.0000,true$/);
});

test('T-101 tagUser sends only department and costCenter, keeping the division Graph already has', async () => {
  const { graph, calls } = fakeGraph();
  const r = await tagUser({ graph }, 'ana@contoso.example', { department: 'Platform', costCenter: 'CC-200', jobTitle: 'ignored' });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, '/users/ana%40contoso.example');
  assert.deepEqual(patch.body, { department: 'Platform', employeeOrgData: { costCenter: 'CC-200', division: 'R&D' } });
  assert.deepEqual(r, { user: { upn: 'ana@contoso.example', department: 'Platform', costCenter: 'CC-200' } });
});

test('T-101 tagUser clears with null, refuses values over 64 characters or with control characters, and an empty change', async () => {
  const { graph, calls } = fakeGraph();
  await tagUser({ graph }, 'bo@contoso.example', { department: null });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { department: null });
  for (const bad of [{ department: 'x'.repeat(65) }, { costCenter: 'a\nb' }, {}, { department: 5 }]) {
    const g = fakeGraph();
    await assert.rejects(tagUser({ graph: g.graph }, 'bo@contoso.example', bad), (e) => e.status === 400, JSON.stringify(bad));
    assert.equal(g.calls.filter((c) => c.method === 'PATCH').length, 0);
  }
  await assert.rejects(tagUser({ graph }, 'nobody@contoso.example', { department: 'X' }), (e) => e.status === 404);
});

// T-107: business units are the Entra department of every developer holding a gateway role, spend or not, so a unit
// can be created and filled before anyone in it has used the gateway.
test('T-107 listBusinessUnits lists each role holder once with merged roles, groups them by department, and skips non-users', async () => {
  const byId = { u1: USERS['ana@contoso.example'], u3: USERS['cy@contoso.example'], u4: USERS['dee@contoso.example'] };
  const { graph, calls } = fakeGraph(byId);
  const developers = [
    { role: 'Gateway.Standard', name: 'Ana', principalId: 'u1' },
    { role: 'Gateway.Premium', name: 'Ana', principalId: 'u1' },
    { role: 'Gateway.Standard', name: 'Cy', principalId: 'u3' },
    { role: 'Gateway.Standard', name: 'Dee', principalId: 'u4' },
    { role: 'Gateway.Standard', name: 'Platform team', principalId: 'g9' },
  ];
  const r = await listBusinessUnits({ graph, developers });
  assert.deepEqual(r.users.map((u) => [u.id, u.upn, u.name, u.roles, u.department, u.costCenter]), [
    ['u1', 'ana@contoso.example', 'Ana', ['Gateway.Premium', 'Gateway.Standard'], 'Engineering', 'CC-100'],
    ['u4', 'dee@contoso.example', 'Dee', ['Gateway.Standard'], 'Engineering', '=HYPERLINK("x")'],
    ['u3', 'cy@contoso.example', 'Cy', ['Gateway.Standard'], null, null],
  ]);
  assert.deepEqual(r.units, [{ name: 'Engineering', users: 2 }]);
  assert.equal(r.unassigned, 1);
  assert.deepEqual(r.skipped, [{ principalId: 'g9', name: 'Platform team' }]);
  assert.equal(calls.filter((c) => c.path.startsWith('/users/u1')).length, 1, 'one Graph lookup per principal');
});
