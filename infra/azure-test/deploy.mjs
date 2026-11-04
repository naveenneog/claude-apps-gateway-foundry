#!/usr/bin/env node
// Deploys the Claude apps gateway test environment on Azure Container Apps (docs/adr/0003-*.md).
//   node infra/azure-test/deploy.mjs --tester-cidr 203.0.113.0/26 [--step all|base|entra|image|app] [--what-if]
//     [--rotate-client-secret] [--client-secret-days 1-30] [--config config/gateway.azure-test.yaml]
// Steps: base (resource group, registry, identity, workspace, environment, role assignments), entra
// (app registration, service principal, tester's app role), image (PostgreSQL import, gateway build),
// app (client secret and the Container App, with the rendered configuration --config names). Secrets exist only in
// memory and in HTTPS request bodies; the state file under .state/ holds non-secret identifiers for teardown.mjs.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { arm, graph, retry, runDeployment, validateDeployment, whatIfDeployment } from './lib/azure-rest.mjs';
import {
  buildApplication, ingressRange, deployWithPreview, deploymentBody, promotionError, redirectUriFor,
  restoredByDeployment, secretDays, credentialMonths, emailDomainFor, stateFromOutputs, supersededKeys, unsetConfigVariables, whatIfLines, newSecret, databaseRegions,
  withFoundryTarget, databaseOf, databasePassword, templateForDatabase, templateForDatabaseFirst, templateForConsole, consoleConfig,
} from './lib/plan.mjs';
import { appSecrets, finishCredential, liveApp, ownKeyName, passwordCredentials, removeKeys } from './lib/credentials.mjs';
import { templateForCredential } from './lib/signin.mjs';
import { createDatabaseFirst, ensureProvider, existingServer, finishDatabase, prepareDatabase } from './lib/database.mjs';
import { runPreflight } from './lib/preflight.mjs';
import { groupDecision, nameClashes } from './lib/existing-group.mjs';
import { redactSecrets } from './lib/secrets.mjs';
import { azJson, runAz } from './lib/spawn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const TEMPLATE = path.join(here, 'gateway-test.json');
const MANIFEST = path.join(here, 'entra-app.json');
const IMAGE_DIR = path.join(here, 'image');
const CONFIG = path.join(root, 'config', 'gateway.azure-test.yaml');
const PURPOSE = 'claude-apps-gateway-test';
const TESTER_ROLE = 'Gateway.Standard';
const APP_API = 'api-version=2024-03-01';
const GROUP_API = 'api-version=2022-09-01';

