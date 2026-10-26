#!/usr/bin/env node
// Moves a test-topology gateway from the in-app PostgreSQL sidecar to a managed Flexible Server (ADR-0012, T-115), so
// spend, caps and the audit trail survive later configuration saves and revisions.
//   node scripts/admin/move-to-managed-database.mjs --resource-group rg-claude-gw-contoso [--gateway-app ca-claude-gw] [--plan]
//   node scripts/admin/move-to-managed-database.mjs --resource-group rg-claude-gw-contoso --acknowledge-data-loss [--database-location eastus]
// --database-location places the server in another region when the app's refuses B1ms (U-105).
// Steps: register Microsoft.DBforPostgreSQL (U-103); deploy the server and database cut from
// infra/azure-test/gateway-test.json, so they are defined once; allow the app's outbound addresses (U-101); then one
// write through admin-ui's configuration store (admin-ui/server/gateway-config.mjs) that saves the admin file with
// deployment.database "managed", drops the sidecar and its EmptyDir volume and sets GATEWAY_PG_HOST. That write starts
// a new revision; the sidecar's data is not copied, so spend restarts once and caps are set again with
// bootstrap-budgets.mjs. Re-running after a partial run is safe: each step checks what exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { GATEWAY_COMMAND, databaseLocationFor, databasePassword } from '../../infra/azure-test/lib/plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(root, 'infra', 'azure-test', 'gateway-test.json');
const PG = 'Microsoft.DBforPostgreSQL/';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;

/** The database-only deployment: gateway-test.json's PostgreSQL resources with the parameters and variables they use. */
export function databaseTemplate(template) {
  const resources = template.resources.filter((r) => r.type.startsWith(PG));
  const pick = (from, names) => Object.fromEntries(names.map((n) => [n, from[n]]));
  return {
    $schema: template.$schema,
    contentVersion: template.contentVersion,
    parameters: pick(template.parameters, ['location', 'databaseLocation', 'runId', 'postgresPassword', 'database']),
    variables: pick(template.variables, ['suffix', 'pgServerName', 'tags']),
    resources,
    outputs: { pgServerName: template.outputs.pgServerName },
  };
}

/** The live admin file with deployment.database "managed". A gateway with no gateway-admin-file secret is refused,
 * because the store would fall back to a repository admin file that may belong to another deployment. */
export function managedAdmin(current) {
  if (current.source !== 'live') {
    throw new Error('the gateway app has no gateway-admin-file secret, so its admin file is unknown here; save its configuration once from the admin console, then run the move again');
  }
  return { ...current.admin, deployment: { ...current.admin.deployment, database: 'managed' } };
}

