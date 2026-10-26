// T-114 (ADR-0012): infra/azure-test/lib/database.mjs against a fake Azure Resource Manager: provider registration
// (U-103) and the firewall sync that allows exactly the gateway app's outbound addresses (U-101).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureProvider, existingServer, prepareDatabase, syncFirewall } from '../infra/azure-test/lib/database.mjs';

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';
const SERVER = `${SUB}/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-claude-gw-x`;
const APP = `${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-claude-gw`;

function fakeArm({ state = 'NotRegistered', registeredAfter = 2, outbound = ['192.0.2.10'], rules = [] } = {}) {
  const calls = [];
  let current = state;
  let readsSinceRegister = 0;
  const live = new Map(rules.map((r) => [r.name, r]));
  async function arm(method, p, body) {
    calls.push({ method, path: p.split('?')[0], body });
    const path = p.split('?')[0];
    if (method === 'GET' && path === `${SUB}/providers/Microsoft.DBforPostgreSQL`) {
      if (current === 'Registering' && (readsSinceRegister += 1) > registeredAfter) current = 'Registered';
      return { status: 200, json: { registrationState: current } };
    }
    if (method === 'POST' && path === `${SUB}/providers/Microsoft.DBforPostgreSQL/register`) { current = 'Registering'; return { status: 200, json: {} }; }
    if (method === 'GET' && path === APP) return { status: 200, json: { properties: { outboundIpAddresses: outbound } } };
    if (method === 'GET' && path === `${SERVER}/firewallRules`) return { status: 200, json: { value: [...live.values()] } };
    const rule = path.match(/\/firewallRules\/([^/]+)$/);
    if (rule && method === 'PUT') { live.set(rule[1], { name: rule[1], properties: body.properties }); return { status: 200, json: {} }; }
    if (rule && method === 'DELETE') { live.delete(rule[1]); return { status: 200, json: {} }; }
    throw Object.assign(new Error(`fake ARM: no route for ${method} ${p}`), { status: 500 });
  }
  return { arm, calls, live };
}

test('T-114 ensureProvider registers Microsoft.DBforPostgreSQL when it is not registered and waits for Registered', async () => {
  const f = fakeArm();
  const said = [];
  await ensureProvider({ arm: f.arm, subscriptionPath: SUB, sleep: async () => {}, say: (m) => said.push(m) });
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.match(said.join('\n'), /registered/i);
  const done = fakeArm({ state: 'Registered' });
  await ensureProvider({ arm: done.arm, subscriptionPath: SUB, sleep: async () => {}, say: () => {} });
  assert.equal(done.calls.filter((c) => c.method === 'POST').length, 0, 'already registered: no register call');
});

test('T-114 ensureProvider gives up with the provider state after its attempts', async () => {
  const f = fakeArm({ registeredAfter: Infinity });
  await assert.rejects(ensureProvider({ arm: f.arm, subscriptionPath: SUB, sleep: async () => {}, say: () => {}, attempts: 3 }), /Registering/);
});

test('T-114 syncFirewall puts a rule for each outbound address, removes stale aca-outbound rules and keeps others', async () => {
  const f = fakeArm({
    outbound: ['192.0.2.10', '198.51.100.9'],
    rules: [
      { name: 'aca-outbound-203-0-113-1', properties: { startIpAddress: '203.0.113.1', endIpAddress: '203.0.113.1' } },
      { name: 'office', properties: { startIpAddress: '192.0.2.4', endIpAddress: '192.0.2.4' } },
    ],
  });
  const result = await syncFirewall({ arm: f.arm, appId: APP, serverId: SERVER, say: () => {} });
  assert.deepEqual([...f.live.keys()].sort(), ['aca-outbound-192-0-2-10', 'aca-outbound-198-51-100-9', 'office']);
  assert.deepEqual(f.live.get('aca-outbound-198-51-100-9').properties, { startIpAddress: '198.51.100.9', endIpAddress: '198.51.100.9' });
  assert.deepEqual(result, { added: ['aca-outbound-192-0-2-10', 'aca-outbound-198-51-100-9'], removed: ['aca-outbound-203-0-113-1'] });
});

test('T-114 syncFirewall with check:true reports the difference and changes nothing', async () => {
  const f = fakeArm({ rules: [{ name: 'aca-outbound-203-0-113-1', properties: { startIpAddress: '203.0.113.1', endIpAddress: '203.0.113.1' } }] });
  const result = await syncFirewall({ arm: f.arm, appId: APP, serverId: SERVER, say: () => {}, check: true });
  assert.deepEqual(result, { added: ['aca-outbound-192-0-2-10'], removed: ['aca-outbound-203-0-113-1'] });
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('T-114 existingServer finds the gateway\'s psql-claude-gw-* server and its region, so deploy.mjs reuses it', async () => {
  const list = (value) => async (method, p) => { assert.equal(method, 'GET'); assert.match(p, /\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\?/); return { status: 200, json: { value } }; };
  assert.deepEqual(await existingServer({ arm: list([{ name: 'other', location: 'East US' }, { name: 'psql-claude-gw-abc-centralus', location: 'Central US', id: '/x' }]), groupPath: '/g' }),
    { name: 'psql-claude-gw-abc-centralus', location: 'centralus', id: '/x' });
  assert.equal(await existingServer({ arm: list([]), groupPath: '/g' }), null);
  await assert.rejects(existingServer({ arm: list([{ name: 'psql-claude-gw-a', location: 'eastus' }, { name: 'psql-claude-gw-b', location: 'westus' }]), groupPath: '/g' }), /two/);
});

test('T-114 prepareDatabase reuses a server the move script made, in its own region, instead of creating one in the app\'s', async () => {
  const calls = [];
  const arm = async (method, p) => {
    calls.push(`${method} ${p.split('?')[0]}`);
    if (p.includes('/flexibleServers?')) return { status: 200, json: { value: [{ name: 'psql-claude-gw-abc-centralus', location: 'Central US', id: SERVER }] } };
    if (p.includes('/providers/Microsoft.DBforPostgreSQL?')) return { status: 200, json: { registrationState: 'Registered' } };
    if (p.startsWith(APP)) return { status: 200, json: { properties: { outboundIpAddresses: ['192.0.2.10'] } } };
    if (p.includes('/firewallRules?')) return { status: 200, json: { value: [{ name: 'aca-outbound-192-0-2-10', properties: { startIpAddress: '192.0.2.10' } }] } };
    throw new Error(`no route ${method} ${p}`);
  };
  const ctx = { groupPath: `${SUB}/resourceGroups/rg`, opts: { location: 'eastus2' }, state: { subscriptionId: '0', appName: 'ca-claude-gw' } };
  assert.deepEqual(await prepareDatabase({ arm, ctx, database: 'managed', preview: false, appExists: true }), { databaseLocation: 'centralus' });
  assert.equal(ctx.state.pgServerName, 'psql-claude-gw-abc-centralus');
  assert.ok(calls.some((c) => c.endsWith('/firewallRules')), 'an existing app gets its firewall synced before the deployment');
  const sidecar = { ...ctx, state: {} };
  assert.deepEqual(await prepareDatabase({ arm, ctx: sidecar, database: 'sidecar' }), { databaseLocation: undefined });
});
