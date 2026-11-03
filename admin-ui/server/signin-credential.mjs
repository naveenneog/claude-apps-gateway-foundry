// The console's Sign-in credential card (ADR-0016, amended 2026-11-03): what the gateway signs in to Entra with, when it
// ends, and Renew now, which runs signin-renewer.mjs's renewal in this process with force. A renewal waits for a new
// gateway revision, which takes minutes, so it runs in the background and status() reports it.
import { runRenewer } from './signin-renewer.mjs';
import { RENEW_DAYS } from '../../infra/azure-test/lib/signin.mjs';

const API = 'api-version=2025-07-01';
const DAY_MS = 86_400_000;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createSignInCredential({ arm, graph, resourceId, applicationId, months = 12, secretDays = 365, now = () => new Date(), renewer = runRenewer }) {
  let lastRun = null;

  async function status() {
    const app = (await arm('GET', `${resourceId}?${API}`)).json;
    const names = ((await arm('POST', `${resourceId}/listSecrets?${API}`)).json?.value ?? []).map((s) => s.name);
    const mode = names.includes('oidc-certificate') ? 'certificate' : names.includes('oidc-client-secret') ? 'secret' : null;
    const env = (app.properties?.template?.containers ?? []).find((c) => c.name === 'gateway')?.env ?? [];
    const credentialId = env.find((e) => e.name === 'OIDC_CREDENTIAL_ID')?.value ?? null;
    let endsAt = null;
    if (mode === 'certificate') {
      const keys = (await graph('GET', `/applications/${applicationId}?$select=keyCredentials`)).json?.keyCredentials ?? [];
      endsAt = keys.find((k) => String(k.customKeyIdentifier).toUpperCase() === String(credentialId).toUpperCase())?.endDateTime ?? null;
    } else if (mode === 'secret') {
      const pw = (await graph('GET', `/applications/${applicationId}?$select=passwordCredentials`)).json?.passwordCredentials ?? [];
      endsAt = pw.find((p) => p.keyId === credentialId)?.endDateTime ?? null;
    }
    const daysLeft = endsAt ? Math.floor((new Date(endsAt).getTime() - now().getTime()) / DAY_MS) : null;
    return { mode, credentialId, endsAt, daysLeft, renewsWithinDays: RENEW_DAYS, defaults: { months, secretDays }, lastRun };
  }

  async function renew({ months: chosen } = {}) {
    if (lastRun?.state === 'running') throw fail(409, 'a renewal is already running; wait for it to finish');
    const m = chosen === undefined || chosen === null || chosen === '' ? months : chosen;
    if (!Number.isInteger(m) || m < 1 || m > 24) throw fail(400, 'months must be a whole number from 1 to 24');
    lastRun = { state: 'running', startedAt: now().toISOString(), months: m };
    const run = lastRun;
    renewer({ arm, graph, resourceId, applicationId, months: m, secretDays, force: true, log: () => {} })
      .then((r) => Object.assign(run, { state: r.exitCode === 0 ? r.summary.action : 'failed', finishedAt: now().toISOString(), credentialId: r.summary.credentialId ?? null }))
      .catch((error) => Object.assign(run, { state: 'failed', finishedAt: now().toISOString(), message: error.message }));
    return { started: true, months: m };
  }

  return { status, renew };
}