const say = (message) => console.log(redactSecrets(`[deploy] ${message}`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const statePath = (group) => path.join(here, '.state', `${group}.json`);
export const readState = (group) => (fs.existsSync(statePath(group)) ? JSON.parse(fs.readFileSync(statePath(group), 'utf8')) : {});
// --what-if changes nothing, the state file included (Coder review, round 2).
function saveState(ctx) {
  if (ctx.opts['what-if']) return;
  fs.mkdirSync(path.dirname(statePath(ctx.group)), { recursive: true });
  fs.writeFileSync(statePath(ctx.group), `${JSON.stringify(ctx.state, null, 2)}\n`);
}

function options() {
  const { values } = parseArgs({
    options: {
      'tester-cidr': { type: 'string' }, 'any-address': { type: 'boolean', default: false }, 'use-existing-resource-group': { type: 'boolean', default: false },
      step: { type: 'string', default: 'all' },
      'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
      location: { type: 'string', default: 'eastus2' },
      'foundry-resource-group': { type: 'string', default: 'rg-contosohub' },
      'foundry-account': { type: 'string', default: 'ai-contosohub530569751908' },
      'app-display-name': { type: 'string', default: PURPOSE },
      'email-domain': { type: 'string' },
      'what-if': { type: 'boolean', default: false },
      'rotate-client-secret': { type: 'boolean', default: false },
      config: { type: 'string', default: CONFIG },
      'database-location': { type: 'string' }, 'client-secret-days': { type: 'string' }, admin: { type: 'string' },
      'sign-in': { type: 'string' }, 'credential-months': { type: 'string' },
    },
  });
  const steps = values.step === 'all' ? ['preflight', 'base', 'entra', 'image', 'app'] : values.step.split(',');
  const unknown = steps.filter((s) => !['preflight', 'base', 'entra', 'image', 'app'].includes(s));
  if (unknown.length) throw new Error(`unknown step ${unknown.join(', ')}; use all, preflight, base, entra, image or app`);
  return { ...values, steps, testerCidr: ingressRange({ testerCidr: values['tester-cidr'], anyAddress: values['any-address'] }), secretDays: secretDays(values['client-secret-days']), credentialMonths: credentialMonths(values['credential-months']) };
}

// The subscription and tenant in the state file must match the signed-in account, so a later run
// cannot write into, or tear down, another subscription.
function bindAccount(ctx) {
  const account = azJson(['account', 'show']);
  for (const [key, value] of [['subscriptionId', account.id], ['tenantId', account.tenantId]]) {
    if (ctx.state[key] && ctx.state[key] !== value) throw new Error(`state file names ${key} ${ctx.state[key]}, but the signed-in account uses ${value}`);
    ctx.state[key] = value;
  }
  ctx.groupPath = `/subscriptions/${ctx.state.subscriptionId}/resourceGroups/${ctx.group}`;
}

// The Azure calls and the state write of deployTemplate; tests/deploy-orchestration.test.mjs replaces them.
const IO = { validateDeployment, whatIfDeployment, runDeployment, save: saveState };

export async function deployTemplate(ctx, { databaseFirst = false, credential = 'secret', ...parameters }, io = IO) {
  const database = parameters.database ?? 'sidecar';
  const full = templateForCredential(templateForConsole(templateForDatabase(JSON.parse(fs.readFileSync(TEMPLATE, 'utf8')), database), Boolean(parameters.gatewayAdminFile)), credential);
  const template = databaseFirst ? templateForDatabaseFirst(full) : full;
  const body = deploymentBody(template, {
    runId: ctx.state.runId,
    testerCidr: ctx.opts.testerCidr,
    anyAddress: ctx.opts['any-address'],
    foundryResourceGroup: ctx.opts['foundry-resource-group'],
    foundryAccountName: ctx.opts['foundry-account'],
    ...parameters,
    database,
  });
  const name = databaseFirst ? 'claude-gw-db' : parameters.deployApp ? 'claude-gw-app' : 'claude-gw-base';
  const previewOnly = ctx.opts['what-if'];
  // Every deployment is previewed before it runs (docs/CHARTER.md, constraints); --what-if stops there.
  const result = await deployWithPreview({
    validate: () => { say(`validating deployment ${name}`); return io.validateDeployment(ctx.groupPath, name, body); },
    whatIf: () => io.whatIfDeployment(ctx.groupPath, name, body),
    report: (changes) => {
      say(`what-if for ${name}${previewOnly ? '; nothing changes' : ', before it runs'}:`);
      for (const line of whatIfLines(changes)) say(`  ${line}`);
    },
    run: () => {
      // The deployment can grant the gateway identity a role on this Foundry account even when a later
      // part fails, so teardown learns the account before the request goes out (Architect and Coder review,
      // round 3).
      const target = { resourceGroup: ctx.opts['foundry-resource-group'], account: ctx.opts['foundry-account'] };
      ctx.state.foundryTargets = withFoundryTarget(ctx.state.foundryTargets ?? [], target);
      io.save(ctx);
      say(`running deployment ${name}`);
      return io.runDeployment(ctx.groupPath, name, body);
    },
    previewOnly,
  });
  if (!result) return null;
  const out = Object.fromEntries(Object.entries(result.properties.outputs ?? {}).map(([key, output]) => [key, output.value]));
  if (databaseFirst) return out;
  Object.assign(ctx.state, stateFromOutputs(out));
  // Re-creating the Foundry role assignment by intent is the repair the live harness names for an
  // unrestored removal of it (tests/live/lib.mjs, restoreCommand).
  if (restoredByDeployment(ctx.state.pendingRestore, out)) {
    delete ctx.state.pendingRestore;
    say('the Foundry role assignment is deployed again; the outstanding restore record is cleared');
  }
  io.save(ctx);
  return out;
}

async function stepBase(ctx) {
  const group = await arm('GET', `${ctx.groupPath}?${GROUP_API}`, undefined, { ok: [200, 404] });
  if (group.status === 404 && ctx.opts['what-if']) return say(`what-if: resource group ${ctx.group} does not exist and would be created`);
  let decision;
  try {
    decision = groupDecision({ status: group.status, tags: group.json?.tags ?? {}, state: ctx.state, useExisting: ctx.opts['use-existing-resource-group'] });
  } catch (error) { throw new Error(`resource group ${ctx.group}: ${error.message}`); }
  ctx.state.runId ??= decision.runId ?? randomUUID();
  if (decision.action === 'create') {
    say(`creating resource group ${ctx.group} (runId ${ctx.state.runId})`);
    await arm('PUT', `${ctx.groupPath}?${GROUP_API}`, { location: ctx.opts.location, tags: { purpose: PURPOSE, runId: ctx.state.runId } });
  }
  if (decision.existingGroup) {
    // ADR-0018: an existing group is never deleted; what is added carries this run's runId, and nothing is replaced.
    const listed = (await arm('GET', `${ctx.groupPath}/resources?api-version=2021-04-01`)).json?.value ?? [];
    const clashes = nameClashes(listed, ctx.state.runId);
    if (clashes.length) throw new Error(`resource group ${ctx.group} already holds ${clashes.join(', ')}, named like resources the installer creates but not made by this install; remove or rename them, or use another group`);
    say(`using existing resource group ${ctx.group}: ${listed.length} resource(s) there are left as they are (runId ${ctx.state.runId})`);
  }
  ctx.state.existingGroup = decision.existingGroup;
  saveState(ctx);
  if ((await preflightInput(ctx)).database === 'managed') await databaseFirst(ctx);
  const out = await deployTemplate(ctx, { deployApp: false });
  if (!out) return;
  say(`base ready: registry ${out.acrLoginServer}, gateway host ${out.gatewayFqdn}`);
}

// The database the rendered configuration names (ADR-0012); sidecar when --config is not there yet.
const configuredDatabase = (ctx) => (fs.existsSync(path.resolve(ctx.opts.config)) ? databaseOf(fs.readFileSync(path.resolve(ctx.opts.config), 'utf8')) : 'sidecar');

// The tools on this machine (P-48, T-163); `az version` is null when the Azure CLI does not answer.
const localTools = () => { let az = null; try { az = azJson(['version']); } catch { /* reported by toolProblems */ } return { node: process.versions.node, az }; };
const signedInUser = async () => { const me = (await graph('GET', '/me?$select=mail,userPrincipalName')).json; return { mail: me.mail, upn: me.userPrincipalName }; };

async function preflightInput(ctx) {
  const admin = ctx.opts.admin ? JSON.parse(fs.readFileSync(path.resolve(ctx.opts.admin), 'utf8')) : {};
  return { arm, subscriptionPath: `/subscriptions/${ctx.state.subscriptionId}`, groupPath: ctx.groupPath, group: ctx.group, state: ctx.state,
    useExisting: ctx.opts['use-existing-resource-group'], location: ctx.opts.location, models: admin.models ?? [],
    foundry: { resourceGroup: ctx.opts['foundry-resource-group'], account: ctx.opts['foundry-account'] },
    database: admin.deployment?.database ?? configuredDatabase(ctx), databaseOption: ctx.opts['database-location'],
    emailClaim: admin.deployment?.emailClaim, ...(ctx.opts.admin ? { signedIn: await signedInUser(), graph, tools: localTools() } : {}) };
}

// ADR-0018: read-only; prints one line per check and stops the install on a failure.
async function stepPreflight(ctx) {
  const result = await runPreflight(await preflightInput(ctx));
  for (const l of result.lines) say(`preflight: ${l}`);
  if (!result.ok) throw Object.assign(new Error('preflight found a problem (FAIL above); nothing was changed. Fix it and run the installer again.'), { expected: true });
  say('preflight: passed; nothing was changed');
}

// ADR-0018: the managed database is created before anything else, in the first usable region of the list.
async function databaseFirst(ctx) {
  // 404/409: the provider is not registered yet, so no server exists.
  const existing = await existingServer({ arm, groupPath: ctx.groupPath }).catch((e) => ([404, 409].includes(e.status) ? null : Promise.reject(e)));
  let regions = databaseRegions(ctx.opts['database-location'], existing?.location ?? ctx.opts.location);
  // Registered before the region check, which an unregistered provider cannot answer (code review, 2026-11-03).
  if (!ctx.opts['what-if']) await ensureProvider({ arm, subscriptionPath: `/subscriptions/${ctx.state.subscriptionId}`, say });
  if (!existing) {
    const { databaseRegions: usable, lines } = await runPreflight({ ...(await preflightInput(ctx)), database: 'managed', foundry: null, graph: null, tools: null, signedIn: undefined });
    if (!usable.length) throw new Error(`no usable database region:\n  ${lines.filter((l) => /database/.test(l)).join('\n  ')}`);
    regions = usable;
  }
  if (ctx.opts['what-if']) return say(`what-if: the managed database would be created first, trying ${regions.join(', ')}`);
  const created = await createDatabaseFirst({ regions, existing, say,
    // A throwaway password: the app stage's deployment sets the one the gateway uses (U-136).
    deploy: (region) => deployTemplate(ctx, { databaseFirst: true, database: 'managed', databaseLocation: region, postgresPassword: databasePassword(newSecret(32)) }),
    remove: async (region) => {
      const left = await existingServer({ arm, groupPath: ctx.groupPath }).catch(() => null);
      if (left?.location === region) await arm('DELETE', `${left.id}?api-version=2024-08-01`, undefined, { ok: [200, 202, 204, 404] });
    } });
  Object.assign(ctx.state, created);
  saveState(ctx);
}

async function stepEntra(ctx) {
  if (ctx.opts['what-if']) return say('what-if previews ARM deployments only; the entra step is skipped');
  if (!ctx.state.gatewayFqdn) throw new Error('run --step base first: the redirect URI needs the gateway host name');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const me = (await graph('GET', '/me?$select=id,mail,userPrincipalName')).json;
  const email = emailDomainFor({ option: ctx.opts['email-domain'], mail: me.mail, upn: me.userPrincipalName });
  if (email.from === 'userPrincipalName') say(`the signed-in user has no mail address; the gateway admits email domain ${email.domain}, from the sign-in name (pass -EmailDomain to choose another). Accounts with no mail address also need "emailClaim": "preferred_username" under deployment in the admin file`);
  ctx.state.tester = { objectId: me.id, emailDomain: email.domain };
  const redirectUri = redirectUriFor(ctx.state.gatewayFqdn);
  const tags = [PURPOSE, `runId:${ctx.state.runId}`];
  const body = buildApplication(manifest, { displayName: ctx.opts['app-display-name'], redirectUri, tags });

  const existing = ctx.state.application
    ? await graph('GET', `/applications/${ctx.state.application.id}`, undefined, { ok: [200, 404] })
    : { status: 404 };
  if (existing.status === 404) {
    const created = (await graph('POST', '/applications', body)).json;
    ctx.state.application = { id: created.id, appId: created.appId };
    saveState(ctx);
    say(`registered app ${created.appId}`);
  } else {
    await graph('PATCH', `/applications/${ctx.state.application.id}`, { web: body.web, optionalClaims: body.optionalClaims });
    say(`updated app ${ctx.state.application.appId}`);
  }

  const { appId } = ctx.state.application;
  let sp = await retry(() => graph('GET', `/servicePrincipals(appId='${appId}')?$select=id`, undefined, { ok: [200, 404] }));
  if (sp.status === 404) {
    // Assignment is not required: an app that requires it accepts no user consent (U-39). The gateway
    // admits only tokens that carry a gateway role (oidc.allowed_groups on the roles claim).
    sp = await retry(() => graph('POST', '/servicePrincipals', { appId, appRoleAssignmentRequired: false, tags: [...tags, 'WindowsAzureActiveDirectoryIntegratedApp'] }));
  }
  ctx.state.servicePrincipal = { id: sp.json.id };
  saveState(ctx);

  const owners = (await graph('GET', `/servicePrincipals/${sp.json.id}/owners?$select=id`)).json.value.map((o) => o.id);
  ctx.state.servicePrincipal.testerIsOwner = owners.includes(me.id);
  const roleId = manifest.appRoles.find((r) => r.value === TESTER_ROLE).id;
  const assignments = (await graph('GET', `/servicePrincipals/${sp.json.id}/appRoleAssignedTo?$select=id,principalId,appRoleId`)).json.value;
  const mine = assignments.find((a) => a.principalId === me.id && a.appRoleId === roleId);
  if (mine) {
    ctx.state.testerAssignmentId = mine.id;
  } else {
    const created = await retry(() => graph('POST', `/servicePrincipals/${sp.json.id}/appRoleAssignedTo`, { principalId: me.id, resourceId: sp.json.id, appRoleId: roleId }));
    ctx.state.testerAssignmentId = created.json.id;
  }
  const pending = ctx.state.pendingRestore;
  if (pending?.kind === 'appRole' && pending.principalId === me.id && pending.appRoleId === roleId && pending.servicePrincipalId === sp.json.id) {
    delete ctx.state.pendingRestore;
    say(`the tester holds ${TESTER_ROLE} again; the outstanding restore record is cleared`);
  }
  saveState(ctx);
  say(`service principal ${sp.json.id}: tester holds ${TESTER_ROLE}; tester is owner: ${ctx.state.servicePrincipal.testerIsOwner}`);
}

function stepImage(ctx) {
  if (ctx.opts['what-if']) return say('what-if previews ARM deployments only; the image step is skipped');
  const acr = ctx.state.acrName;
  if (!acr) throw new Error('run --step base first: no registry recorded');
  const pgTag = 'postgres:16-alpine';
  // Only the in-app database runs the PostgreSQL image; a managed database (recorded by base, ADR-0018) needs none.
  const sidecar = !ctx.state.pgServerName;
  if (sidecar && runAz(['acr', 'repository', 'show', '--name', acr, '--image', pgTag], { allowFailure: true }).status !== 0) {
    say(`importing docker.io/library/${pgTag}`);
    runAz(['acr', 'import', '--name', acr, '--source', `docker.io/library/${pgTag}`, '--image', pgTag], { inherit: true });
  }
  const version = /^ARG CLAUDE_VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(IMAGE_DIR, 'Dockerfile'), 'utf8'))[1];
  const tag = `claude-gateway:${version}-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
  say(`building ${tag} with ACR Tasks`);
  runAz(['acr', 'build', '--registry', acr, '--image', tag, IMAGE_DIR], { inherit: true });
  const digest = (name) => azJson(['acr', 'repository', 'show', '--name', acr, '--image', name]).digest;
  ctx.state.images = {
    gateway: `${ctx.state.acrLoginServer}/claude-gateway@${digest(tag)}`,
    ...(sidecar ? { postgres: `${ctx.state.acrLoginServer}/postgres@${digest(pgTag)}` } : {}),
    gatewayTag: tag,
  };
  saveState(ctx);
  say(`images pinned: ${ctx.state.images.gateway}`);
}

// Waits for the latest revision to be ready; after a rotation, for one other than the revision that
// still holds the old secret.
async function waitForReady(ctx, { notRevision = null } = {}) {
  const appPath = `${ctx.groupPath}/providers/Microsoft.App/containerApps/${ctx.state.appName}?${APP_API}`;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const { json } = await arm('GET', appPath);
    const { latestRevisionName, latestReadyRevisionName, provisioningState } = json.properties;
    if (provisioningState === 'Succeeded' && latestRevisionName && latestRevisionName === latestReadyRevisionName
      && latestReadyRevisionName !== notRevision) {
      say(`revision ${latestRevisionName} ready`);
      return latestRevisionName;
    }
    if (Date.now() > deadline) throw new Error(`revision ${latestRevisionName} not ready after 15 minutes (${provisioningState})`);
    await sleep(15_000);
  }
}

// The deployment is of no use unless this machine gets through both allow lists (U-33).
async function verifyReach(ctx) {
  const url = `https://${ctx.state.gatewayFqdn}/.well-known/oauth-authorization-server`;
  const status = await fetch(url).then((r) => r.status, (e) => `error (${e.message})`);
  if (status === 200) return say('discovery document from this machine: 200');
  throw new Error([
    `the gateway is ready, but this machine gets ${status} for ${url}.`,
    `A 403 means this machine's egress address is outside ${ctx.state.testerCidr} (docs/UNKNOWNS.md, U-33).`,
    'Sample the address several times (curl.exe -s https://api.ipify.org), take the narrowest range that holds every',
    'sample, and run the installer again with -TesterCidr <range> -Steps app (docs/learn/tutorial-first-install.md)',
  ].join('\n  '));
}

