// T-99: admin-ui/server/roles.mjs - lists the gateway application's Entra app roles and creates one (ADR-0010).
// Microsoft Graph is faked; the PATCH body shape follows
// https://learn.microsoft.com/en-us/graph/api/application-update (appRoles is replaced as a whole collection) and
// https://learn.microsoft.com/en-us/graph/api/resources/approle (value: at most 120 characters, no spaces, not
// starting with '.'; origin is read-only).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRole, gatewayApplication, listRoles } from '../admin-ui/server/roles.mjs';

const STANDARD = { id: 'r-std', value: 'Gateway.Standard', displayName: 'Standard', description: 'Standard', isEnabled: true, allowedMemberTypes: ['User'], origin: 'Application' };
const PREMIUM = { id: 'r-pre', value: 'Gateway.Premium', displayName: 'Premium', description: 'Premium', isEnabled: true, allowedMemberTypes: ['User'], origin: 'Application' };
const admin = { roles: ['Gateway.Premium'], models: [{ id: 'm1', deployment: 'm1' }], policies: [{ role: 'Gateway.Premium', models: ['m1'], desktop: true }] };

function fakeGraph(appRoles = [STANDARD, PREMIUM]) {
  const calls = [];
  const state = { appRoles: structuredClone(appRoles) };
  async function graph(method, p, body) {
    calls.push({ method, path: p, body: structuredClone(body) });
    if (method === 'GET' && p.startsWith('/servicePrincipals/sp-1?')) return { status: 200, json: { id: 'sp-1', appId: 'app-guid' } };
    if (method === 'GET' && p.startsWith("/applications(appId='app-guid')?")) return { status: 200, json: { id: 'obj-1', appId: 'app-guid', appRoles: structuredClone(state.appRoles) } };
    if (method === 'PATCH' && p === '/applications/obj-1') { state.appRoles = body.appRoles; return { status: 204, json: null }; }
    throw Object.assign(new Error(`fake Graph: no route for ${method} ${p}`), { status: 500 });
  }
  return { graph, calls, state };
}

test('T-99 gatewayApplication finds the application behind the gateway service principal', async () => {
  const { graph } = fakeGraph();
  const app = await gatewayApplication({ graph, servicePrincipalId: 'sp-1' });
  assert.equal(app.id, 'obj-1');
  assert.deepEqual(app.appRoles.map((r) => r.value), ['Gateway.Standard', 'Gateway.Premium']);
});

test('T-99 listRoles marks admitted roles and carries their policy from the admin file', async () => {
  const { graph } = fakeGraph();
  const roles = await listRoles({ graph, servicePrincipalId: 'sp-1', admin });
  const pre = roles.find((r) => r.value === 'Gateway.Premium');
  const std = roles.find((r) => r.value === 'Gateway.Standard');
  assert.equal(pre.admitted, true);
  assert.deepEqual(pre.policy, { models: ['m1'], desktop: true });
  assert.equal(std.admitted, false);
  assert.equal(std.policy, null);
  assert.deepEqual(Object.keys(std).sort(), ['admitted', 'description', 'displayName', 'id', 'isEnabled', 'policy', 'value']);
});

test('T-99 createRole sends every existing role unchanged plus one enabled User role with a new id', async () => {
  const { graph, calls } = fakeGraph();
  const role = await createRole({ graph, servicePrincipalId: 'sp-1', newId: () => 'new-guid' }, { value: 'Gateway.Trial', displayName: 'Trial', description: 'Trial access' });
  const patch = calls.find((c) => c.method === 'PATCH');
  // origin is read-only and "Must not be included in any POST or PATCH requests" (appRole resource type, Graph v1.0).
  const withoutOrigin = ({ origin, ...rest }) => rest;
  assert.deepEqual(patch.body.appRoles.slice(0, 2), [withoutOrigin(STANDARD), withoutOrigin(PREMIUM)]);
  assert.deepEqual(patch.body.appRoles[2], { id: 'new-guid', value: 'Gateway.Trial', displayName: 'Trial', description: 'Trial access', isEnabled: true, allowedMemberTypes: ['User'] });
  assert.equal(patch.body.appRoles.length, 3);
  assert.deepEqual(role, { id: 'new-guid', value: 'Gateway.Trial', displayName: 'Trial', description: 'Trial access', isEnabled: true });
});

test('T-99 createRole refuses an invalid value with 400 and an existing one with 409, sending no PATCH', async () => {
  for (const [value, status] of [['.bad', 400], ['has space', 400], ['', 400], ['x'.repeat(121), 400], ['gateway.premium', 409]]) {
    const { graph, calls } = fakeGraph();
    await assert.rejects(createRole({ graph, servicePrincipalId: 'sp-1' }, { value, displayName: 'D', description: 'D' }), (e) => e.status === status, `${value} -> ${status}`);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  }
  const { graph } = fakeGraph();
  await assert.rejects(createRole({ graph, servicePrincipalId: 'sp-1' }, { value: 'Gateway.Ok', displayName: '', description: 'D' }), (e) => e.status === 400);
  await assert.rejects(createRole({ graph, servicePrincipalId: 'sp-1' }, { value: 'Gateway.Ok', displayName: 'D', description: 'a\u0000b' }), (e) => e.status === 400);
});
