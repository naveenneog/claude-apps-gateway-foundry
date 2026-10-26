// T-106: the pure checks behind tests/live/admin-ui-t106.mjs, which saves the live gateway configuration through
// admin-ui's own modules. These decide PASS or FAIL for "secret and environment names are unchanged" and "the report
// total equals the Dashboard total", so they are tested here against fixed app and row shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appShape, shapeFindings, dashboardTotalCents, persistFindings } from '../tests/live/admin-ui-t106.mjs';

const app = (secrets, env) => ({ properties: {
  configuration: { secrets: secrets.map((name) => ({ name })) },
  template: { containers: [{ name: 'gateway', env: env.map((name) => ({ name })) }, { name: 'postgres', env: [{ name: 'PGDATA' }] }] },
} });

test('T-106 appShape lists secret names and each container\'s environment names, sorted', () => {
  assert.deepEqual(appShape(app(['b', 'a'], ['Y', 'X'])), { secrets: ['a', 'b'], env: { gateway: ['X', 'Y'], postgres: ['PGDATA'] } });
});

test('T-106 shapeFindings allows only the admin-file secret and the config stamp to appear, and nothing to disappear', () => {
  const before = appShape(app(['gateway-config', 'jwt-secret'], ['GATEWAY_JWT_SECRET']));
  assert.deepEqual(shapeFindings(before, before), []);
  const firstSave = appShape(app(['gateway-config', 'jwt-secret', 'gateway-admin-file'], ['GATEWAY_JWT_SECRET', 'CONFIG_UPDATED_AT']));
  assert.deepEqual(shapeFindings(before, firstSave), []);
  const lost = appShape(app(['gateway-config'], ['GATEWAY_JWT_SECRET']));
  assert.deepEqual(shapeFindings(before, lost), ['secret jwt-secret is missing after the save']);
  const extra = appShape(app(['gateway-config', 'jwt-secret', 'other'], ['GATEWAY_JWT_SECRET', 'NEW_VAR']));
  assert.deepEqual(shapeFindings(before, extra), ['secret other appeared after the save', 'gateway: environment variable NEW_VAR appeared after the save']);
  const noContainer = { secrets: before.secrets, env: { gateway: before.env.gateway } };
  assert.deepEqual(shapeFindings(before, noContainer), ['container postgres is missing after the save']);
});

test('T-106 dashboardTotalCents sums the same per-row spend the Dashboard shows', () => {
  const spendRow = (r) => ({ spendCents: Number(r.period_to_date_spend) });
  assert.equal(dashboardTotalCents([{ period_to_date_spend: '1000.5' }, { period_to_date_spend: '250.25' }], spendRow), 1250.75);
  assert.equal(dashboardTotalCents([], spendRow), 0);
});

// T-116 (ADR-0012): what a configuration save on the managed database must keep.
test('T-116 persistFindings: spend may only grow and caps must be identical across the save', () => {
  const row = (user, cents) => ({ scope: { type: 'user', user_id: user }, period: 'monthly', period_to_date_spend: String(cents) });
  const cap = { id: 'sl_1', scope: { type: 'organization' }, period: 'monthly', amount: '50000' };
  const before = { rows: [row('u1', 10.5)], caps: [cap] };
  assert.deepEqual(persistFindings(before, { rows: [row('u1', 10.5)], caps: [cap] }), []);
  assert.deepEqual(persistFindings(before, { rows: [row('u1', 12)], caps: [cap] }), [], 'a request during the save may add spend');
  assert.deepEqual(persistFindings(before, { rows: [], caps: [] }), ['u1 monthly spend 10.5 is gone after the save', 'cap sl_1 is gone after the save']);
  assert.deepEqual(persistFindings(before, { rows: [row('u1', 3)], caps: [{ ...cap, amount: '100' }] }), ['u1 monthly spend fell from 10.5 to 3', 'cap sl_1 changed']);
  assert.deepEqual(persistFindings({ rows: [], caps: [] }, { rows: [], caps: [] }), ['nothing to compare: no spend and no cap before the save']);
});
