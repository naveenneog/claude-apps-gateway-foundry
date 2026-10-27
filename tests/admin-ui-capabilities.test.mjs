// T-102: admin-ui/server/capabilities.mjs - what admin-ui's identity may do, from the roles claim of its app-only
// Microsoft Graph token (U-88) and the Azure RBAC permissions API on the gateway app
// (https://learn.microsoft.com/en-us/rest/api/authorization/permissions/list-for-resource).
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionAllowed, capabilities, tokenRoles } from '../admin-ui/server/capabilities.mjs';

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

test('T-102 each capability is granted exactly when its Graph role or ARM actions are present', async () => {
  const signIn = { mode: 'required', user: { name: 'A', upn: 'a@x' }, isAdmin: true };
  const none = await capabilities({ graphToken: async () => jwt({ roles: [] }), armPermissions: async () => [], signIn });
  assert.ok(none.items.every((i) => i.key === 'signIn' || i.granted === false), JSON.stringify(none.items));
  assert.deepEqual(none.graph, { readUsers: false, assignRoles: false, readApps: false, writeOwnedApps: false });
  assert.deepEqual(none.arm, { readGateway: false, writeGateway: false });

  const all = await capabilities({
    graphToken: async () => jwt({ roles: ['User.Read.All', 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All', 'Application.ReadWrite.OwnedBy', 'User.ReadWrite.All'] }),
    armPermissions: async () => [{ actions: ['Microsoft.App/containerApps/*'], notActions: [] }],
    signIn,
  });
  assert.deepEqual(all.graph, { readUsers: true, assignRoles: true, readApps: true, writeOwnedApps: true });
  assert.deepEqual(all.arm, { readGateway: true, writeGateway: true });
  for (const item of all.items) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.unlocks.length > 10, item.key);
    assert.ok(item.howToGrant.length > 10, item.key);
  }

  const readOnlyArm = await capabilities({ graphToken: async () => jwt({ roles: ['User.ReadWrite.All'] }), armPermissions: async () => [{ actions: ['*/read'], notActions: [] }], signIn });
  assert.deepEqual(readOnlyArm.arm, { readGateway: true, writeGateway: false }, 'write also needs listSecrets/action and write');
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
