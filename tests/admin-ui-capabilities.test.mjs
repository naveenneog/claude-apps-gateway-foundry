// T-102: admin-ui/server/capabilities.mjs - what admin-ui's identity may do, from the roles claim of its app-only
// Microsoft Graph token (U-88) and the Azure RBAC permissions API on the gateway app
// (https://learn.microsoft.com/en-us/rest/api/authorization/permissions/list-for-resource).
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionAllowed, capabilities, environmentPermissions, gatewayIdentityPermissions, tokenRoles } from '../admin-ui/server/capabilities.mjs';

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('T-102 tokenRoles reads the roles claim of a JWT and is empty when it has none', () => {
  assert.deepEqual(tokenRoles(jwt({ roles: ['User.Read.All', 'Application.Read.All'] })), ['User.Read.All', 'Application.Read.All']);
  assert.deepEqual(tokenRoles(jwt({ aud: 'x' })), []);
  assert.deepEqual(tokenRoles('not-a-jwt'), []);
});

test('T-102 actionAllowed honours wildcards and notActions, case-insensitively', () => {
  const perms = [{ actions: ['Microsoft.App/containerApps/*'], notActions: ['Microsoft.App/containerApps/delete'] }];
  assert.equal(actionAllowed(perms, 'Microsoft.App/containerApps/write'), true);
  assert.equal(actionAllowed(perms, 'microsoft.app/containerapps/listSecrets/action'), true);
  assert.equal(actionAllowed(perms, 'Microsoft.App/containerApps/delete'), false);
  assert.equal(actionAllowed(perms, 'Microsoft.Web/sites/write'), false);
  assert.equal(actionAllowed([{ actions: ['*/read'], notActions: [] }], 'Microsoft.App/containerApps/read'), true);
  assert.equal(actionAllowed([{ actions: ['*/read'], notActions: [] }], 'Microsoft.App/containerApps/write'), false);
});

test('T-166 the published Container Apps Contributor patterns include the gateway itself and its children', async () => {
  const permissions = [{ actions: [
    'Microsoft.Authorization/*/read',
    'Microsoft.App/containerApps/*/read',
    'Microsoft.App/containerApps/*/write',
    'Microsoft.App/containerApps/*/action',
  ], notActions: [] }];
  for (const action of ['read', 'write', 'listSecrets/action', 'revisions/read', 'revisions/replicas/read']) {
    assert.equal(actionAllowed(permissions, `Microsoft.App/containerApps/${action}`), true, action);
  }
  const result = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => permissions,
    signIn: { mode: 'required', isAdmin: true } });
  assert.deepEqual(result.arm, { readGateway: true, writeGateway: true, joinEnvironment: false, assignGatewayIdentity: false });
  assert.equal(actionAllowed(permissions, 'Microsoft.App/jobs/write'), false);
  assert.equal(actionAllowed(permissions, 'Microsoft.App/containerAppsOther/write'), false);
});

test('T-166 zero-segment wildcards retain exclusions and do not invent write permissions', () => {
  const actions = ['Microsoft.App/containerApps/*/read', 'Microsoft.App/containerApps/*/write'];
  assert.equal(actionAllowed([{ actions, notActions: ['Microsoft.App/containerApps/*/write'] }], 'Microsoft.App/containerApps/write'), false);
  assert.equal(actionAllowed([{ actions, notActions: ['Microsoft.App/containerApps/*/write'] }], 'Microsoft.App/containerApps/revisions/write'), false);
  assert.equal(actionAllowed([{ actions: ['Microsoft.App/containerApps/*/read'] }], 'Microsoft.App/containerApps/write'), false);
  assert.equal(actionAllowed([{ actions: ['Microsoft.App/containerApps/revisions/*/read'] }], 'Microsoft.App/containerApps/read'), false);
  assert.equal(actionAllowed([{ actions, notActions: ['Microsoft.App/containerApps/*'] }, { actions: ['Microsoft.App/containerApps/write'] }],
    'Microsoft.App/containerApps/write'), true, 'another role can grant an action excluded from the first role');
});

