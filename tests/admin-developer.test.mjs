// T-53 (docs/TEST-PLAN.md): scripts/admin/set-developer.mjs grants and removes the gateway's app roles through
// Microsoft Graph (ADR-0004), against an in-memory Graph that records every call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listDevelopers, main, setDeveloper } from '../scripts/admin/set-developer.mjs';

const SP = 'sp-gateway';
const appRoles = [
  { id: 'role-standard', value: 'Gateway.Standard' },
  { id: 'role-premium', value: 'Gateway.Premium' },
];
// The roles the gateway admits, from the admin file (config/gateway-admin.azure-test.json).
const admittedRoles = ['Gateway.Standard', 'Gateway.Premium'];
const GUEST = 'dev_contoso.com#EXT#@tenant.onmicrosoft.com';

// Graph as scripts/admin/set-developer.mjs calls it: graph(method, path, body, { ok }) like infra/azure-test/lib/azure-rest.mjs.
function fakeGraph({ assignments = [], pageSize = 2 } = {}) {
  const users = { 'dev@contoso.com': { id: 'user-dev', displayName: 'Dev One', userPrincipalName: 'dev@contoso.com' },
    [GUEST]: { id: 'user-guest', displayName: 'Guest Dev', userPrincipalName: GUEST } };
  const calls = [];
  const state = { assignments: assignments.map((a) => ({ ...a })), next: 1 };
  const graph = async (method, target, body, { ok = [200, 201, 204] } = {}) => {
    calls.push({ method, path: target, body });
    const path = target.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '');
    const respond = (status, json) => {
      if (!ok.includes(status)) throw Object.assign(new Error(`${method} ${path} returned ${status}`), { status });
      return { status, json };
    };
    let m = /^\/users\/([^?]+)\?/.exec(path);
    if (method === 'GET' && m) return users[decodeURIComponent(m[1])] ? respond(200, users[decodeURIComponent(m[1])]) : respond(404, { error: { code: 'Request_ResourceNotFound' } });
    m = /^\/servicePrincipals\/([^/]+)\/appRoleAssignedTo\?.*?(?:&skip=(\d+))?$/.exec(path);
    if (method === 'GET' && m) {
      assert.equal(m[1], SP);
      const from = Number(m[2] ?? 0);
      const page = state.assignments.slice(from, from + pageSize);
      const more = from + pageSize < state.assignments.length;
      return respond(200, { value: page, ...(more ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/servicePrincipals/${SP}/appRoleAssignedTo?$top=${pageSize}&skip=${from + pageSize}` } : {}) });
    }
    if (method === 'POST' && path === `/servicePrincipals/${SP}/appRoleAssignedTo`) {
      const created = { id: `asg-${state.next++}`, principalDisplayName: 'x', ...body };
      state.assignments.push(created);
      return respond(201, created);
    }
    m = new RegExp(`^/servicePrincipals/${SP}/appRoleAssignedTo/([^/?]+)$`).exec(path);
    if (method === 'DELETE' && m) {
      state.assignments = state.assignments.filter((a) => a.id !== m[1]);
      return respond(204, null);
    }
    throw new Error(`unexpected Graph call ${method} ${path}`);
  };
  graph.calls = calls;
  graph.state = state;
  return graph;
}
const writes = (graph) => graph.calls.filter((c) => c.method !== 'GET');
const held = (graph, principalId, appRoleId) => graph.state.assignments.filter((a) => a.principalId === principalId && a.appRoleId === appRoleId && a.resourceId === SP);

test('T-53 --role grants the role once, a second run changes nothing, and --remove takes it away', async () => {
  const graph = fakeGraph({ assignments: [{ id: 'asg-other', principalId: 'user-other', appRoleId: 'role-standard', resourceId: SP }] });
  const first = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: 'dev@contoso.com', role: 'Gateway.Standard' });
  assert.equal(first.changed, true);
  assert.match(first.message, /Gateway\.Standard granted to Dev One \(dev@contoso\.com\)/);
  assert.deepEqual(writes(graph).map((c) => c.body), [{ principalId: 'user-dev', resourceId: SP, appRoleId: 'role-standard' }]);
  const second = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: 'dev@contoso.com', role: 'Gateway.Standard' });
  assert.equal(second.changed, false);
  assert.match(second.message, /already holds/);
  assert.equal(held(graph, 'user-dev', 'role-standard').length, 1);
  const removed = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, upn: 'dev@contoso.com', role: 'Gateway.Standard', remove: true });
  assert.equal(removed.changed, true);
  assert.equal(held(graph, 'user-dev', 'role-standard').length, 0);
  assert.equal(held(graph, 'user-other', 'role-standard').length, 1, 'another user keeps the role');
});

test('T-53 a user who holds one role gets the other, and losing one keeps the other', async () => {
  const graph = fakeGraph({ assignments: [{ id: 'asg-std', principalId: 'user-dev', appRoleId: 'role-standard', resourceId: SP }] });
  const granted = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: 'dev@contoso.com', role: 'Gateway.Premium' });
  assert.equal(granted.changed, true);
  assert.equal(held(graph, 'user-dev', 'role-premium').length, 1);
  const removed = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, upn: 'dev@contoso.com', role: 'Gateway.Premium', remove: true });
  assert.equal(removed.changed, true);
  assert.equal(held(graph, 'user-dev', 'role-premium').length, 0);
  assert.equal(held(graph, 'user-dev', 'role-standard').length, 1, 'the other role stays');
});

test('T-53 the assignment listing is read across pages, so a held role on page two is found', async () => {
  const graph = fakeGraph({ pageSize: 1, assignments: [
    { id: 'asg-a', principalId: 'user-a', appRoleId: 'role-standard', resourceId: SP },
    { id: 'asg-dev', principalId: 'user-dev', appRoleId: 'role-premium', resourceId: SP },
  ] });
  const r = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: 'dev@contoso.com', role: 'Gateway.Premium' });
  assert.equal(r.changed, false);
  assert.deepEqual(writes(graph), []);
});

test('T-53 a guest UPN is encoded in the Graph path', async () => {
  const graph = fakeGraph();
  const r = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: GUEST, role: 'Gateway.Standard' });
  assert.equal(r.changed, true);
  assert.ok(graph.calls[0].path.startsWith('/users/dev_contoso.com%23EXT%23%40tenant.onmicrosoft.com?'), graph.calls[0].path);
});

test('T-53 an unknown role stops before any Graph call, and an unknown user changes nothing', async () => {
  const graph = fakeGraph();
  await assert.rejects(setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: 'dev@contoso.com', role: 'Gateway.Admin' }), /Gateway\.Admin is not an app role.*Gateway\.Standard, Gateway\.Premium/);
  assert.deepEqual(graph.calls, []);
  await assert.rejects(setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles, upn: 'nobody@contoso.com', role: 'Gateway.Standard' }), /no user nobody@contoso\.com/);
  assert.deepEqual(writes(graph), []);
});

test('T-53 a grant without the roles the gateway admits is refused before any Graph call; a removal needs none', async () => {
  const graph = fakeGraph({ assignments: [{ id: 'asg-s', principalId: 'user-dev', appRoleId: 'role-standard', resourceId: SP }] });
  await assert.rejects(setDeveloper({ graph, servicePrincipalId: SP, appRoles, upn: 'dev@contoso.com', role: 'Gateway.Standard' }), /needs the roles the gateway admits/);
  assert.deepEqual(graph.calls, []);
  assert.equal((await setDeveloper({ graph, servicePrincipalId: SP, appRoles, upn: 'dev@contoso.com', role: 'Gateway.Standard', remove: true })).changed, true);
});

// The command line, with Graph and the deployment state injected: the admin file given with --admin decides what may be
// granted, and it is read and checked before any Graph request (Architect and QA review, round 3).
function adminFile(t, admin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-admin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'admin.json');
  fs.writeFileSync(file, typeof admin === 'string' ? admin : JSON.stringify(admin));
  return file;
}
const deps = (graph) => ({ graph, readState: () => ({ servicePrincipal: { id: SP } }), appRoles });
const models = [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }];

test('T-53 the CLI grants only a role that the --admin file admits, and refuses another before any Graph request', async (t) => {
  const file = adminFile(t, { roles: ['Gateway.Standard'], models });
  const refused = fakeGraph();
  await assert.rejects(main(['--upn', 'dev@contoso.com', '--role', 'Gateway.Premium', '--admin', file], deps(refused)),
    /does not admit Gateway\.Premium: .*admin\.json lists Gateway\.Standard/);
  assert.deepEqual(refused.calls, []);
  const granted = fakeGraph();
  assert.match(await main(['--upn', 'dev@contoso.com', '--role', 'Gateway.Standard', '--admin', file], deps(granted)), /Gateway\.Standard granted to Dev One/);
  assert.equal(writes(granted).length, 1);
});

test('T-53 the CLI stops on an admin file that fails the renderer\'s validation, before any Graph request', async (t) => {
  for (const admin of ['{ "roles": [', { roles: [], models }, { roles: ['Gateway.Unknown'], models }]) {
    const graph = fakeGraph();
    await assert.rejects(main(['--upn', 'dev@contoso.com', '--role', 'Gateway.Standard', '--admin', adminFile(t, admin)], deps(graph)), /admin\.json (is not readable JSON|has \d+ problem)/);
    assert.deepEqual(graph.calls, []);
  }
});

test('T-53 --remove deletes only an assignment of the gateway app, and reports a role the user does not hold', async () => {
  const graph = fakeGraph({ assignments: [{ id: 'asg-foreign', principalId: 'user-dev', appRoleId: 'role-standard', resourceId: 'sp-other-app' }] });
  const r = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, upn: 'dev@contoso.com', role: 'Gateway.Standard', remove: true });
  assert.equal(r.changed, false);
  assert.match(r.message, /does not hold Gateway\.Standard/);
  assert.deepEqual(writes(graph), []);
  assert.equal(graph.state.assignments.length, 1);
});

test('T-53 a role the admin file does not admit is not granted, and can still be removed', async () => {
  const graph = fakeGraph({ assignments: [{ id: 'asg-p', principalId: 'user-dev', appRoleId: 'role-premium', resourceId: SP }] });
  await assert.rejects(setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles: ['Gateway.Standard'], upn: 'dev@contoso.com', role: 'Gateway.Premium' }),
    /does not admit Gateway\.Premium: .* lists Gateway\.Standard/);
  assert.deepEqual(writes(graph), []);
  const removed = await setDeveloper({ graph, servicePrincipalId: SP, appRoles, admittedRoles: ['Gateway.Standard'], upn: 'dev@contoso.com', role: 'Gateway.Premium', remove: true });
  assert.equal(removed.changed, true);
});
test('T-53 --list names each holder of each gateway role, and ignores assignments of other roles', async () => {
  const graph = fakeGraph({ assignments: [
    { id: 'asg-1', principalId: 'user-a', principalDisplayName: 'Ada', appRoleId: 'role-premium', resourceId: SP },
    { id: 'asg-2', principalId: 'user-b', principalDisplayName: 'Bo', appRoleId: 'role-standard', resourceId: SP },
    { id: 'asg-3', principalId: 'user-c', principalDisplayName: 'Cy', appRoleId: '00000000-0000-0000-0000-000000000000', resourceId: SP },
  ] });
  const rows = await listDevelopers({ graph, servicePrincipalId: SP, appRoles });
  assert.deepEqual(rows, [
    { role: 'Gateway.Standard', name: 'Bo', principalId: 'user-b' },
    { role: 'Gateway.Premium', name: 'Ada', principalId: 'user-a' },
  ]);
});
