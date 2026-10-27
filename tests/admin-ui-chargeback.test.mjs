// T-100, T-143: admin-ui/server/chargeback.mjs - chargeback by business unit from the gateway's /effective rows joined
// to Entra users by email (ADR-0010, U-89, U-90), grouped by the business-unit tags kept in the gateway database by
// object ID (ADR-0015). The Entra attributes in USERS are deliberately different from the tags: they must be ignored.
// Row shape copied from the live Contoso gateway's /effective answer (tests/admin-ui-web.test.mjs); users invented.
// CSV neutralisation: https://owasp.org/www-community/attacks/CSV_Injection
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChargeback, chargebackCsv, collectEffective, listBusinessUnits } from '../admin-ui/server/chargeback.mjs';

const row = (sub, email, cents, groups = ['Gateway.Standard'], amount = null, period = 'monthly') => ({
  scope: { type: 'user', user_id: sub }, groups, actor: email ? { type: 'user_actor', user_id: sub, name: `Name ${sub}`, email_address: email } : null,
  amount, currency: 'USD', period, source: null, spend_limit_id: null, period_to_date_spend: String(cents),
});

const USERS = {
  'ana@contoso.example': { id: 'u1', displayName: 'Ana', userPrincipalName: 'ana@contoso.example', department: 'ENTRA-Eng', companyName: 'ENTRA-Co', officeLocation: 'ENTRA-Office', jobTitle: 'Dev', employeeOrgData: { costCenter: 'ENTRA-CC', division: 'ENTRA-Div' } },
  'bo@contoso.example': { id: 'u2', displayName: 'Bo', userPrincipalName: 'bo@contoso.example', department: 'ENTRA-Fin', companyName: 'ENTRA-Co', officeLocation: null, jobTitle: null, employeeOrgData: null },
  'cy@contoso.example': { id: 'u3', displayName: 'Cy', userPrincipalName: 'cy@contoso.example', department: 'ENTRA-Cy', companyName: 'ENTRA-Co', officeLocation: null, jobTitle: null, employeeOrgData: { costCenter: null, division: null } },
  'dee@contoso.example': { id: 'u4', displayName: 'Dee', userPrincipalName: 'dee@contoso.example', department: 'ENTRA-Eng', companyName: 'ENTRA-Co', officeLocation: null, jobTitle: null, employeeOrgData: { costCenter: 'ENTRA-CC2', division: null } },
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

// The tags the gateway database holds, by object ID (ADR-0015). Entra's department for u1 is Engineering, its tag is Platform.
const tag = (department, costCenter = null, more = {}) => ({ department, costCenter, companyName: null, officeLocation: null, division: null, ...more });
const TAGS = new Map([['u1', tag('Engineering', 'CC-100', { companyName: 'Contoso', officeLocation: 'Pune', division: 'R&D' })], ['u2', tag('Finance')], ['u4', tag('Engineering', '=HYPERLINK("x")')]]);
const ENTRA_ONLY = new Map();

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
  const r = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'department', tags: TAGS, now: () => new Date('2026-10-24T00:00:00Z') });
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
  const r = await buildChargeback({ rows: [ROWS[1], org, group], graph, period: 'monthly', groupBy: 'department', tags: TAGS });
  assert.equal(r.totalCents, 250.25);
  assert.equal(r.rows.length, 1);
});

test('T-100 groups by cost center, division and gateway role', async () => {
  const { graph } = fakeGraph();
  const cc = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'costCenter', tags: TAGS });
  assert.equal(cc.groups.find((g) => g.key === 'CC-100').totalCents, 1000.5);
  const role = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'role', tags: TAGS });
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Premium').totalCents, 1000.5);
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Premium + Gateway.Standard').totalCents, 49.25);
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Standard').totalCents, 365.25);
  await assert.rejects(buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'salary', tags: TAGS }), (e) => e.status === 400);
  await assert.rejects(buildChargeback({ rows: ROWS, graph, period: 'yearly', groupBy: 'role', tags: TAGS }), (e) => e.status === 400);
});

test('T-100 looks each email up once, case-insensitively', async () => {
  const { graph, calls } = fakeGraph();
  await buildChargeback({ rows: [...ROWS, row('s7', 'ANA@contoso.example', '1')], graph, period: 'monthly', groupBy: 'department', tags: TAGS });
  const anaLookups = calls.filter((c) => /\/users\/ana%40contoso\.example/i.test(c.path));
  assert.equal(anaLookups.length, 1);
});