test('T-102 each capability is granted exactly when its Graph role or ARM actions are present', async () => {
  const signIn = { mode: 'required', user: { name: 'A', upn: 'a@x' }, isAdmin: true };
  const none = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => [], signIn });
  assert.ok(none.items.every((i) => i.key === 'signIn' || i.granted === false), JSON.stringify(none.items));
  assert.deepEqual(none.graph, { readUsers: false, assignRoles: false, readApps: false, writeOwnedApps: false });
  assert.deepEqual(none.arm, { readGateway: false, writeGateway: false, joinEnvironment: false, assignGatewayIdentity: false });

  const all = await capabilities({
    graphToken: async () => jwt({ roles: ['User.Read.All', 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All', 'Application.ReadWrite.OwnedBy', 'User.ReadWrite.All'] }),
    armPermissions: async () => [{ actions: ['Microsoft.App/containerApps/*'], notActions: [] }],
    environmentPermissions: async () => [{ actions: ['Microsoft.App/managedEnvironments/join/action'], notActions: [] }],
    gatewayIdentityPermissions: async () => [[{ actions: ['Microsoft.ManagedIdentity/userAssignedIdentities/*/assign/action'], notActions: [] }]],
    signIn,
  });
  assert.deepEqual(all.graph, { readUsers: true, assignRoles: true, readApps: true, writeOwnedApps: true });
  assert.deepEqual(all.arm, { readGateway: true, writeGateway: true, joinEnvironment: true, assignGatewayIdentity: true });
  for (const item of all.items) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.unlocks.length > 10, item.key);
    assert.ok(item.howToGrant.length > 10, item.key);
  }

  const readOnlyArm = await capabilities({ graphToken: async () => jwt({ roles: ['User.ReadWrite.All'] }), armPermissions: async () => [{ actions: ['*/read'], notActions: [] }], signIn });
  assert.deepEqual(readOnlyArm.arm, { readGateway: true, writeGateway: false, joinEnvironment: false, assignGatewayIdentity: false }, 'write also needs listSecrets/action and write');
  assert.equal(readOnlyArm.graph.readUsers, true, 'User.ReadWrite.All includes reading users');
});

test('T-102 permission help uses Azure Portal steps where available and does not invent a Portal Graph grant', async () => {
  const r = await capabilities({
    graphToken: async () => jwt({ roles: [] }),
    armPermissions: async () => [],
    signIn: { mode: 'off', user: null, isAdmin: false },
  });
  const how = Object.fromEntries(r.items.map((item) => [item.key, item.howToGrant]));
  assert.match(how['arm.writeGateway'], /Azure Portal.*Access control \(IAM\).*Add role assignment/i);
  assert.match(how.signIn, /App registrations.*AdminUi\.Admin.*App roles/i);
  assert.match(how.signIn, /must exist|create.*role/i);
  assert.match(how.signIn, /Enterprise applications.*Users and groups/i);
  assert.match(how['graph.readUsers'], /no.*Portal.*workflow|Portal.*not.*available/i);
  assert.match(how['graph.readUsers'], /graph\/permissions-grant-via-msgraph/);
  assert.doesNotMatch(JSON.stringify(r.items), /pwsh -File|Deploy-AdminUi\.ps1/);
});

test('T-169 saving also needs join on the gateway environment, reported as its own item with the Operator grant', async () => {
  const signIn = { mode: 'required', isAdmin: true };
  const app = async () => [{ actions: ['Microsoft.App/containerApps/*'], notActions: [] }];
  const missing = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: app, environmentPermissions: async () => [{ actions: ['*/read'] }], signIn });
  assert.equal(missing.arm.joinEnvironment, false);
  const item = missing.items.find((i) => i.key === 'arm.joinEnvironment');
  assert.equal(item.granted, false);
  assert.match(item.howToGrant, /Container Apps environment.*Access control \(IAM\).*Container Apps Operator.*id-admin-ui/);
  const operator = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: app, signIn,
    environmentPermissions: async () => [{ actions: ['Microsoft.App/managedEnvironments/read', 'Microsoft.App/managedEnvironments/join/action'] }] });
  assert.equal(operator.arm.joinEnvironment, true);
  const failed = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: app, signIn, environmentPermissions: async () => { throw new Error('no environment'); } });
  assert.equal(failed.arm.joinEnvironment, false);
  assert.ok(failed.problems.some((p) => /gateway environment: no environment/.test(p)));
});

