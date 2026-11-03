import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDecision, nameClashes, teardownTiers } from '../infra/azure-test/lib/existing-group.mjs';

const RUN = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const PURPOSE = 'claude-apps-gateway-test';
const res = (type, name, runId) => ({ id: `/subscriptions/s/resourceGroups/rg/providers/${type}/${name}`, type, name, tags: runId ? { purpose: PURPOSE, runId } : {} });

test('T-156 groupDecision: a missing group is created; this tool\'s own group is used; any other group needs the option', () => {
  assert.deepEqual(groupDecision({ status: 404, tags: {}, state: {}, useExisting: false }), { action: 'create', existingGroup: false });
  assert.deepEqual(groupDecision({ status: 404, tags: {}, state: {}, useExisting: true }), { action: 'create', existingGroup: false },
    'with the option a missing group is still created, as a group of its own');
  assert.deepEqual(groupDecision({ status: 200, tags: { purpose: PURPOSE, runId: RUN }, state: {}, useExisting: false }), { action: 'use', existingGroup: false, runId: RUN });
  assert.throws(() => groupDecision({ status: 200, tags: {}, state: {}, useExisting: false }), /-UseExistingResourceGroup/);
  assert.throws(() => groupDecision({ status: 200, tags: { purpose: PURPOSE, runId: OTHER }, state: { runId: RUN }, useExisting: false }), /refusing/);
  const adopted = groupDecision({ status: 200, tags: { owner: 'finance' }, state: {}, useExisting: true });
  assert.equal(adopted.action, 'adopt');
  assert.equal(adopted.existingGroup, true);
  assert.equal(adopted.runId, undefined, 'the caller makes a new runId');
  assert.deepEqual(groupDecision({ status: 200, tags: {}, state: { runId: RUN, existingGroup: true }, useExisting: false }), { action: 'adopt', existingGroup: true, runId: RUN },
    'a later run of an adopted group does not need the option again');
});

test('T-156 nameClashes: a resource named like one this tool creates, without this run\'s tag, is a clash; others are ignored', () => {
  const resources = [
    res('Microsoft.CognitiveServices/accounts', 'ai-foundry-prod'),
    res('Microsoft.ContainerRegistry/registries', 'crcustomerimages'),
    res('Microsoft.App/containerApps', 'ca-claude-gw', RUN),
    res('Microsoft.App/managedEnvironments', 'cae-claude-gw', OTHER),
    res('Microsoft.ManagedIdentity/userAssignedIdentities', 'id-admin-ui'),
    res('Microsoft.DBforPostgreSQL/flexibleServers', 'psql-claude-gw-abc12345-eastus'),
  ];
  assert.deepEqual(nameClashes(resources, RUN), [
    'Microsoft.App/managedEnvironments/cae-claude-gw (runId 99999999-2222-3333-4444-555555555555)',
    'Microsoft.ManagedIdentity/userAssignedIdentities/id-admin-ui (no runId)',
    'Microsoft.DBforPostgreSQL/flexibleServers/psql-claude-gw-abc12345-eastus (no runId)',
  ]);
  assert.deepEqual(nameClashes(resources.slice(0, 3), RUN), []);
  assert.deepEqual(nameClashes([res('Microsoft.App/containerApps', 'ca-claude-gw')], undefined), ['Microsoft.App/containerApps/ca-claude-gw (no runId)'],
    'before a first adoption there is no runId, and an untagged look-alike is still a clash');
});

test('T-156 teardownTiers: only this run\'s resources, apps and jobs before their environment, the environment before the rest', () => {
  const resources = [
    res('Microsoft.CognitiveServices/accounts', 'ai-foundry-prod'),
    res('Microsoft.KeyVault/vaults', 'kv-customer'),
    res('Microsoft.ManagedIdentity/userAssignedIdentities', 'id-claude-gw', RUN),
    res('Microsoft.App/managedEnvironments', 'cae-claude-gw', RUN),
    res('Microsoft.App/containerApps', 'ca-claude-gw', RUN),
    res('Microsoft.App/jobs', 'job-spend-pacer', RUN),
    res('Microsoft.ContainerRegistry/registries', 'crclaudegwabc12345', RUN),
    res('Microsoft.App/containerApps', 'ca-someone-else', OTHER),
    res('Microsoft.Network/virtualNetworks', 'vnet-claude-gw', RUN),
  ];
  const { tiers, unknown } = teardownTiers(resources, RUN);
  assert.deepEqual(tiers.map((t) => t.map((r) => r.name)), [['ca-claude-gw', 'job-spend-pacer'], ['cae-claude-gw'], ['id-claude-gw', 'crclaudegwabc12345']]);
  assert.match(tiers[0][0].apiVersion, /^\d{4}-\d{2}-\d{2}/);
  assert.deepEqual(unknown.map((r) => r.name), ['vnet-claude-gw'], 'a tagged resource of a type teardown does not know is reported, not deleted');
  // Security review, 2026-11-03: a runId tag copied onto a customer resource must not get it deleted.
  const copied = teardownTiers([res('Microsoft.DBforPostgreSQL/flexibleServers', 'psql-customer-prod', RUN), res('Microsoft.KeyVault/vaults', 'kv-customer', RUN)], RUN);
  assert.deepEqual(copied.tiers, []);
  assert.deepEqual(copied.unknown.map((r) => r.name), ['psql-customer-prod', 'kv-customer'], 'reported, not deleted');
});
