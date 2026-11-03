// The gateway's sign-in credential and the app's other secrets (ADR-0003, "Redeploys, rotation and recovery";
// ADR-0016), moved out of deploy.mjs. Every function reads and changes Azure through lib/azure-rest.mjs.
import { arm, graph } from './azure-rest.mjs';
import { keyPlan, newSecret, secretEndDate, templateForConsole, unmanagedAppSettings } from './plan.mjs';
import { certPlan, imageSupportsCertificate, keyCredentialsBody, signInMode } from './signin.mjs';
import { selfSignedCertificate, splitPem, thumbprints } from './x509.mjs';
import { redactSecrets, registerSecret } from './secrets.mjs';

const APP_API = 'api-version=2024-03-01';
const say = (message) => console.log(redactSecrets(`[deploy] ${message}`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const credentialIdOf = (template) => template?.containers?.find((c) => c.name === 'gateway')?.env
  ?.find((e) => e.name === 'OIDC_CREDENTIAL_ID')?.value || null;
export const ownKeyName = (ctx) => `gateway-test ${ctx.state.runId}`;
export const passwordCredentials = async (ctx) => (await graph('GET', `/applications/${ctx.state.application.id}?$select=passwordCredentials`)).json.passwordCredentials;

// What the live app holds (ADR-0003, "Redeploys, rotation and recovery"): its secrets, the client
// secret's key id deployed with them in the app's template, and the latest ready revision with the key
// id it reads. The state file is not consulted: a run can stop between any two of these changes.
export async function liveApp(ctx) {
  const appPath = `${ctx.groupPath}/providers/Microsoft.App/containerApps/${ctx.state.appName}`;
  const app = await arm('GET', `${appPath}?${APP_API}`, undefined, { ok: [200, 404] });
  if (app.status === 404) return { secrets: {}, secretNames: [], gatewayEnv: [], installedKeyId: null, readyRevision: null, readyKeyId: null };
  const listed = await arm('POST', `${appPath}/listSecrets?${APP_API}`);
  const secrets = Object.fromEntries(listed.json.value.map((s) => [s.name, registerSecret(s.value)]));
  const readyRevision = app.json.properties.latestReadyRevisionName || null;
  const revision = readyRevision ? await arm('GET', `${appPath}/revisions/${readyRevision}?${APP_API}`) : null;
  const env = app.json.properties.template?.containers?.find((c) => c.name === 'gateway')?.env ?? [];
  const gatewayEnv = env.map((e) => e.name);
  return { secrets, secretNames: Object.keys(secrets), gatewayEnv, configUpdatedAt: env.find((e) => e.name === 'CONFIG_UPDATED_AT')?.value, installedKeyId: credentialIdOf(app.json.properties.template), readyRevision,
    readyKeyId: credentialIdOf(revision?.json.properties.template) };
}

// Secrets for the app. The running app's JWT secret, database password and admin API key are reused. keyPlan decides
// from the live app whether its client secret is reused and which of this run's secrets have no holder.
// A new client secret is read only by the revision deployed with it. --what-if reports the plan only.
export async function appSecrets(ctx, { preview, template }) {
  const live = await liveApp(ctx);
  // A redeploy replaces the app's whole secret and variable lists, so it would delete what someone added by hand.
  const unmanaged = unmanagedAppSettings(live, templateForConsole(template, Boolean(live.secrets['gateway-admin-file'])));
  if (unmanaged.length) {
    throw new Error(`${ctx.state.appName} holds ${unmanaged.join(', ')}, which gateway-test.json does not define, so the app step would `
      + 'delete them. A deployment patched by hand, such as a cross-tenant Foundry credential (docs/UNKNOWNS.md, U-80), is not redeployed by '
      + 'this step; remove those settings by hand first if they are no longer needed.');
  }
  const jwt = registerSecret(live.secrets['jwt-secret'] || newSecret(32));
  const pg = registerSecret(live.secrets['pg-password'] || newSecret(32));
  const admin = registerSecret(live.secrets['admin-write-key'] || newSecret(32));
  // ADR-0014: the spend pacer's admin key, read by the configuration only once the soft limit is on.
  const pacer = registerSecret(live.secrets['admin-pacer-key'] || newSecret(32));
  const common = { jwt, pg, admin, pacer, live };
  const mode = signInMode({ option: ctx.opts['sign-in'], state: ctx.state, liveSecretNames: live.secretNames });
  if (mode === 'certificate') {
    try {
      return { ...common, mode, ...(await certificateCredential(ctx, live, preview)) };
    } catch (error) {
      // ADR-0016: a certificate that cannot be made or registered falls back to a client secret, unless one was asked for.
      if (ctx.opts['sign-in'] === 'certificate' || error.noFallback) throw error;
      say(`certificate sign-in did not work (${error.message.split('\n')[0]}); falling back to a client secret of ${ctx.opts.secretDays} days`);
    }
  }
  return { ...common, mode: 'secret', ...(await secretCredential(ctx, live, preview)) };
}

// ADR-0016 (amended): the gateway's own self-signed certificate, registered on its app registration. The running one is
// kept registered next to a new one until the revision with the new one is ready (finishCredential).
async function certificateCredential(ctx, live, preview) {
  if (!imageSupportsCertificate(ctx.state.images?.gatewayTag)) {
    throw Object.assign(new Error(`image ${ctx.state.images?.gatewayTag ?? '(none)'} predates certificate sign-in; run the image stage first (-Steps image,app)`), { noFallback: true });
  }
  const appPath = `/applications/${ctx.state.application.id}`;
  const keyCredentials = async () => (await graph('GET', `${appPath}?$select=keyCredentials`)).json.keyCredentials ?? [];
  const livePem = live.secrets['oidc-certificate'] || null;
  let plan;
  try {
    plan = certPlan({ livePem, keyCredentials: await keyCredentials(), ownName: ownKeyName(ctx), force: ctx.opts['rotate-client-secret'] });
  } catch (error) { throw Object.assign(error, { noFallback: true }); }
  say(`sign-in certificate: ${plan.action === 'reuse' ? 'reuse' : 'issue a new one'} (${plan.reason})`);
  if (plan.action === 'reuse') return { oidc: livePem, credentialId: plan.thumb, rotated: false };
  if (preview) return { oidc: registerSecret(livePem || 'what-if'), credentialId: 'what-if-new-certificate', rotated: true };
  const commonName = `claude-gateway ${ctx.group}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 64);
  const made = selfSignedCertificate({ commonName, months: ctx.opts.credentialMonths });
  const { sha1Hex } = thumbprints(made.certPem);
  await graph('PATCH', appPath, keyCredentialsBody([...(plan.keep ? [plan.keep.certPem] : []), made.certPem], ownKeyName(ctx)));
  for (let attempt = 1; !(await keyCredentials()).some((k) => k.customKeyIdentifier === sha1Hex); attempt++) {
    if (attempt === 12) throw new Error(`certificate ${sha1Hex} was registered but Entra does not list it after a minute`);
    await sleep(5000);
  }
  say(`registered sign-in certificate ${sha1Hex}; it ends ${made.notAfter.toISOString()}`);
  return { oidc: registerSecret(`${made.keyPem}${made.certPem}`), credentialId: sha1Hex, rotated: true, endsAt: made.notAfter.toISOString() };
}

// After the revision that reads the credential is ready: only that certificate stays registered, and, with a
// certificate, no client secret this installer made remains (the secrets are removed by the caller, supersededKeys).
export async function finishCredential(ctx, secrets) {
  const appPath = `/applications/${ctx.state.application.id}`;
  const keys = (await graph('GET', `${appPath}?$select=keyCredentials`)).json.keyCredentials ?? [];
  const own = keys.filter((k) => k.displayName === ownKeyName(ctx));
  if (secrets.mode === 'certificate') {
    if (own.length === 1 && own[0].customKeyIdentifier === secrets.credentialId) return;
    await graph('PATCH', appPath, keyCredentialsBody([splitPem(secrets.oidc).certPem], ownKeyName(ctx)));
    say(`sign-in certificate ${secrets.credentialId} is the only one registered`);
  } else if (own.length && own.length === keys.length) {
    await graph('PATCH', appPath, { keyCredentials: [] });
    say('removed the sign-in certificates this installer registered; the gateway signs in with a client secret');
  }
}

async function secretCredential(ctx, live, preview) {
  const installedSecret = live.secrets['oidc-client-secret'];
  const plan = keyPlan({ credentials: await passwordCredentials(ctx), ownName: ownKeyName(ctx), now: Date.now(),
    readyRevision: live.readyRevision, readyKeyId: live.readyKeyId,
    installed: installedSecret ? { keyId: live.installedKeyId, hint: installedSecret.slice(0, 3) } : null,
    ...(ctx.opts['rotate-client-secret'] ? { minRemainingMs: Infinity } : {}) });
  say(`client secret: ${plan.action === 'reuse' ? `reuse ${plan.keyId}` : 'add a new one'}; secrets with no holder: ${plan.removeNow.join(', ') || 'none'}`);
  if (preview) return { oidc: registerSecret(installedSecret || newSecret(32)), credentialId: plan.keyId ?? 'what-if-new-credential', rotated: plan.action === 'rotate' };
  await removeKeys(ctx, plan.removeNow, 'unused');
  if (plan.action === 'reuse') return { oidc: installedSecret, credentialId: plan.keyId, rotated: false };
  const credential = { displayName: ownKeyName(ctx), endDateTime: secretEndDate(new Date(), ctx.opts.secretDays) };
  const created = (await graph('POST', `/applications/${ctx.state.application.id}/addPassword`, { passwordCredential: credential }).catch((error) => {
    throw new Error(`Entra refused a client secret of ${ctx.opts.secretDays} days (${error.message.split('\n')[0]}). A tenant app management policy can cap secret lifetimes: run again with -ClientSecretDays set to a shorter value`);
  })).json;
  say(`added client secret ${created.keyId}; it ends ${created.endDateTime}`);
  return { oidc: registerSecret(created.secretText), credentialId: created.keyId, rotated: true, endsAt: created.endDateTime };
}

// Removes client secrets and confirms each is gone. A secret that remains fails the run; the next app
// step finds it again, because keyPlan is recomputed from the live app on every run.
export async function removeKeys(ctx, keyIds, why) {
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
