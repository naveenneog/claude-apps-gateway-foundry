// The managed database option's Azure calls (ADR-0012), shared by deploy.mjs, scripts/admin/move-to-managed-database.mjs
// and scripts/admin/sync-database-firewall.mjs. arm(method, path, body, options) -> { status, json }, the shape of
// lib/azure-rest.mjs's arm and admin-ui's arm-client.mjs.
import { databaseLocationFor, firewallPlan } from './plan.mjs';
import { isRegionRefusal } from './preflight.mjs';

const PROVIDER_API = 'api-version=2022-09-01';
const PG_API = 'api-version=2024-08-01';
const APP_API = 'api-version=2024-03-01';
const PROVIDER = 'Microsoft.DBforPostgreSQL';

/** Registers Microsoft.DBforPostgreSQL on the subscription when needed and waits for Registered (U-103). */
export async function ensureProvider({ arm, subscriptionPath, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), say = () => {}, attempts = 60 }) {
  const state = async () => (await arm('GET', `${subscriptionPath}/providers/${PROVIDER}?${PROVIDER_API}`)).json?.registrationState;
  let now = await state();
  if (now === 'Registered') return;
  say(`${PROVIDER} is ${now ?? 'unknown'} on the subscription; registering it`);
  await arm('POST', `${subscriptionPath}/providers/${PROVIDER}/register?${PROVIDER_API}`);
  for (let i = 0; i < attempts; i += 1) {
    await sleep(10_000);
    now = await state();
    if (now === 'Registered') { say(`${PROVIDER} registered`); return; }
  }
  throw new Error(`${PROVIDER} is still ${now} after ${attempts} checks; register it with: az provider register -n ${PROVIDER} --wait`);
}

/** The gateway's psql-claude-gw-* server in a resource group, with its region as a region name, or null. */
export async function existingServer({ arm, groupPath }) {
  const servers = ((await arm('GET', `${groupPath}/providers/${PROVIDER}/flexibleServers?${PG_API}`)).json?.value ?? [])
    .filter((s) => /^psql-claude-gw-/.test(s.name));
  if (servers.length > 1) throw new Error(`two or more psql-claude-gw-* servers in ${groupPath}: ${servers.map((s) => s.name).join(', ')}; remove the unused one`);
  if (!servers.length) return null;
  return { name: servers[0].name, location: String(servers[0].location).toLowerCase().replace(/\s+/g, ''), id: servers[0].id };
}

/**
 * Makes the server's aca-outbound-* firewall rules allow exactly the app's outbound addresses (U-101). check:true
 * returns the difference without changing anything.
 */
export async function syncFirewall({ arm, appId, serverId, say = () => {}, check = false }) {
  const ips = (await arm('GET', `${appId}?${APP_API}`)).json?.properties?.outboundIpAddresses ?? [];
  const rules = (await arm('GET', `${serverId}/firewallRules?${PG_API}`)).json?.value ?? [];
  const plan = firewallPlan(rules, ips);
  const result = { added: plan.add.map((r) => r.name), removed: plan.remove };
  if (check) return result;
  for (const { name, ip } of plan.add) {
    await arm('PUT', `${serverId}/firewallRules/${name}?${PG_API}`, { properties: { startIpAddress: ip, endIpAddress: ip } });
    say(`database firewall: allowed ${ip} (${name})`);
  }
  for (const name of plan.remove) {
    await arm('DELETE', `${serverId}/firewallRules/${name}?${PG_API}`, undefined, { ok: [200, 202, 204, 404] });
    say(`database firewall: removed ${name}`);
  }
  if (!plan.add.length && !plan.remove.length) say(`database firewall: already allows exactly ${ips.join(', ')}`);
  return result;
}

const serverIdOf = (ctx) => `${ctx.groupPath}/providers/${PROVIDER}/flexibleServers/${ctx.state.pgServerName}`;
const appIdOf = (ctx) => `${ctx.groupPath}/providers/Microsoft.App/containerApps/${ctx.state.appName}`;

/**
 * deploy.mjs's app step, before the deployment: for "managed", the region (an existing server keeps its own, made by
 * an earlier app step or by move-to-managed-database.mjs), the provider registration, and, for an existing app, the
 * firewall, so the next revision connects as soon as it starts. Returns { databaseLocation } (undefined for sidecar).
 */
export async function prepareDatabase({ arm, ctx, database, preview, appExists, say = () => {} }) {
  if (database !== 'managed') return { databaseLocation: undefined };
  const server = await existingServer({ arm, groupPath: ctx.groupPath }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (server) Object.assign(ctx.state, { pgServerName: server.name, databaseLocation: server.location });
  const databaseLocation = databaseLocationFor({ option: ctx.opts['database-location'], state: server?.location ?? ctx.state.databaseLocation, location: ctx.opts.location });
  say(`database: managed Flexible Server in ${databaseLocation} (ADR-0012)`);
  if (!preview) await ensureProvider({ arm, subscriptionPath: `/subscriptions/${ctx.state.subscriptionId}`, say });
  if (!preview && appExists && ctx.state.pgServerName) await syncFirewall({ arm, appId: appIdOf(ctx), serverId: serverIdOf(ctx), say });
  return { databaseLocation };
}

/** deploy.mjs's app step, after the deployment: records the server and allows the app's outbound addresses. */
export async function finishDatabase({ arm, ctx, out, databaseLocation, save, say = () => {} }) {
  Object.assign(ctx.state, { pgServerName: out.pgServerName, databaseLocation });
  save();
  await syncFirewall({ arm, appId: appIdOf(ctx), serverId: serverIdOf(ctx), say });
}

/**
 * ADR-0018: the base stage creates the managed database before anything else, trying regions in order. deploy(region)
 * creates it and returns { pgServerName }; remove(region) deletes what a refused attempt left. Only a region refusal
 * (isRegionRefusal) moves on; any other error stops. An existing server is kept, if the list names its region.
 */
export async function createDatabaseFirst({ regions, existing, deploy, remove, say = () => {} }) {
  if (existing) {
    if (!regions.includes(existing.location)) throw new Error(`the managed database is already in ${existing.location} (${existing.name}); add ${existing.location} to -DatabaseLocation or remove the server`);
    say(`database: ${existing.name} already exists in ${existing.location}; kept`);
    return { databaseLocation: existing.location, pgServerName: existing.name };
  }
  const refused = [];
  for (const region of regions) {
    say(`database: creating the managed PostgreSQL server in ${region} first, so a refused region shows now and not at the end`);
    try {
      const { pgServerName } = await deploy(region);
      say(`database: ${pgServerName} created in ${region}`);
      return { databaseLocation: region, pgServerName };
    } catch (error) {
      if (!isRegionRefusal(error.message)) throw error;
      refused.push(region);
      say(`database: ${region} refused the server (${error.message.split('\n').at(-1).trim().slice(0, 200)}); cleaning up and trying the next region`);
      await remove(region);
    }
  }
  throw new Error(`database: no region could create the server: ${refused.join(', ')} refused. Add regions to -DatabaseLocation, for example -DatabaseLocation ${[...refused, 'centralus', 'westus3'].filter((r, i, a) => a.indexOf(r) === i).join(',')}`);
}