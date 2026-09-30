#!/usr/bin/env node
// Deploys the Claude apps gateway test environment on Azure Container Apps (docs/adr/0003-*.md).
//   node infra/azure-test/deploy.mjs --tester-cidr 203.0.113.0/26 [--step all|base|entra|image|app] [--what-if]
//     [--rotate-client-secret]
// Steps: base (resource group, registry, identity, workspace, environment, role assignments), entra
// (app registration, service principal, tester's app role), image (PostgreSQL import, gateway build),
// app (client secret and the Container App). Secrets exist only in memory and in HTTPS request bodies;
// the state file under .state/ holds non-secret identifiers for teardown.mjs.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { arm, graph, retry, runDeployment, validateDeployment, whatIfDeployment } from './lib/azure-rest.mjs';
import {
  assertTesterCidr, buildApplication, deployWithPreview, deploymentBody, keyPlan, newSecret, promotionError, redirectUriFor,
  restoredByDeployment, secretEndDate, stateFromOutputs, supersededKeys, whatIfLines, withFoundryTarget,
} from './lib/plan.mjs';
import { redactSecrets, registerSecret } from './lib/secrets.mjs';
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
      'tester-cidr': { type: 'string' },
      step: { type: 'string', default: 'all' },
      'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
      location: { type: 'string', default: 'eastus2' },
      'foundry-resource-group': { type: 'string', default: 'rg-contosohub' },
      'foundry-account': { type: 'string', default: 'ai-contosohub530569751908' },
      'app-display-name': { type: 'string', default: PURPOSE },
      'email-domain': { type: 'string' },
      'what-if': { type: 'boolean', default: false },
      'rotate-client-secret': { type: 'boolean', default: false },
    },
  });
  const steps = values.step === 'all' ? ['base', 'entra', 'image', 'app'] : values.step.split(',');
  const unknown = steps.filter((s) => !['base', 'entra', 'image', 'app'].includes(s));
  if (unknown.length) throw new Error(`unknown step ${unknown.join(', ')}; use all, base, entra, image or app`);
  if (!values['tester-cidr']) throw new Error('--tester-cidr is required, for example --tester-cidr 203.0.113.0/26');
  return { ...values, steps, testerCidr: assertTesterCidr(values['tester-cidr']) };
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

export async function deployTemplate(ctx, parameters, io = IO) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const body = deploymentBody(template, {
    runId: ctx.state.runId,
    testerCidr: ctx.opts.testerCidr,
    foundryResourceGroup: ctx.opts['foundry-resource-group'],
    foundryAccountName: ctx.opts['foundry-account'],
    ...parameters,
  });
  const name = parameters.deployApp ? 'claude-gw-app' : 'claude-gw-base';
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
  if (group.status === 404) {
    ctx.state.runId ??= randomUUID();
    say(`creating resource group ${ctx.group} (runId ${ctx.state.runId})`);
    await arm('PUT', `${ctx.groupPath}?${GROUP_API}`, { location: ctx.opts.location, tags: { purpose: PURPOSE, runId: ctx.state.runId } });
  } else {
    const tags = group.json.tags ?? {};
    if (tags.purpose !== PURPOSE || (ctx.state.runId && tags.runId !== ctx.state.runId)) {
      throw new Error(`resource group ${ctx.group} exists without this tool's purpose and runId tags; refusing to use it`);
    }
    ctx.state.runId ??= tags.runId;
  }
  saveState(ctx);
  const out = await deployTemplate(ctx, { deployApp: false });
  if (!out) return;
  say(`base ready: registry ${out.acrLoginServer}, gateway host ${out.gatewayFqdn}`);
}

async function stepEntra(ctx) {
  if (ctx.opts['what-if']) return say('what-if previews ARM deployments only; the entra step is skipped');
  if (!ctx.state.gatewayFqdn) throw new Error('run --step base first: the redirect URI needs the gateway host name');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const me = (await graph('GET', '/me?$select=id,mail,userPrincipalName')).json;
  ctx.state.tester = { objectId: me.id, emailDomain: ctx.opts['email-domain'] ?? me.mail?.split('@')[1] };
  if (!ctx.state.tester.emailDomain) throw new Error('the signed-in user has no mail address; pass --email-domain');
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
  if (runAz(['acr', 'repository', 'show', '--name', acr, '--image', pgTag], { allowFailure: true }).status !== 0) {
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
    postgres: `${ctx.state.acrLoginServer}/postgres@${digest(pgTag)}`,
    gatewayTag: tag,
  };
  saveState(ctx);
  say(`images pinned: ${ctx.state.images.gateway}`);
}

const credentialIdOf = (template) => template?.containers?.find((c) => c.name === 'gateway')?.env
  ?.find((e) => e.name === 'OIDC_CREDENTIAL_ID')?.value || null;
const ownKeyName = (ctx) => `gateway-test ${ctx.state.runId}`;
const passwordCredentials = async (ctx) => (await graph('GET', `/applications/${ctx.state.application.id}?$select=passwordCredentials`)).json.passwordCredentials;

// What the live app holds (ADR-0003, "Redeploys, rotation and recovery"): its secrets, the client
// secret's key id deployed with them in the app's template, and the latest ready revision with the key
// id it reads. The state file is not consulted: a run can stop between any two of these changes.
async function liveApp(ctx) {
  const appPath = `${ctx.groupPath}/providers/Microsoft.App/containerApps/${ctx.state.appName}`;
  const app = await arm('GET', `${appPath}?${APP_API}`, undefined, { ok: [200, 404] });
  if (app.status === 404) return { secrets: {}, installedKeyId: null, readyRevision: null, readyKeyId: null };
  const listed = await arm('POST', `${appPath}/listSecrets?${APP_API}`);
  const secrets = Object.fromEntries(listed.json.value.map((s) => [s.name, registerSecret(s.value)]));
  const readyRevision = app.json.properties.latestReadyRevisionName || null;
  const revision = readyRevision ? await arm('GET', `${appPath}/revisions/${readyRevision}?${APP_API}`) : null;
  return { secrets, installedKeyId: credentialIdOf(app.json.properties.template), readyRevision,
    readyKeyId: credentialIdOf(revision?.json.properties.template) };
}

