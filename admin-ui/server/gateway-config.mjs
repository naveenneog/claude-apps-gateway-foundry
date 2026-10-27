// The gateway's configuration as admin-ui edits it (ADR-0010): the admin file, kept as the gateway app's
// `gateway-admin-file` secret, and its rendering, the `gateway-config` secret the gateway mounts as gateway.yaml.
// Validation and rendering are scripts/admin/new-gateway-config.mjs's own adminErrors() and renderGatewayConfig(),
// unmodified, so admin-ui writes exactly what `node scripts/admin/new-gateway-config.mjs` would.
//
// Writing follows `az containerapp secret set` (U-85): GET the app, POST listSecrets for the values the GET leaves
// out, then PUT the whole app back. A secret change alone starts no revision, and the gateway reads gateway.yaml only
// at startup, so the same PUT changes CONFIG_UPDATED_AT on the container that mounts the config, which starts one.
import crypto from 'node:crypto';
import { adminErrors, renderGatewayConfig } from '../../scripts/admin/new-gateway-config.mjs';
import { PACER_ENV } from '../../scripts/admin/spend-pacing.mjs';

export const ARM_API_VERSION = '2025-07-01';
const CONFIG_ENTRY = 'gateway-config';
const ADMIN_ENTRY = 'gateway-admin-file';
const STAMP = 'CONFIG_UPDATED_AT';

const TEMPORARY_DATABASE_WARNING = 'This gateway keeps its database on temporary storage (an EmptyDir volume), which a new revision starts empty. '
  + 'Applying a change resets spend totals, spend caps and the audit trail, and developers may need to sign in again.';

const containersOf = (app) => list(app?.properties?.template?.containers);

function fail(status, message, details) { return Object.assign(new Error(message), { status, details }); }

/** The admin file as stored: 2-space JSON with a trailing newline, the form the repository's admin files use. */
export function adminFileText(admin) { return `${JSON.stringify(admin, null, 2)}\n`; }

/** The version a client sends back with a write: the SHA-256 of the stored admin file. */
export function adminVersion(admin) { return crypto.createHash('sha256').update(adminFileText(admin)).digest('hex'); }

const list = (v) => (Array.isArray(v) ? v : []);
const join = (v) => (v.length ? v.join(', ') : '(none)');

function gatewayUrl(app) {
  const ingress = app?.properties?.configuration?.ingress;
  const hosts = [
    ...list(ingress?.customDomains).filter((domain) => domain.bindingType !== 'Disabled').map((domain) => domain.name),
    ingress?.fqdn,
  ];
  for (const host of hosts) {
    if (typeof host !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) continue;
    return `https://${host.toLowerCase()}`;
  }
  return null;
}

/** Human-readable lines naming what an edit changes; [] when nothing does. */
export function describeChanges(before, after) {
  const lines = [];
  const beforeModels = new Map(list(before?.models).map((m) => [m?.id, m]));
  const afterModels = new Map(list(after?.models).map((m) => [m?.id, m]));
  for (const [id, m] of afterModels) {
    const old = beforeModels.get(id);
    if (!old) lines.push(`model ${id} added (deployment ${m.deployment})`);
    else {
      if (old.deployment !== m.deployment) lines.push(`model ${id}: deployment ${old.deployment} → ${m.deployment}`);
      if ((old.label ?? null) !== (m.label ?? null)) lines.push(`model ${id}: label ${old.label ?? '(none)'} → ${m.label ?? '(none)'}`);
    }
  }
  for (const id of beforeModels.keys()) if (!afterModels.has(id)) lines.push(`model ${id} removed`);
  const beforeRoles = new Set(list(before?.roles));
  const afterRoles = new Set(list(after?.roles));
  for (const r of afterRoles) if (!beforeRoles.has(r)) lines.push(`role ${r} admitted`);
  for (const r of beforeRoles) if (!afterRoles.has(r)) lines.push(`role ${r} no longer admitted`);
  const beforePolicies = new Map(list(before?.policies).map((p) => [p?.role, p]));
  for (const p of list(after?.policies)) {
    const old = beforePolicies.get(p.role) ?? {};
    const was = list(old.models);
    const now = list(p.models);
    if (was.join('\n') !== now.join('\n')) lines.push(`${p.role}: models ${join(was)} → ${join(now)}`);
    if ((old.desktop ?? null) !== (p.desktop ?? null)) lines.push(`${p.role}: Claude Desktop ${old.desktop === true ? 'on' : old.desktop === false ? 'off' : 'default'} → ${p.desktop === true ? 'on' : p.desktop === false ? 'off' : 'default'}`);
  }
  // ADR-0014: the soft limit, named the way the console shows it.
  const soft = (a) => (a?.spendPacing?.softLimitPercent ? `${a.spendPacing.softLimitPercent}% of the monthly cap` : 'off');
  if (soft(before) !== soft(after)) lines.push(`soft limit: ${soft(before)} → ${soft(after)}`);
  for (const key of ['deployment', 'budgets']) {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) lines.push(`${key} changed`);
  }
  return lines;
}

