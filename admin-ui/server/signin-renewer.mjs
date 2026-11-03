#!/usr/bin/env node
// The gateway's Entra sign-in renewal (ADR-0016, amended 2026-11-03), run daily by the Container Apps job
// job-signin-renewer from the admin-ui image, and by the console's Renew now with force. It uses admin-ui's identity:
// Application.ReadWrite.OwnedBy as an owner of the gateway's app registration, and Container Apps Contributor on the
// gateway app. A certificate or client secret that ends within 30 days is replaced in the gateway's documented order:
// register the new one next to the old, roll out a revision that reads it, then remove the old one
// (https://code.claude.com/docs/en/claude-apps-gateway-config#rotate-the-client-certificate). One summary line a run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArmClient } from './arm-client.mjs';
import { createGraphClient } from './graph-client.mjs';
import { certPlan, keyCredentialsBody, RENEW_DAYS } from '../../infra/azure-test/lib/signin.mjs';
import { selfSignedCertificate, thumbprints } from '../../infra/azure-test/lib/x509.mjs';

const API = 'api-version=2025-07-01';
const DAY_MS = 86_400_000;
const CREDENTIAL_ENV = 'OIDC_CREDENTIAL_ID';

const gatewayEnv = (template) => (template?.containers ?? []).find((c) => c.name === 'gateway')?.env ?? [];
const credentialOf = (template) => gatewayEnv(template).find((e) => e.name === CREDENTIAL_ENV)?.value ?? null;

