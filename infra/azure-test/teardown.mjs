#!/usr/bin/env node
// Removes what deploy.mjs created, in dependency order, and only what carries this run's runId:
// the role assignment on the Foundry account, the Entra app and its service principal, then the
// resource group. Safe to re-run after a partial failure; --dry-run makes every check and deletes nothing.
//   node infra/azure-test/teardown.mjs [--resource-group rg-claude-apps-gateway-test] [--dry-run] [--no-wait]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readState, statePath } from './deploy.mjs';
import { arm, graph } from './lib/azure-rest.mjs';
import { foundryAccountIds } from './lib/plan.mjs';
import { redactSecrets } from './lib/secrets.mjs';
import { azJson } from './lib/spawn.mjs';

const PURPOSE = 'claude-apps-gateway-test';
// The template's identity name (infra/azure-test/gateway-test.json, variable identityName).
const IDENTITY = 'id-claude-gw';
const GROUP_API = 'api-version=2022-09-01';
const say = (message) => console.log(redactSecrets(`[teardown] ${message}`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { values } = parseArgs({ options: {
    'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
    'dry-run': { type: 'boolean', default: false },
    'no-wait': { type: 'boolean', default: false },
  } });
  const group = values['resource-group'];
  const dryRun = values['dry-run'];
  const act = async (label, action) => { say(`${dryRun ? 'would delete' : 'deleting'} ${label}`); if (!dryRun) await action(); };
  const state = readState(group);
  if (!state.runId) throw new Error(`no state file for ${group} at ${statePath(group)}; nothing recorded to remove`);

  const account = azJson(['account', 'show']);
  if (account.id !== state.subscriptionId || account.tenantId !== state.tenantId) {
    throw new Error('the signed-in subscription or tenant differs from the state file; refusing');
  }
  const groupPath = `/subscriptions/${state.subscriptionId}/resourceGroups/${group}`;
  const rg = await arm('GET', `${groupPath}?${GROUP_API}`, undefined, { ok: [200, 404] });
  if (rg.status === 200 && (rg.json.tags?.purpose !== PURPOSE || rg.json.tags?.runId !== state.runId)) {
    throw new Error(`resource group ${group} does not carry purpose ${PURPOSE} and runId ${state.runId}; refusing`);
  }

  // This identity's role assignments on the Foundry account go first: once the identity is deleted they
  // linger as "Identity not found". They are found by principal, so a grant made by a base deployment
  // that failed before its outputs were saved is removed as well (Coder and Architect review).
  const principalId = state.identity?.principalId ?? (rg.status === 200
    ? (await arm('GET', `${groupPath}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${IDENTITY}?api-version=2023-01-31`,
      undefined, { ok: [200, 404] })).json?.properties?.principalId
    : undefined);
  // Every account a run named is checked, not only the latest (Coder review, round 2).
  const accountIds = foundryAccountIds(state);
  if (principalId && accountIds.length) {
    const filter = encodeURIComponent(`principalId eq '${principalId}'`);
    for (const accountId of accountIds) {
      const account = accountId.split('/').at(-1);
      const listed = await arm('GET', `${accountId}/providers/Microsoft.Authorization/roleAssignments?$filter=${filter}&api-version=2022-04-01`, undefined, { ok: [200, 404] });
      const atAccount = (listed.json?.value ?? []).filter((ra) => ra.properties.principalId === principalId
        && ra.properties.scope.toLowerCase() === accountId.toLowerCase());
      for (const ra of atAccount) {
        await act(`role assignment ${ra.name} on Foundry account ${account}`, () => arm('DELETE', `${ra.id}?api-version=2022-04-01`, undefined, { ok: [200, 204, 404] }));
      }
      if (!atAccount.length) say(`no role assignment of this identity on Foundry account ${account}`);
    }
  } else {
    say('no identity or Foundry account recorded or found; no Foundry role assignment to look for');
  }

  if (state.application?.id) {
    const app = await graph('GET', `/applications/${state.application.id}?$select=tags`, undefined, { ok: [200, 404] });
    if (app.status === 200) {
      if (!app.json.tags?.includes(`runId:${state.runId}`)) throw new Error('the Entra app does not carry this run\'s tag; refusing');
      await act(`app registration ${state.application.appId}`, () => graph('DELETE', `/applications/${state.application.id}`, undefined, { ok: [204, 404] }));
      if (!dryRun) {
        const purged = await graph('DELETE', `/directory/deletedItems/${state.application.id}`, undefined, { ok: [204, 403, 404] });
        say(purged.status === 204 ? 'app registration purged from deleted items' : 'app registration stays in deleted items for 30 days (no right to purge)');
      }
    }
    const sp = await graph('GET', `/servicePrincipals(appId='${state.application.appId}')?$select=id`, undefined, { ok: [200, 404] });
    if (sp.status === 200 && !dryRun) await graph('DELETE', `/servicePrincipals/${sp.json.id}`, undefined, { ok: [204, 404] });
    say(sp.status === 200 ? `service principal ${sp.json.id} ${dryRun ? 'would be deleted with the app' : 'deleted'}` : 'service principal gone');
  }

  if (rg.status === 200) {
    await act(`resource group ${group}`, () => arm('DELETE', `${groupPath}?${GROUP_API}`, undefined, { ok: [200, 202] }));
    if (!dryRun && values['no-wait']) {
      // The state file is the only record of what to clean up, so it stays until the group is gone.
      state.deletingSince = new Date().toISOString();
      fs.writeFileSync(statePath(group), `${JSON.stringify(state, null, 2)}\n`);
      return say(`resource group deletion started; run "node infra/azure-test/teardown.mjs --resource-group ${group}" again to confirm it and remove the state file`);
    }
    if (!dryRun) {
      const deadline = Date.now() + 30 * 60_000;
      while ((await arm('GET', `${groupPath}?${GROUP_API}`, undefined, { ok: [200, 404] })).status === 200) {
        if (Date.now() > deadline) throw new Error(`resource group ${group} still exists after 30 minutes; run teardown again later`);
        await sleep(15_000);
      }
      say(`resource group ${group} deleted`);
    }
  }
  if (!dryRun) {
    fs.rmSync(statePath(group), { force: true });
    say('state file removed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(`[teardown] ${error.stack ?? error.message}`));
    process.exit(1);
  });
}