test('T-170 saving needs assign/action on every attached user-assigned gateway identity', async () => {
  const identityId = '/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-claude-gw';
  const calls = [];
  const arm = async (method, path) => {
    calls.push(path);
    if (path === '/gateway?api-version=2024-03-01') return { json: { identity: { userAssignedIdentities: { [identityId]: {} } } } };
    return { json: { value: [{ actions: ['Microsoft.ManagedIdentity/userAssignedIdentities/*/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/*/assign/action'], notActions: [] }] } };
  };
  const permissions = await gatewayIdentityPermissions({ arm, resourceId: '/gateway' });
  assert.equal(permissions.length, 1);
  assert.equal(calls[1], `${identityId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
  const result = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => [],
    gatewayIdentityPermissions: async () => permissions, signIn: { mode: 'required', isAdmin: true } });
  assert.equal(result.arm.assignGatewayIdentity, true);
  assert.equal(result.items.find((i) => i.key === 'arm.assignGatewayIdentity').granted, true);
  const missing = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => [],
    gatewayIdentityPermissions: async () => [[{ actions: ['Microsoft.ManagedIdentity/userAssignedIdentities/*/read'], notActions: [] }]],
    signIn: { mode: 'required', isAdmin: true } });
  assert.equal(missing.arm.assignGatewayIdentity, false);
  assert.match(missing.items.find((i) => i.key === 'arm.assignGatewayIdentity').howToGrant, /Managed Identity Operator.*id-claude-gw/);
  const secondId = `${identityId}-secondary`;
  const both = await gatewayIdentityPermissions({ arm: async (_method, path) => ({
    json: path === '/gateway?api-version=2024-03-01'
      ? { identity: { userAssignedIdentities: { [identityId]: {}, [secondId]: {} } } }
      : { value: path.includes('id-claude-gw-secondary')
        ? [{ actions: ['Microsoft.ManagedIdentity/userAssignedIdentities/*/read'], notActions: [] }]
        : [{ actions: ['Microsoft.ManagedIdentity/userAssignedIdentities/*/assign/action'], notActions: [] }] },
  }), resourceId: '/gateway' });
  assert.equal((await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => [],
    gatewayIdentityPermissions: async () => both, signIn: { mode: 'required', isAdmin: true } })).arm.assignGatewayIdentity, false,
  'all attached identities must allow assign/action');
  for (const bad of ['/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/a', 'https://evil.example/identity', '/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/a?x=1']) {
    await assert.rejects(gatewayIdentityPermissions({ arm: async () => ({ json: { identity: { userAssignedIdentities: { [bad]: {} } } } }), resourceId: '/gateway' }), /no valid user-assigned identity/);
  }
});

test('T-169 environmentPermissions reads the environment the gateway app names, and refuses anything but an environment resource ID', async () => {
  const env = '/subscriptions/s1/resourceGroups/rg-1/providers/Microsoft.App/managedEnvironments/cae-claude-gw';
  const calls = [];
  const armFor = (environmentId) => async (method, path) => {
    calls.push(path);
    if (path.includes('/providers/Microsoft.Authorization/permissions')) return { json: { value: [{ actions: ['x'] }] } };
    return { json: { properties: { managedEnvironmentId: environmentId } } };
  };
  assert.deepEqual(await environmentPermissions({ arm: armFor(env), resourceId: '/subscriptions/s1/resourceGroups/rg-1/providers/Microsoft.App/containerApps/ca-claude-gw' }), [{ actions: ['x'] }]);
  assert.equal(calls[1], `${env}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
  for (const bad of ['https://evil.example/x', `${env}/../../other`, `${env}?x=1`, '/subscriptions/s1/resourceGroups/rg-1/providers/Microsoft.Web/sites/a', undefined]) {
    calls.length = 0;
    await assert.rejects(environmentPermissions({ arm: armFor(bad), resourceId: 'r' }), /Container Apps environment/, String(bad));
    assert.equal(calls.length, 1, `no second request for ${bad}`);
  }
});

test('T-102 a failing token or permissions call reports the capability as missing with the reason, not a crash', async () => {
  const r = await capabilities({ graphToken: async () => { throw new Error('no identity'); }, armPermissions: async () => { throw new Error('403 AuthorizationFailed'); }, signIn: { mode: 'off', user: null, isAdmin: false } });
  assert.equal(r.graph.readUsers, false);
  assert.equal(r.arm.writeGateway, false);
  assert.ok(r.problems.some((p) => /no identity/.test(p)) && r.problems.some((p) => /AuthorizationFailed/.test(p)));
  assert.equal(r.items.find((i) => i.key === 'signIn').granted, false);
  const forged = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => [], signIn: { mode: 'off', user: null, isAdmin: true } });
  assert.equal(forged.items.find((i) => i.key === 'signIn').granted, false, 'admin sign-in is never granted while sign-in is off');
});

test('T-146 the permissions view does not ask for User.ReadWrite.All, and reports the business-unit tag store instead', async () => {
  const signIn = { mode: 'required', user: { name: 'A', upn: 'a@x' }, isAdmin: true };
  const base = { graphToken: async () => jwt({ roles: ['User.Read.All'] }), armPermissions: async () => [], signIn };
  const on = await capabilities({ ...base, tagsStatus: async () => ({ available: true }) });
  assert.ok(!JSON.stringify(on.items).includes('User.ReadWrite.All'), 'no item names User.ReadWrite.All');
  const tags = on.items.find((i) => i.key === 'database.tags');
  assert.equal(tags.granted, true);
  assert.match(tags.unlocks, /department.*cost center.*company.*office.*division/i);
  const off = await capabilities({ ...base, tagsStatus: async () => ({ available: false, reason: 'needs the managed database' }) });
  const offItem = off.items.find((i) => i.key === 'database.tags');
  assert.equal(offItem.granted, false);
  assert.match(offItem.howToGrant, /managed database/);
  assert.ok(off.problems.some((p) => /needs the managed database/.test(p)));
});