test('T-100 the CSV neutralises cells that start with = + - @ and quotes commas', async () => {
  const { graph } = fakeGraph();
  const r = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'costCenter', tags: TAGS });
  const csv = chargebackCsv(r);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'period,group,name,email,roles,department,cost_center,company,office,division,spend_usd,cap_usd,resolved');
  const dee = lines.find((l) => l.includes('dee@contoso.example'));
  assert.ok(dee.startsWith('monthly,"\'=HYPERLINK(""x"")"'), dee);
  assert.ok(!/(^|,)[=+\-@]/.test(csv.replace(/"/g, '')), 'no cell starts with a formula character');
  const ana = lines.find((l) => l.includes('ana@contoso.example'));
  assert.match(ana, /,10\.0050,50\.0000,true$/);
});

// T-107, T-143: business units are the department tag of every developer holding a gateway role, spend or not, so a
// unit can be created and filled before anyone in it has used the gateway.
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
  const r = await listBusinessUnits({ graph, developers, tags: TAGS });
  assert.deepEqual(r.users.map((u) => [u.id, u.upn, u.name, u.roles, u.department, u.costCenter]), [ // tags, not ENTRA-*
    ['u1', 'ana@contoso.example', 'Ana', ['Gateway.Premium', 'Gateway.Standard'], 'Engineering', 'CC-100'],
    ['u4', 'dee@contoso.example', 'Dee', ['Gateway.Standard'], 'Engineering', '=HYPERLINK("x")'],
    ['u3', 'cy@contoso.example', 'Cy', ['Gateway.Standard'], null, null],
  ]);
  assert.deepEqual(r.units, [{ name: 'Engineering', users: 2 }]);
  assert.equal(r.unassigned, 1);
  assert.deepEqual(r.skipped, [{ principalId: 'g9', name: 'Platform team' }]);
  assert.equal(calls.filter((c) => c.path.startsWith('/users/u1')).length, 1, 'one Graph lookup per principal');
});

test('T-143 company, office and division group by their tags; a user with no tag is unassigned', async () => {
  const { graph } = fakeGraph();
  for (const [groupBy, key] of [['companyName', 'Contoso'], ['officeLocation', 'Pune'], ['division', 'R&D']]) {
    const r = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy, tags: TAGS });
    assert.equal(r.groups.find((g) => g.key === key)?.totalCents, 1000.5, groupBy);
    assert.equal(r.groups.find((g) => g.key === '(unassigned)')?.totalCents, 399.5, `${groupBy}: bo, cy and dee have no ${groupBy} tag`);
    assert.ok(!r.groups.some((g) => /^ENTRA-/.test(g.key)), `${groupBy}: no Entra attribute is used`);
  }
  const ana = (await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'department', tags: TAGS })).rows.find((x) => x.userId === 's1');
  assert.deepEqual([ana.department, ana.costCenter, ana.companyName, ana.officeLocation, ana.division, ana.objectId], ['Engineering', 'CC-100', 'Contoso', 'Pune', 'R&D', 'u1']);
});

test('T-143 Graph is only read: chargeback and business units send no write to Entra', async () => {
  const { graph, calls } = fakeGraph();
  await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'department', tags: TAGS });
  await listBusinessUnits({ graph: fakeGraph({ u1: USERS['ana@contoso.example'] }).graph, developers: [{ role: 'Gateway.Standard', name: 'Ana', principalId: 'u1' }], tags: TAGS });
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET']);
  assert.ok(calls.every((c) => !/department|employeeOrgData|companyName|officeLocation/.test(c.path)), 'no Entra business attribute is even selected');
});

test('T-143 without the tag store, grouping by a tag reports everyone unassigned and says why; role still groups', async () => {
  const { graph } = fakeGraph();
  const off = { unavailable: true, reason: 'Business-unit tags are kept in the gateway\'s managed PostgreSQL.' };
  const dept = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'department', tags: off });
  assert.deepEqual(dept.groups.map((g) => g.key).sort(), ['(unassigned)', '(unresolved)']);
  assert.ok(dept.notes.includes(off.reason));
  const role = await buildChargeback({ rows: ROWS, graph, period: 'monthly', groupBy: 'role', tags: off });
  assert.equal(role.groups.find((g) => g.key === 'Gateway.Premium').totalCents, 1000.5);
  const units = await listBusinessUnits({ graph: fakeGraph({ u1: USERS['ana@contoso.example'] }).graph, developers: [{ role: 'Gateway.Standard', name: 'Ana', principalId: 'u1' }], tags: off });
  assert.deepEqual([units.users[0].department, units.units], [null, []]);
});