// Secrets for the app. The running app's JWT secret and database password are reused. keyPlan decides
// from the live app whether its client secret is reused and which of this run's secrets have no holder.
// A new client secret is read only by the revision deployed with it. --what-if reports the plan only.
async function appSecrets(ctx, { preview }) {
  const live = await liveApp(ctx);
  const jwt = registerSecret(live.secrets['jwt-secret'] || newSecret(32));
  const pg = registerSecret(live.secrets['pg-password'] || newSecret(32));
  const installedSecret = live.secrets['oidc-client-secret'];
  const plan = keyPlan({ credentials: await passwordCredentials(ctx), ownName: ownKeyName(ctx), now: Date.now(),
    readyRevision: live.readyRevision, readyKeyId: live.readyKeyId,
    installed: installedSecret ? { keyId: live.installedKeyId, hint: installedSecret.slice(0, 3) } : null,
    ...(ctx.opts['rotate-client-secret'] ? { minRemainingMs: Infinity } : {}) });
  say(`client secret: ${plan.action === 'reuse' ? `reuse ${plan.keyId}` : 'add a new one'}; secrets with no holder: ${plan.removeNow.join(', ') || 'none'}`);
  if (preview) {
    return { jwt, pg, oidc: registerSecret(installedSecret || newSecret(32)), credentialId: plan.keyId ?? 'what-if-new-credential', live, rotated: plan.action === 'rotate' };
  }
  await removeKeys(ctx, plan.removeNow, 'unused');
  if (plan.action === 'reuse') return { jwt, pg, oidc: installedSecret, credentialId: plan.keyId, live, rotated: false };
  const credential = { displayName: ownKeyName(ctx), endDateTime: secretEndDate(new Date(), 7) };
  const created = (await graph('POST', `/applications/${ctx.state.application.id}/addPassword`, { passwordCredential: credential })).json;
  say(`added client secret ${created.keyId}; it ends ${created.endDateTime}`);
  return { jwt, pg, oidc: registerSecret(created.secretText), credentialId: created.keyId, live, rotated: true };
}

// Removes client secrets and confirms each is gone. A secret that remains fails the run; the next app
// step finds it again, because keyPlan is recomputed from the live app on every run.
async function removeKeys(ctx, keyIds, why) {
  if (!keyIds.length) return;
  for (const keyId of keyIds) {
    try {
      await graph('POST', `/applications/${ctx.state.application.id}/removePassword`, { keyId });
      say(`removed ${why} client secret ${keyId}`);
    } catch (error) {
      say(`removing ${why} client secret ${keyId} failed (${error.status ?? 'no status'}); checking whether it is gone`);
    }
  }
  for (let attempt = 1; ; attempt++) {
    const left = (await passwordCredentials(ctx)).filter((c) => keyIds.includes(c.keyId)).map((c) => c.keyId);
    if (!left.length) return;
    if (attempt === 6) throw new Error(`client secrets ${left.join(', ')} are still registered; the next app step removes them`);
    await sleep(5000);
  }
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
    'sample, and run: node infra/azure-test/deploy.mjs --step app --tester-cidr <range>',
  ].join('\n  '));
}

async function stepApp(ctx) {
  if (!ctx.state.images?.gateway) throw new Error('run --step image first: no image recorded');
  if (!ctx.state.application?.appId) throw new Error('run --step entra first: no app registration recorded');
  const preview = ctx.opts['what-if'];
  // Written by earlier versions; the live app now decides (keyPlan).
  delete ctx.state.pendingKeyId;
  delete ctx.state.passwordKeyIds;
  const secrets = await appSecrets(ctx, { preview });
  const out = await deployTemplate(ctx, {
    deployApp: true,
    gatewayImage: ctx.state.images.gateway,
    postgresImage: ctx.state.images.postgres,
    oidcClientId: ctx.state.application.appId,
    oidcCredentialId: secrets.credentialId,
    allowedEmailDomain: ctx.state.tester.emailDomain,
    gatewayConfigYaml: fs.readFileSync(CONFIG, 'utf8'),
    oidcClientSecret: secrets.oidc,
    gatewayJwtSecret: secrets.jwt,
    postgresPassword: secrets.pg,
  });
  if (!out) return;
  const revision = await waitForReady(ctx, { notRevision: secrets.rotated ? secrets.live.readyRevision : null });
  const unpromoted = promotionError({ revision, after: await liveApp(ctx), keyId: secrets.credentialId });
  if (unpromoted) throw new Error(unpromoted);
  // Both allow lists now hold the range, so it becomes the recorded one (Architect and UX review, round 2).
  Object.assign(ctx.state, { revision, activeKeyId: secrets.credentialId, testerCidr: ctx.opts.testerCidr });
  saveState(ctx);
  await removeKeys(ctx, supersededKeys({ credentials: await passwordCredentials(ctx), ownName: ownKeyName(ctx), keyId: secrets.credentialId }), 'superseded');
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
  const steps = { base: stepBase, entra: stepEntra, image: stepImage, app: stepApp };
  for (const step of opts.steps) await steps[step](ctx);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(`[deploy] ${error.stack ?? error.message}`));
    process.exit(1);
  });
}