/** One run. Returns { exitCode, summary }; the summary holds no secret. */
export async function runRenewer({ arm, graph, resourceId, applicationId, months = 12, secretDays = 365, force = false,
  now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, readyTimeoutMs = 15 * 60_000 }) {
  const summary = { evt: 'signin_renewer.run', mode: null, action: null, credentialId: null, endsAt: null };
  try {
    const app = (await arm('GET', `${resourceId}?${API}`)).json;
    if (!app.tags?.runId) throw new Error('the gateway app has no runId tag, so the installer\'s credentials cannot be told from others');
    const ownName = `gateway-test ${app.tags.runId}`;
    const listed = (await arm('POST', `${resourceId}/listSecrets?${API}`)).json?.value ?? [];
    const secrets = Object.fromEntries(listed.map((s) => [s.name, s.value]));
    const appPath = `/applications/${applicationId}`;
    let next;
    if (secrets['oidc-certificate']) {
      summary.mode = 'certificate';
      const keys = (await graph('GET', `${appPath}?$select=keyCredentials`)).json?.keyCredentials ?? [];
      const plan = certPlan({ livePem: secrets['oidc-certificate'], keyCredentials: keys, ownName, now: now(), force });
      if (plan.action === 'reuse') return done({ action: 'reuse', credentialId: plan.thumb, endsAt: plan.notAfter.toISOString() });
      const group = resourceId.split('/')[4] ?? 'gateway';
      const made = selfSignedCertificate({ commonName: `claude-gateway ${group}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 64), months, now: now() });
      const thumb = thumbprints(made.certPem).sha1Hex;
      await graph('PATCH', appPath, keyCredentialsBody([...(plan.keep ? [plan.keep.certPem] : []), made.certPem], ownName));
      for (let i = 0; !((await graph('GET', `${appPath}?$select=keyCredentials`)).json?.keyCredentials ?? []).some((k) => k.customKeyIdentifier === thumb); i++) {
        if (i === 12) throw new Error(`certificate ${thumb} was registered but Entra does not list it after a minute`);
        await sleep(5000);
      }
      next = { secret: 'oidc-certificate', value: `${made.keyPem}${made.certPem}`, credentialId: thumb, endsAt: made.notAfter.toISOString(),
        finish: () => graph('PATCH', appPath, keyCredentialsBody([made.certPem], ownName)) };
    } else if (secrets['oidc-client-secret']) {
      summary.mode = 'secret';
      const passwords = (await graph('GET', `${appPath}?$select=passwordCredentials`)).json?.passwordCredentials ?? [];
      const runningId = credentialOf(app.properties.template);
      const current = passwords.find((p) => p.keyId === runningId);
      const left = current ? new Date(current.endDateTime).getTime() - now().getTime() : -1;
      if (current && !force && left >= RENEW_DAYS * DAY_MS) return done({ action: 'reuse', credentialId: runningId, endsAt: current.endDateTime });
      const endDateTime = new Date(now().getTime() + secretDays * DAY_MS).toISOString();
      const created = (await graph('POST', `${appPath}/addPassword`, { passwordCredential: { displayName: ownName, endDateTime } })).json;
      next = { secret: 'oidc-client-secret', value: created.secretText, credentialId: created.keyId, endsAt: created.endDateTime,
        finish: async () => { if (current && current.displayName === ownName) await graph('POST', `${appPath}/removePassword`, { keyId: current.keyId }); } };
    } else {
      throw new Error('the gateway app has neither an oidc-certificate nor an oidc-client-secret secret');
    }

    // A new revision that reads the new credential: the secret's value and OIDC_CREDENTIAL_ID change in one PUT.
    const merged = (app.properties.configuration.secrets ?? []).map((s) => {
      if (s.name === next.secret) return { name: s.name, value: next.value };
      if (s.keyVaultUrl) return { name: s.name, keyVaultUrl: s.keyVaultUrl, identity: s.identity };
      if (typeof secrets[s.name] !== 'string') throw new Error(`listSecrets returned no value for ${s.name}; nothing was changed`);
      return { name: s.name, value: secrets[s.name] };
    });
    const template = structuredClone(app.properties.template);
    const env = gatewayEnv(template);
    const entry = env.find((e) => e.name === CREDENTIAL_ENV);
    if (entry) entry.value = next.credentialId; else env.push({ name: CREDENTIAL_ENV, value: next.credentialId });
    const body = { location: app.location, properties: { ...app.properties, configuration: { ...app.properties.configuration, secrets: merged }, template } };
    for (const key of ['tags', 'identity', 'kind', 'managedBy', 'extendedLocation']) if (app[key] !== undefined) body[key] = app[key];
    const previous = app.properties.latestRevisionName;
    await arm('PUT', `${resourceId}?${API}`, body);

    const deadline = now().getTime() + readyTimeoutMs;
    for (;;) {
      const p = (await arm('GET', `${resourceId}?${API}`)).json?.properties ?? {};
      if (p.provisioningState === 'Succeeded' && p.latestReadyRevisionName && p.latestReadyRevisionName !== previous
        && p.latestReadyRevisionName === p.latestRevisionName) {
        const rev = (await arm('GET', `${resourceId}/revisions/${encodeURIComponent(p.latestReadyRevisionName)}?${API}`)).json?.properties;
        if (credentialOf(rev?.template) === next.credentialId) break;
      }
      if (now().getTime() >= deadline) throw new Error(`no ready revision reads ${next.credentialId} yet; the old credential stays registered and the next run tries again`);
      await sleep(15_000);
    }
    await next.finish();
    return done({ action: 'renewed', credentialId: next.credentialId, endsAt: next.endsAt });
  } catch (error) {
    log(JSON.stringify({ ...summary, evt: 'signin_renewer.error', message: error.message }));
    return { exitCode: 1, summary: { ...summary, action: 'failed' } };
  }

  function done(result) {
    Object.assign(summary, result);
    log(JSON.stringify(summary));
    return { exitCode: 0, summary };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const missing = ['AZURE_CLIENT_ID', 'GATEWAY_RESOURCE_ID', 'GATEWAY_APPLICATION_OBJECT_ID'].filter((n) => !env[n]);
  if (missing.length) {
    console.error(`sign-in renewer: ${missing.join(', ')} must be set (admin-ui/infra/main.bicep, job-signin-renewer)`);
    process.exitCode = 1;
  } else {
    const cache = new Map();
    runRenewer({
      arm: createArmClient({ clientId: env.AZURE_CLIENT_ID, cache }), graph: createGraphClient({ clientId: env.AZURE_CLIENT_ID, cache }),
      resourceId: env.GATEWAY_RESOURCE_ID, applicationId: env.GATEWAY_APPLICATION_OBJECT_ID,
      months: Number(env.SIGNIN_CERTIFICATE_MONTHS || 12), secretDays: Number(env.SIGNIN_SECRET_DAYS || 365),
    }).then((r) => { process.exitCode = r.exitCode; });
  }
}
