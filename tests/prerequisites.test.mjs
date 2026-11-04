import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entraRights, foundryNetworkProblem, permits, toolProblems } from '../infra/azure-test/lib/prerequisites.mjs';
import { runPreflight } from '../infra/azure-test/lib/preflight.mjs';

// T-163 (P-48, 2026-11-04): every prerequisite of the tutorial's "Before you begin" that can be read is checked by
// preflight, so -Plan reports it before anything is built.
const OWNER = [{ actions: ['*'], notActions: [] }];
const CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action'] }];
const READER = [{ actions: ['*/read'], notActions: [] }];
const ROLE_WRITE = 'Microsoft.Authorization/roleAssignments/write';

test('T-163 permits: ARM wildcard actions and notActions, case-insensitive', () => {
  assert.equal(permits(OWNER, ROLE_WRITE), true);
  assert.equal(permits(CONTRIBUTOR, ROLE_WRITE), false, 'Contributor cannot assign roles');
  assert.equal(permits(CONTRIBUTOR, 'Microsoft.Resources/subscriptions/resourceGroups/write'), true);
  assert.equal(permits(READER, 'Microsoft.Resources/subscriptions/resourceGroups/write'), false);
  assert.equal(permits([...CONTRIBUTOR, { actions: ['Microsoft.Authorization/roleAssignments/*'], notActions: [] }], ROLE_WRITE), true, 'Contributor plus User Access Administrator');
  assert.equal(permits([], ROLE_WRITE), false);
});

test('T-163 toolProblems: Node.js 22, Azure CLI 2.60 and the containerapp extension', () => {
  assert.deepEqual(toolProblems({ node: '22.11.0', az: { 'azure-cli': '2.77.0', extensions: { containerapp: '1.2.0' } } }), []);
  const problems = toolProblems({ node: '20.9.0', az: { 'azure-cli': '2.59.9', extensions: {} } });
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /Node\.js 20\.9\.0.*22/);
  assert.match(problems.join('\n'), /Azure CLI 2\.59\.9.*2\.60/);
  assert.match(problems.join('\n'), /az extension add --name containerapp/);
  assert.match(toolProblems({ node: '22.0.0', az: null }).join(), /Azure CLI/);
});

const GA = '62e90394-69f5-4237-9190-012177145e10';
const APP_ADMIN = '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3';
const PRA = 'e8611ab8-c189-46e8-94e1-60213ab1f814';
test('T-163 entraRights: who may register the app, and who may grant the console its Graph permissions', () => {
  assert.deepEqual(entraRights({ roles: [], allowedToCreateApps: true }), { canRegister: true, canGrant: false });
  assert.deepEqual(entraRights({ roles: [], allowedToCreateApps: false }), { canRegister: false, canGrant: false });
  assert.deepEqual(entraRights({ roles: [APP_ADMIN], allowedToCreateApps: false }), { canRegister: true, canGrant: false });
  assert.deepEqual(entraRights({ roles: [PRA], allowedToCreateApps: false }), { canRegister: false, canGrant: true });
  assert.deepEqual(entraRights({ roles: [GA], allowedToCreateApps: false }), { canRegister: true, canGrant: true });
});

test('T-163 foundryNetworkProblem: public access off, or an endpoint subdomain other than the account name', () => {
  assert.equal(foundryNetworkProblem({ name: 'ai-x', properties: { publicNetworkAccess: 'Enabled', customSubDomainName: 'ai-x' } }), null);
  assert.match(foundryNetworkProblem({ name: 'ai-x', properties: { publicNetworkAccess: 'Disabled', customSubDomainName: 'ai-x' } }), /public network access/);
  assert.match(foundryNetworkProblem({ name: 'ai-x', properties: { publicNetworkAccess: 'Enabled', customSubDomainName: 'other' } }), /subdomain other/);
});