/** The store reshape that turns a live sidecar app into one using the managed server; idempotent. */
export function managedReshape({ host }) {
  if (typeof host !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}\.postgres\.database\.azure\.com$/.test(host)) {
    throw new Error(`${JSON.stringify(host)} is not a Flexible Server host name (<server>.postgres.database.azure.com)`);
  }
  return ({ template, secret, setSecret }) => {
    const sidecar = template.containers.filter((c) => c.name === 'postgres');
    const volumes = new Set(sidecar.flatMap((c) => (c.volumeMounts ?? []).map((m) => m.volumeName)));
    template.containers = template.containers.filter((c) => c.name !== 'postgres');
    template.volumes = (template.volumes ?? []).filter((v) => !volumes.has(v.name));
    const gateway = template.containers.find((c) => c.name === 'gateway');
    if (!gateway) throw new Error('the app has no gateway container');
    gateway.env = (gateway.env ?? []).filter((e) => e.name !== 'GATEWAY_PG_HOST');
    gateway.env.push({ name: 'GATEWAY_PG_HOST', value: host });
    gateway.command = [...GATEWAY_COMMAND.command];
    gateway.args = [...GATEWAY_COMMAND.args];
    setSecret('pg-password', databasePassword(secret('pg-password')));
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'resource-group': { type: 'string' }, 'gateway-app': { type: 'string', default: 'ca-claude-gw' },
    plan: { type: 'boolean', default: false }, 'acknowledge-data-loss': { type: 'boolean', default: false }, 'database-location': { type: 'string' },
  } });
  const rg = values['resource-group'];
  const appName = values['gateway-app'];
  if (!rg || !NAME.test(rg) || !NAME.test(appName)) throw new Error('pass --resource-group <name> [--gateway-app <name>]');
  if (!values.plan && !values['acknowledge-data-loss']) {
    throw new Error('the move starts a new revision, which empties the sidecar database once; pass --acknowledge-data-loss, or --plan to preview');
  }

  const { arm, runDeployment } = await import('../../infra/azure-test/lib/azure-rest.mjs');
  const { azJson } = await import('../../infra/azure-test/lib/spawn.mjs');
  const { ensureProvider, existingServer, syncFirewall } = await import('../../infra/azure-test/lib/database.mjs');
  const { createConfigStore } = await import('../../admin-ui/server/gateway-config.mjs');
  const { readState, statePath } = await import('../../infra/azure-test/deploy.mjs');

  const account = azJson(['account', 'show']);
  const subscriptionPath = `/subscriptions/${account.id}`;
  const groupPath = `${subscriptionPath}/resourceGroups/${rg}`;
  const appId = `${groupPath}/providers/Microsoft.App/containerApps/${appName}`;
  const state = readState(rg);
  // admin-ui's store sends If-Match as an option; lib/azure-rest.mjs takes headers.
  const storeArm = (method, p, body, { ifMatch, ...rest } = {}) => arm(method, p, body, ifMatch ? { ...rest, headers: { 'If-Match': ifMatch } } : rest);
  const app = (await arm('GET', `${appId}?api-version=2024-03-01`)).json;
  const deployAdmin = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gateway-admin.azure-test.json'), 'utf8'));
  // The move changes no role, so the roles the live admin file already admits are the ones to validate against; that
  // also keeps Microsoft Graph out of the move.
  let admitted = [];
  const store = createConfigStore({ arm: storeArm, resourceId: appId, deployAdmin, topology: 'test', adminFilePath: 'the live admin file', knownRoles: async () => admitted });
  const current = await store.read();
  admitted = current.admin.roles;
  if (current.admin.deployment?.database === 'managed' && !current.restart.temporaryDatabase) {
    console.log(`${appName} already names the managed database; the move makes sure the server, firewall and app match it`);
  }

  const template = databaseTemplate(JSON.parse(fs.readFileSync(TEMPLATE, 'utf8')));
  const secrets = (await arm('POST', `${appId}/listSecrets?api-version=2024-03-01`)).json?.value ?? [];
  const pg = secrets.find((s) => s.name === 'pg-password')?.value;
  if (!pg) throw new Error(`${appName} has no pg-password secret value`);
  const runId = app.tags?.runId ?? state.runId ?? 'move-to-managed';
  const existing = await existingServer({ arm, groupPath });
  const databaseLocation = databaseLocationFor({ option: values['database-location'], state: existing?.location, location: String(app.location).toLowerCase().replace(/\s+/g, '') });
  managedAdmin(current);
  if (values.plan) {
    console.log(`PLAN: register Microsoft.DBforPostgreSQL if needed; deploy ${template.resources.map((r) => r.type).join(' and ')} in ${rg}, region ${databaseLocation}`);
    console.log(`PLAN: allow ${app.properties.outboundIpAddresses?.join(', ') || 'the app\'s outbound addresses'} on the server firewall`);
    console.log(`PLAN: save the admin file with deployment.database "managed" and remove the postgres container from ${appName}, a new revision`);
    return 0;
  }

  await ensureProvider({ arm, subscriptionPath, say: console.log });
  const body = JSON.stringify({ properties: { mode: 'Incremental', template, parameters: {
    location: { value: app.location }, databaseLocation: { value: databaseLocation }, runId: { value: runId }, postgresPassword: { value: databasePassword(pg) }, database: { value: 'managed' },
  } } });
  console.log('deploying the Flexible Server and the gateway database (several minutes on the first run)');
  const result = await runDeployment(groupPath, 'claude-gw-database', body);
  const serverName = result.properties.outputs.pgServerName.value;
  const serverId = `${groupPath}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${serverName}`;
  console.log(`server ${serverName} is ready`);
  // deploy.mjs reads these, so a later app step keeps this server (it also finds it by name).
  if (fs.existsSync(statePath(rg))) {
    fs.writeFileSync(statePath(rg), `${JSON.stringify({ ...readState(rg), pgServerName: serverName, databaseLocation }, null, 2)}\n`);
  }
  await syncFirewall({ arm, appId, serverId, say: console.log });

  const latest = await store.read();
  const admin = managedAdmin(latest);
  const saved = await store.write({ admin, baseVersion: latest.version, acknowledgeDataLoss: true,
    reshape: managedReshape({ host: `${serverName}.postgres.database.azure.com` }) });
  console.log(`saved; waiting for a revision after ${saved.rollout.previousRevision}`);
  for (let i = 0; i < 90; i += 1) {
    const r = await store.rollout(saved.rollout.previousRevision);
    if (r.done) { console.log(r.message); break; }
    if (r.failed) throw new Error(r.message);
    await sleep(10_000);
  }
  const fqdn = app.properties.configuration.ingress.fqdn;
  const ready = (await fetch(`https://${fqdn}/readyz`)).status;
  console.log(`/readyz ${ready}`);
  // The new revision's outbound addresses can differ from the old one's (U-101).
  await syncFirewall({ arm, appId, serverId, say: console.log });
  console.log(`done. Set the caps again: node scripts/admin/bootstrap-budgets.mjs --admin <admin file> --resource-group ${rg}`);
  return ready === 200 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