async function stepApp(ctx) {
  if (!ctx.state.images?.gateway) throw new Error('run --step image first: no image recorded');
  if (!ctx.state.application?.appId) throw new Error('run --step entra first: no app registration recorded');
  const preview = ctx.opts['what-if'];
  // Written by earlier versions; the live app now decides (keyPlan).
  delete ctx.state.pendingKeyId;
  delete ctx.state.passwordKeyIds;
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const secrets = await appSecrets(ctx, { preview, template });
  const saved = consoleConfig(secrets.live);
  if (saved) say(`the admin console saved this gateway's configuration; the app step keeps it and does not deploy ${ctx.opts.config}`);
  const gatewayConfigYaml = saved?.yaml ?? fs.readFileSync(path.resolve(ctx.opts.config), 'utf8');
  // With a certificate the image's entrypoint replaces the client_secret line before the gateway reads it (ADR-0016).
  const unset = unsetConfigVariables(gatewayConfigYaml, template).filter((v) => !(secrets.mode === 'certificate' && v === 'OIDC_CLIENT_SECRET'));
  if (unset.length) throw new Error(`${ctx.opts.config} references ${unset.map((v) => `\${${v}}`).join(', ')}, which the template does not set on the gateway container; the gateway would not boot`);
  // ADR-0012: the rendered store decides the database, so the admin file stays the one source of the choice.
  const database = databaseOf(gatewayConfigYaml);
  const { databaseLocation } = await prepareDatabase({ arm, ctx, database, preview, appExists: secrets.live.secretNames.length > 0, say });
  const out = await deployTemplate(ctx, {
    deployApp: true,
    database,
    ...(databaseLocation ? { databaseLocation } : {}),
    gatewayImage: ctx.state.images.gateway,
    postgresImage: ctx.state.images.postgres ?? '',
    oidcClientId: ctx.state.application.appId,
    oidcCredentialId: secrets.credentialId,
    allowedEmailDomain: ctx.state.tester.emailDomain,
    gatewayConfigYaml,
    credential: secrets.mode,
    ...(secrets.mode === 'certificate' ? { oidcCertificatePem: secrets.oidc } : { oidcClientSecret: secrets.oidc }),
    gatewayJwtSecret: secrets.jwt,
    postgresPassword: database === 'managed' ? databasePassword(secrets.pg) : secrets.pg,
    gatewayAdminWriteKey: secrets.admin,
    gatewayAdminPacerKey: secrets.pacer,
    ...(saved ? { gatewayAdminFile: saved.adminFile, configUpdatedAt: saved.stamp } : {}),
  });
  if (!out) return;
  if (database === 'managed') await finishDatabase({ arm, ctx, out, databaseLocation, save: () => saveState(ctx), say });
  const revision = await waitForReady(ctx, { notRevision: secrets.rotated ? secrets.live.readyRevision : null });
  const unpromoted = promotionError({ revision, after: await liveApp(ctx), keyId: secrets.credentialId });
  if (unpromoted) throw new Error(unpromoted);
  // Both allow lists now hold the range, so it becomes the recorded one (Architect and UX review, round 2).
  Object.assign(ctx.state, { revision, activeKeyId: secrets.credentialId, testerCidr: ctx.opts.testerCidr,
    signIn: { mode: secrets.mode, credentialId: secrets.credentialId, endsAt: secrets.endsAt ?? ctx.state.signIn?.endsAt ?? null } });
  saveState(ctx);
  await removeKeys(ctx, supersededKeys({ credentials: await passwordCredentials(ctx), ownName: ownKeyName(ctx), keyId: secrets.credentialId }), 'superseded');
  await finishCredential(ctx, secrets);
  await verifyReach(ctx);
  say(`gateway: https://${ctx.state.gatewayFqdn}`);
}

async function main() {
  const opts = options();
  const ctx = { opts, group: opts['resource-group'], state: readState(opts['resource-group']) };
  bindAccount(ctx);
  // State files from before foundryTargets name one account; deployTemplate adds each account a
  // deployment uses, so teardown looks for grants on every one (foundryAccountIds).
  if (ctx.state.foundry) {
    ctx.state.foundryTargets = withFoundryTarget(ctx.state.foundryTargets ?? [], ctx.state.foundry);
    delete ctx.state.foundry;
  }
  ctx.state.resourceGroup = ctx.group;
  const steps = { preflight: stepPreflight, base: stepBase, entra: stepEntra, image: stepImage, app: stepApp };
  for (const step of opts.steps) await steps[step](ctx);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // An expected refusal, such as a preflight FAIL, needs its message, not a stack trace.
    console.error(redactSecrets(`[deploy] ${error.expected ? error.message : error.stack ?? error.message}`));
    process.exit(1);
  });
}
