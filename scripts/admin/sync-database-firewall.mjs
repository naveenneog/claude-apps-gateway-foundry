#!/usr/bin/env node
// Makes the managed database's firewall allow exactly the gateway app's current outbound addresses (ADR-0012, U-101).
// Container Apps outbound addresses can change without a deployment; when they do, the gateway's /readyz fails and
// requests get 503 until this runs.
//   node scripts/admin/sync-database-firewall.mjs --resource-group rg-claude-gw-contoso [--gateway-app ca-claude-gw] [--check]
// --check changes nothing and exits 1 when the rules differ from the app's addresses, so it can run on a schedule.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'resource-group': { type: 'string' }, 'gateway-app': { type: 'string', default: 'ca-claude-gw' }, check: { type: 'boolean', default: false },
  } });
  const rg = values['resource-group'];
  if (!rg || !NAME.test(rg) || !NAME.test(values['gateway-app'])) throw new Error('pass --resource-group <name> [--gateway-app <name>] [--check]');
  const { arm } = await import('../../infra/azure-test/lib/azure-rest.mjs');
  const { azJson } = await import('../../infra/azure-test/lib/spawn.mjs');
  const { syncFirewall } = await import('../../infra/azure-test/lib/database.mjs');
  const groupPath = `/subscriptions/${azJson(['account', 'show']).id}/resourceGroups/${rg}`;
  const appId = `${groupPath}/providers/Microsoft.App/containerApps/${values['gateway-app']}`;
  const servers = (await arm('GET', `${groupPath}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2024-08-01`)).json?.value ?? [];
  const server = servers.find((s) => /^psql-claude-gw-/.test(s.name));
  if (!server) throw new Error(`no psql-claude-gw-* Flexible Server in ${rg}; this gateway uses the sidecar database`);
  const result = await syncFirewall({ arm, appId, serverId: server.id, say: console.log, check: values.check });
  if (values.check) {
    const drift = result.added.length + result.removed.length;
    console.log(drift ? `drift: add ${result.added.join(', ') || 'none'}; remove ${result.removed.join(', ') || 'none'}` : 'in sync');
    return drift ? 1 : 0;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