const SUB = '/subscriptions/s';
const PERM = 'providers/Microsoft.Authorization/permissions';
function fakes({ perms = OWNER, foundryPerms = OWNER, providers = 'Registered', roles = [GA], allowed = true, account = { publicNetworkAccess: 'Enabled', customSubDomainName: 'ai-x' } } = {}) {
  const arm = async (method, path, body, { ok = [200] } = {}) => {
    if (method !== 'GET') throw new Error('GET only');
    const p = path.split('?')[0];
    const reply = (status, json) => { if (!ok.includes(status)) throw Object.assign(new Error(String(status)), { status }); return { status, json }; };
    if (p.endsWith(`/accounts/ai-x/${PERM}`)) return reply(200, { value: foundryPerms });
    if (p.endsWith(PERM)) return reply(200, { value: perms });
    if (p.endsWith('/resourceGroups/rg-gw')) return reply(404, {});
    if (p.endsWith('/accounts/ai-x')) return reply(200, { name: 'ai-x', properties: account });
    if (p.endsWith('/accounts/ai-x/deployments')) return reply(200, { value: [{ name: 'claude-sonnet-5' }] });
    if (/\/providers\/Microsoft\.[A-Za-z]+$/.test(p)) return reply(200, { registrationState: providers });
    return reply(404, {});
  };
  const graph = async (method, path) => {
    if (path.startsWith('/me/memberOf')) return { status: 200, json: { value: roles.map((roleTemplateId) => ({ roleTemplateId })) } };
    if (path.startsWith('/policies/authorizationPolicy')) return { status: 200, json: { defaultUserRolePermissions: { allowedToCreateApps: allowed } } };
    throw new Error(path);
  };
  return { arm, graph };
}
const INPUT = { subscriptionPath: SUB, groupPath: `${SUB}/resourceGroups/rg-gw`, group: 'rg-gw', location: 'eastus2', foundry: { resourceGroup: 'rg-ai', account: 'ai-x' },
  models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }], database: 'sidecar', signedIn: { mail: 'a@contoso.example', upn: 'a@contoso.example' },
  tools: { node: '22.11.0', az: { 'azure-cli': '2.77.0', extensions: { containerapp: '1.2.0' } } } };

test('T-163 runPreflight with every prerequisite met prints a PASS line for each', async () => {
  const r = await runPreflight({ ...fakes(), ...INPUT });
  assert.equal(r.ok, true, r.lines.join('\n'));
  const text = r.lines.join('\n');
  for (const re of [/PASS +tools:/, /PASS +Azure role:.*create the resource group and assign roles/, /PASS +Foundry account ai-x: the signed-in account may give the gateway's identity a role/,
    /PASS +Foundry account ai-x: reachable from public networks/, /PASS +resource providers:/, /PASS +Entra: may register the gateway's app/, /PASS +Entra: may grant the admin console/]) assert.match(text, re);
});

test('T-163 runPreflight fails, naming the fix, on each missing prerequisite; a missing grant role is a warning', async () => {
  const cases = [
    [{ perms: CONTRIBUTOR }, {}, /FAIL +Azure role: .*cannot assign roles.*Owner/],
    [{ perms: READER }, {}, /FAIL +Azure role: .*cannot create the resource group/],
    [{ foundryPerms: CONTRIBUTOR }, {}, /FAIL +Foundry account ai-x: .*cannot give the gateway's identity a role/],
    [{ account: { publicNetworkAccess: 'Disabled', customSubDomainName: 'ai-x' } }, {}, /FAIL +Foundry account ai-x: public network access/],
    [{ roles: [], allowed: false }, {}, /FAIL +Entra: .*may not register applications.*Application Administrator/],
    [{}, { tools: { node: '20.1.0', az: { 'azure-cli': '2.77.0', extensions: { containerapp: '1' } } } }, /FAIL +tools: Node\.js 20\.1\.0/],
  ];
  for (const [f, extra, re] of cases) {
    const r = await runPreflight({ ...fakes(f), ...INPUT, ...extra });
    assert.equal(r.ok, false, String(re));
    assert.match(r.lines.join('\n'), re);
  }
  const noGrant = await runPreflight({ ...fakes({ roles: [APP_ADMIN] }), ...INPUT });
  assert.equal(noGrant.ok, true, 'the rest of the install works without it');
  assert.match(noGrant.lines.join('\n'), /WARN +Entra: .*Privileged Role Administrator.*admin-ui/);
  const unregistered = await runPreflight({ ...fakes({ providers: 'NotRegistered' }), ...INPUT });
  assert.match(unregistered.lines.join('\n'), /WARN +resource providers: .*az provider register --namespace Microsoft\.App/);
  const recorded = await runPreflight({ ...fakes({ roles: [], allowed: false }), ...INPUT, state: { application: { id: 'x', appId: 'y' } } });
  assert.match(recorded.lines.join('\n'), /PASS +Entra: the gateway's app registration exists/);
});
