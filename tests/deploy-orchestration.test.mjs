import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployTemplate } from '../infra/azure-test/deploy.mjs';

// deployTemplate with its Azure calls and its state writes replaced (Architect and Coder review, round 3).
const account = (rg, name) => `/subscriptions/s/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${name}`;
const grantOn = (rg, name) => `${account(rg, name)}/providers/Microsoft.Authorization/roleAssignments/g1`;
const OUTPUTS = {
  acrName: 'cr1', acrLoginServer: 'cr1.azurecr.io', appName: 'ca-claude-gw', environmentName: 'cae-claude-gw', gatewayFqdn: 'ca.example',
  identityId: '/id/1', identityClientId: 'client-1', identityPrincipalId: 'principal-1', workspaceName: 'log-1', workspaceCustomerId: 'ws-1',
  foundryRoleAssignmentId: grantOn('rg-b', 'ai-b'),
};
const deployed = (outputs) => ({ properties: { outputs: Object.fromEntries(Object.entries(outputs).map(([k, value]) => [k, { value }])) } });

function harness({ whatIf = false, run } = {}) {
  const calls = [];
  const saves = [];
  const ctx = {
    group: 'rg-unit', groupPath: '/subscriptions/s/resourceGroups/rg-unit',
    opts: { testerCidr: '203.0.113.0/26', 'foundry-resource-group': 'rg-b', 'foundry-account': 'ai-b', 'what-if': whatIf },
    state: { runId: 'run-1', foundryTargets: [{ resourceGroup: 'rg-a', account: 'ai-a' }], foundryRoleAssignmentId: grantOn('rg-a', 'ai-a') },
  };
  const io = {
    validateDeployment: async () => { calls.push('validate'); },
    whatIfDeployment: async () => { calls.push('whatIf'); return []; },
    runDeployment: async () => { calls.push('run'); return run(); },
    save: (c) => { calls.push('save'); saves.push(structuredClone(c.state)); },
  };
  return { ctx, io, calls, saves };
}

test('deployTemplate records the Foundry target before the deployment runs, so a failed app deployment still leaves it for teardown', async () => {
  const { ctx, io, calls, saves } = harness({ run: () => { throw new Error('app deployment failed'); } });
  await assert.rejects(deployTemplate(ctx, { deployApp: true }, io), /app deployment failed/);
  assert.deepEqual(calls, ['validate', 'whatIf', 'save', 'run']);
  assert.deepEqual(saves[0].foundryTargets, [{ resourceGroup: 'rg-a', account: 'ai-a' }, { resourceGroup: 'rg-b', account: 'ai-b' }]);
});

test('deployTemplate takes the grant and the other outputs from every successful deployment, app included', async () => {
  const { ctx, io, calls, saves } = harness({ run: () => deployed(OUTPUTS) });
  const out = await deployTemplate(ctx, { deployApp: true }, io);
  assert.equal(out.foundryRoleAssignmentId, grantOn('rg-b', 'ai-b'));
  assert.equal(ctx.state.foundryRoleAssignmentId, grantOn('rg-b', 'ai-b'), 'the upstream check removes the grant the app now uses');
  assert.deepEqual(ctx.state.identity, { id: '/id/1', clientId: 'client-1', principalId: 'principal-1' });
  assert.deepEqual(calls, ['validate', 'whatIf', 'save', 'run', 'save']);
  assert.equal(saves.at(-1).foundryRoleAssignmentId, grantOn('rg-b', 'ai-b'));
});

test('deployTemplate refuses outputs that miss a field, instead of writing undefined into the state', async () => {
  const { acrName, ...partial } = OUTPUTS;
  const { ctx, io } = harness({ run: () => deployed(partial) });
  await assert.rejects(deployTemplate(ctx, { deployApp: false }, io), /acrName/);
  assert.equal(ctx.state.acrName, undefined);
});

test('deployTemplate clears a restore record for the Foundry grant it has just deployed again, and only that one', async () => {
  const same = harness({ run: () => deployed(OUTPUTS) });
  same.ctx.state.pendingRestore = { kind: 'armRole', phase: 'restoring', assignmentId: grantOn('rg-b', 'ai-b').toUpperCase(), principalId: 'principal-1' };
  await deployTemplate(same.ctx, { deployApp: false }, same.io);
  assert.equal(same.ctx.state.pendingRestore, undefined);
  for (const pending of [{ kind: 'armRole', phase: 'removed', assignmentId: grantOn('rg-a', 'ai-a') }, { kind: 'appRole', phase: 'removed' }]) {
    const other = harness({ run: () => deployed(OUTPUTS) });
    other.ctx.state.pendingRestore = pending;
    await deployTemplate(other.ctx, { deployApp: false }, other.io);
    assert.deepEqual(other.ctx.state.pendingRestore, pending, JSON.stringify(pending));
  }
});

test('deployTemplate with --what-if previews and writes nothing', async () => {
  const { ctx, io, calls } = harness({ whatIf: true, run: () => deployed(OUTPUTS) });
  assert.equal(await deployTemplate(ctx, { deployApp: true }, io), null);
  assert.deepEqual(calls, ['validate', 'whatIf']);
  assert.deepEqual(ctx.state.foundryTargets, [{ resourceGroup: 'rg-a', account: 'ai-a' }]);
});
