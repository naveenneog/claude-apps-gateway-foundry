// ADR-0016 (amended 2026-11-03): how the gateway signs in to Microsoft Entra. Pure functions; lib/credentials.mjs and
// admin-ui's renewal job make the Graph and Container Apps calls.
import crypto from 'node:crypto';
import { splitPem, thumbprints } from './x509.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RENEW_DAYS = 30;
export const ENTRYPOINT = Object.freeze(['/bin/bash', '/usr/local/bin/gateway-entrypoint.sh']);
// The release whose image carries the entrypoint that splits GATEWAY_IDP_PEM (infra/azure-test/image).
const FIRST_RELEASE = [2, 1, 311];

/** certificate or secret: the option, else the recorded mode, else secret for an app that already has one, else certificate. */
export function signInMode({ option, state = {}, liveSecretNames = [] }) {
  if (option !== undefined && !['certificate', 'secret'].includes(option)) throw new Error(`--sign-in takes certificate or secret, not ${JSON.stringify(option)}`);
  if (option) return option;
  if (state.signIn?.mode) return state.signIn.mode;
  return liveSecretNames.includes('oidc-client-secret') ? 'secret' : 'certificate';
}

/**
 * Whether the app stage reuses the running certificate or issues a new one. livePem is the app's oidc-certificate
 * secret (key and certificate), keyCredentials the app registration's. A new one is issued when there is none, when it
 * is not registered in Entra, when it ends within RENEW_DAYS, or when forced. keep is the running certificate, still
 * valid, which stays registered until the new revision is ready (the gateway's rotation order).
 */
export function certPlan({ livePem, keyCredentials = [], ownName, now = new Date(), renewDays = RENEW_DAYS, force = false }) {
  const foreign = keyCredentials.filter((k) => k.displayName !== ownName);
  if (foreign.length) {
    throw new Error(`the app registration holds certificate(s) ${foreign.map((k) => `"${k.displayName}" (${k.customKeyIdentifier})`).join(', ')} not made by the installer; `
      + 'Microsoft Graph replaces all certificates at once, so remove them in Entra ID > App registrations > Certificates & secrets first');
  }
  if (!livePem) return { action: 'issue', keep: null, reason: 'the gateway has no certificate yet' };
  const { certPem } = splitPem(livePem);
  const x = new crypto.X509Certificate(certPem);
  const notAfter = new Date(x.validTo);
  const thumb = thumbprints(certPem).sha1Hex;
  const keep = notAfter > now ? { certPem, thumb } : null;
  const ends = notAfter.toISOString().slice(0, 10);
  if (!keyCredentials.some((k) => String(k.customKeyIdentifier).toUpperCase() === thumb)) return { action: 'issue', keep, reason: `certificate ${thumb} is not registered in Entra` };
  if (force) return { action: 'issue', keep, reason: 'a new certificate was asked for' };
  if (notAfter.getTime() - now.getTime() < renewDays * DAY_MS) return { action: 'issue', keep, reason: `certificate ${thumb} ends ${ends}, within ${renewDays} days` };
  return { action: 'reuse', keep, thumb, notAfter, reason: `certificate ${thumb} ends ${ends}` };
}

/** The PATCH /applications body that registers exactly these certificates. */
export function keyCredentialsBody(certPems, ownName) {
  return { keyCredentials: certPems.map((pem) => ({ type: 'AsymmetricX509Cert', usage: 'Verify', key: thumbprints(pem).der.toString('base64'), displayName: ownName })) };
}

/**
 * The template for a sign-in mode. certificate: the oidc-client-secret secret and OIDC_CLIENT_SECRET become the
 * oidc-certificate secret and GATEWAY_IDP_PEM, and the gateway starts through the image's entrypoint, which writes the
 * key files and switches the configuration to private_key_jwt. secret: unchanged.
 */
export function templateForCredential(template, mode) {
  if (mode === 'secret') return template;
  const t = structuredClone(template);
  t.parameters.oidcCertificatePem = { type: 'securestring', defaultValue: '', metadata: { description: 'ADR-0016: the gateway\'s Entra sign-in key and certificate, PEM.' } };
  const app = t.resources.find((r) => r.type === 'Microsoft.App/containerApps');
  const secrets = app.properties.configuration.secrets.filter((s) => s.name !== 'oidc-client-secret');
  app.properties.configuration.secrets = [...secrets, { name: 'oidc-certificate', value: "[parameters('oidcCertificatePem')]" }];
  const gateway = app.properties.template.containers.find((c) => c.name === 'gateway');
  gateway.env = gateway.env.map((e) => (e.name === 'OIDC_CLIENT_SECRET' ? { name: 'GATEWAY_IDP_PEM', secretRef: 'oidc-certificate' } : e));
  gateway.command = [...ENTRYPOINT];
  gateway.args = [];
  return t;
}

/** Whether an image tag claude-gateway:<version>-<stamp> is from a release whose entrypoint handles a certificate. */
export function imageSupportsCertificate(tag) {
  const m = /:(\d+)\.(\d+)\.(\d+)-/.exec(String(tag ?? ''));
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== FIRST_RELEASE[i]) return v[i] > FIRST_RELEASE[i];
  return true;
}