/** What a revision change does to this app: which containers mount the config, and whether any data lives on EmptyDir. */
export function inspectApp(app) {
  const template = app?.properties?.template ?? {};
  const volumes = list(template.volumes);
  const configVolumes = new Set(volumes
    .filter((v) => v.storageType === 'Secret' && (!Array.isArray(v.secrets) || v.secrets.some((s) => s.secretRef === CONFIG_ENTRY)))
    .map((v) => v.name));
  const emptyDirs = new Set(volumes.filter((v) => v.storageType === 'EmptyDir').map((v) => v.name));
  const containers = list(template.containers);
  return {
    configContainers: containers.filter((c) => list(c.volumeMounts).some((m) => configVolumes.has(m.volumeName))).map((c) => c.name),
    temporaryDatabase: containers.some((c) => list(c.volumeMounts).some((m) => emptyDirs.has(m.volumeName))),
  };
}

/**
 * arm: arm-client.mjs's arm(). resourceId: the gateway container app. deployAdmin: the admin file admin-ui was deployed
 * with, used until the app holds a gateway-admin-file secret. knownRoles: async () => the app role values in Entra.
 */
export function createConfigStore({ arm, resourceId, deployAdmin, topology = 'test', adminFilePath, knownRoles, now = () => new Date() }) {
  const q = `?api-version=${ARM_API_VERSION}`;
  const getApp = async () => (await arm('GET', `${resourceId}${q}`)).json;
  const getSecrets = async () => list((await arm('POST', `${resourceId}/listSecrets${q}`)).json?.value);
  const render = (admin) => renderGatewayConfig(admin, { adminFile: adminFilePath, topology });
  let writeQueue = Promise.resolve();

  async function snapshot() {
    const app = await getApp();
    const secrets = await getSecrets();
    const byName = new Map(secrets.map((s) => [s.name, s]));
    const stored = byName.get(ADMIN_ENTRY)?.value;
    let admin = deployAdmin;
    let source = 'deploy';
    if (stored) {
      try { admin = JSON.parse(stored); source = 'live'; } catch { throw fail(502, `the gateway app's ${ADMIN_ENTRY} secret is not JSON; set it again from a valid admin file`); }
    }
    return { app, secrets, admin, source, liveYaml: byName.get(CONFIG_ENTRY)?.value ?? null };
  }

  async function read() {
    const { app, admin, source, liveYaml } = await snapshot();
    let deployFileMatches;
    if (source === 'live') deployFileMatches = adminFileText(admin) === adminFileText(deployAdmin);
    else {
      try { deployFileMatches = render(deployAdmin).replace(/\r\n/g, '\n') === (liveYaml ?? '').replace(/\r\n/g, '\n'); } catch { deployFileMatches = false; }
    }
    const { temporaryDatabase } = inspectApp(app);
    return {
      admin, version: adminVersion(admin), source, deployFileMatches, topology, adminFilePath,
      gateway: { app: app.name, revision: app.properties?.latestRevisionName ?? null, url: gatewayUrl(app) },
      restart: { temporaryDatabase, warning: temporaryDatabase ? TEMPORARY_DATABASE_WARNING : null },
    };
  }

  async function validate(admin) {
    const errors = adminErrors(admin, await knownRoles(), topology);
    return errors.length ? { errors, yaml: null } : { errors: [], yaml: render(admin) };
  }

  async function preview(admin) {
    const { errors, yaml } = await validate(admin);
    if (errors.length) return { errors, yaml: null, changes: [] };
    const { admin: current, liveYaml } = await snapshot();
    const changes = describeChanges(current, admin);
    if (liveYaml !== null && liveYaml.replace(/\r\n/g, '\n') !== render(current).replace(/\r\n/g, '\n')) {
      changes.push("the running gateway.yaml is not the rendering of the current admin file; saving replaces it");
    }
    return { errors: [], yaml, changes };
  }

  async function write({ admin, baseVersion, acknowledgeDataLoss = false, reshape }) {
    // One save at a time in this process: without an ETag, two overlapping saves could both pass the second read and
    // both PUT. Queued, the later one reads the earlier one's result and fails the base-version check with 409.
    const run = writeQueue.then(() => writeOnce({ admin, baseVersion, acknowledgeDataLoss, reshape }));
    writeQueue = run.catch(() => {});
    return run;
  }

  // reshape is for operator tools only (scripts/admin/move-to-managed-database.mjs, ADR-0012); the HTTP API never
  // passes it. It may change the cloned template and the value of an existing secret, in the same PUT as the config.
  async function writeOnce({ admin, baseVersion, acknowledgeDataLoss, reshape }) {
    const { errors, yaml } = await validate(admin);
    if (errors.length) throw fail(400, `the admin file has ${errors.length} problem(s)`, { errors });
    const { app, secrets, admin: current } = await snapshot();
    const currentVersion = adminVersion(current);
    if (baseVersion !== currentVersion) throw fail(409, 'the configuration changed since it was read; reload it and apply the change again', { currentVersion });
    // Microsoft.App/containerApps returns no ETag, in the body or as a header (live GET, 2026-10-25; U-94). With one,
    // the PUT is conditional; without one, the app is read again just before the PUT and the write is refused if its
    // last-modified time or latest revision moved. That narrows, but cannot close, the window a conditional PUT closes.
    const etag = typeof app.etag === 'string' && app.etag ? app.etag : null;
    const modifiedAt = app.systemData?.lastModifiedAt ?? null;
    if (!etag && !modifiedAt) throw fail(502, 'Azure Resource Manager returned neither an ETag nor systemData.lastModifiedAt for the gateway app, so a concurrent change could not be detected; the configuration was not changed');
    const { configContainers, temporaryDatabase } = inspectApp(app);
    if (!configContainers.length) throw fail(409, `no container of ${app.name} mounts the ${CONFIG_ENTRY} secret, so a change would not reach the gateway`);
    // ADR-0014: with spendPacing the configuration reads ${GATEWAY_ADMIN_PACER_KEY}, and the gateway does not start with an
    // undefined variable. The installers add it with the admin API; a gateway installed before them has not got it yet.
    if (admin.spendPacing && !containersOf(app).some((c) => configContainers.includes(c.name) && list(c.env).some((e) => e.name === PACER_ENV))) {
      throw fail(409, `the gateway has no ${PACER_ENV} variable, which the configuration reads once the soft limit is on; run the installer's app stage once to add it, then turn the soft limit on`);
    }
    // ADR-0012: the database choice changes the app's containers, which only the move script reshapes. A plain save
    // that changed it would render a store the running app cannot reach.
    const databaseOf = (a) => a?.deployment?.database ?? 'sidecar';
    if (!reshape && databaseOf(admin) !== databaseOf(current)) {
      throw fail(409, `deployment.database cannot change from ${databaseOf(current)} to ${databaseOf(admin)} in a configuration save; run scripts/admin/move-to-managed-database.mjs`);
    }
    if (temporaryDatabase && acknowledgeDataLoss !== true) throw fail(428, TEMPORARY_DATABASE_WARNING, { requiresAcknowledgement: true });

    const values = new Map(secrets.map((s) => [s.name, s]));
    const merged = list(app.properties.configuration.secrets).map((s) => {
      if (s.keyVaultUrl) return { name: s.name, keyVaultUrl: s.keyVaultUrl, identity: s.identity };
      const v = values.get(s.name);
      if (!v || typeof v.value !== 'string') throw fail(502, `listSecrets returned no value for the secret ${s.name}; nothing was changed`);
      return { name: s.name, value: v.value };
    });
    const set = (name, value) => {
      const hit = merged.find((s) => s.name === name);
      if (hit) { delete hit.keyVaultUrl; delete hit.identity; hit.value = value; } else merged.push({ name, value });
    };
    set(CONFIG_ENTRY, yaml);
    set(ADMIN_ENTRY, adminFileText(admin));

    const requestedAt = now().toISOString();
    const template = structuredClone(app.properties.template);
    for (const c of template.containers) {
      if (!configContainers.includes(c.name)) continue;
      c.env = list(c.env);
      const stamp = c.env.find((e) => e.name === STAMP);
      if (stamp) { stamp.value = requestedAt; delete stamp.secretRef; } else c.env.push({ name: STAMP, value: requestedAt });
    }
    if (reshape) {
      const existing = (name) => {
        const hit = merged.find((s) => s.name === name);
        if (!hit || typeof hit.value !== 'string') throw fail(400, `the app has no secret ${name} with a value; a reshape changes only existing secrets`);
        return hit;
      };
      reshape({ template, secret: (name) => existing(name).value, setSecret: (name, value) => { existing(name).value = value; } });
    }
    const body = { location: app.location, properties: { ...app.properties, configuration: { ...app.properties.configuration, secrets: merged }, template } };
    for (const key of ['tags', 'identity', 'kind', 'managedBy', 'extendedLocation']) if (app[key] !== undefined) body[key] = app[key];
    const changedWhileSaving = async () => fail(409, 'the gateway app changed while this configuration was being saved; reload it and apply the change again', {
      currentVersion: adminVersion((await snapshot()).admin),
    });
    if (!etag) {
      const again = await getApp();
      if (again.systemData?.lastModifiedAt !== modifiedAt || again.properties?.latestRevisionName !== app.properties.latestRevisionName) throw await changedWhileSaving();
    }
    try {
      await arm('PUT', `${resourceId}${q}`, body, etag ? { ifMatch: etag } : {});
    } catch (error) {
      if (error.status !== 412) throw error;
      throw await changedWhileSaving();
    }
    return { version: adminVersion(admin), rollout: { previousRevision: app.properties.latestRevisionName ?? null, requestedAt } };
  }

  async function rollout(previousRevision) {
    const app = await getApp();
    const p = app.properties ?? {};
    const latest = p.latestRevisionName ?? null;
    const revision = latest ? (await arm('GET', `${resourceId}/revisions/${encodeURIComponent(latest)}${q}`)).json?.properties ?? {} : {};
    const started = Boolean(latest) && (!previousRevision || latest !== previousRevision);
    const healthy = revision.healthState === 'Healthy';
    const failed = started && (p.provisioningState === 'Failed' || revision.provisioningState === 'Failed' || revision.runningState === 'Failed');
    const done = started && !failed && p.provisioningState === 'Succeeded' && p.latestReadyRevisionName === latest && healthy;
    let message;
    if (!started) message = 'waiting for the new revision to be created';
    else if (failed) message = `revision ${latest} failed; the previous revision keeps serving`;
    else if (done) message = `revision ${latest} is running and healthy`;
    else message = `revision ${latest} is ${revision.runningState ?? p.provisioningState ?? 'starting'}`;
    return {
      previousRevision: previousRevision ?? null, latestRevision: latest, latestReadyRevision: p.latestReadyRevisionName ?? null,
      provisioningState: p.provisioningState ?? null, runningStatus: p.runningStatus ?? null, healthy, done, failed, message,
    };
  }

  return { read, preview, write, rollout };
}
