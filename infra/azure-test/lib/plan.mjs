// Pure helpers for the Azure test deployment (docs/adr/0003-*.md): address ranges, the app registration
// body, secret generation, ARM request bodies and gateway config variables. No network or file access.
import { randomBytes as cryptoRandomBytes } from 'node:crypto';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
// Private, shared, loopback, link-local, "this network" and multicast/reserved space. The ingress
// sees public client addresses, so a tester range inside these would admit no one.
const PRIVATE_OR_RESERVED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/3'];
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_MS = 86_400_000;

export function parseIpv4(text) {
  const m = IPV4.exec(String(text).trim());
  const octets = m?.slice(1).map(Number);
  if (!octets || octets.some((o) => o > 255)) throw new Error(`not an IPv4 address: ${JSON.stringify(text)}`);
  return octets.reduce((n, o) => n * 256 + o, 0);
}

export const formatIpv4 = (n) => [3, 2, 1, 0].map((i) => Math.floor(n / 256 ** i) % 256).join('.');

const blockSize = (prefix) => 2 ** (32 - prefix);

export function parseCidr(text) {
  const m = CIDR.exec(String(text).trim());
  if (!m || Number(m[2]) > 32) throw new Error(`not an IPv4 CIDR range: ${JSON.stringify(text)}`);
  return { network: parseIpv4(m[1]), prefix: Number(m[2]) };
}

export function cidrContains(cidr, ip) {
  const { network, prefix } = parseCidr(cidr);
  const size = blockSize(prefix);
  const start = network - (network % size);
  const address = parseIpv4(ip);
  return address >= start && address < start + size;
}

export const isPrivateOrReserved = (ip) => PRIVATE_OR_RESERVED.some((range) => cidrContains(range, ip));

// The range both allow lists admit. Refuses anything wider than minPrefix, a range written with host
// bits set (the reader cannot tell which range was meant), and private or reserved space.
export function assertTesterCidr(text, { minPrefix = 24 } = {}) {
  const { network, prefix } = parseCidr(text);
  const shown = String(text).trim();
  if (prefix < minPrefix) throw new Error(`tester range ${shown} is too wide: use a /${minPrefix} or narrower`);
  if (network % blockSize(prefix) !== 0) throw new Error(`${shown} is not a network address for a /${prefix}`);
  if (isPrivateOrReserved(formatIpv4(network))) {
    throw new Error(`${shown} is a private or reserved range; the ingress sees public client addresses`);
  }
  return `${formatIpv4(network)}/${prefix}`;
}

// Smallest aligned range that holds every sampled egress address (docs/UNKNOWNS.md, U-33).
export function coveringCidr(ips) {
  if (!ips.length) throw new Error('coveringCidr needs at least one address');
  const numbers = ips.map(parseIpv4);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  for (let prefix = 32; prefix > 0; prefix--) {
    const size = blockSize(prefix);
    const start = low - (low % size);
    if (high < start + size) return `${formatIpv4(start)}/${prefix}`;
  }
  return '0.0.0.0/0';
}

export function redirectUriFor(fqdn) {
  if (!HOST_NAME.test(fqdn)) throw new Error(`not a host name: ${JSON.stringify(fqdn)}`);
  return `https://${fqdn}/oauth/callback`;
}

// The Microsoft Graph application body: the checked-in manifest plus the values known only at deploy
// time. The manifest itself carries no credentials and no redirect URI.
export function buildApplication(manifest, { displayName, redirectUri, tags = [] }) {
  if (manifest.passwordCredentials || manifest.keyCredentials) throw new Error('the manifest must not carry credentials');
  if (manifest.web?.redirectUris?.length) throw new Error('the manifest must not carry redirect URIs; the deploy tool sets the one it uses');
  const app = structuredClone(manifest);
  app.displayName = displayName;
  app.tags = [...tags];
  app.web = { ...(app.web ?? {}), redirectUris: [redirectUri] };
  return app;
}

// End date for a client secret. The tenant's app management policy allows at most 30 days (U-1).
export function secretEndDate(now, days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error(`secret lifetime must be 1 to 30 days, got ${days}`);
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function newSecret(bytes = 32, random = cryptoRandomBytes) {
  if (!Number.isInteger(bytes) || bytes < 32) throw new Error('a secret needs at least 32 bytes of entropy');
  return Buffer.from(random(bytes)).toString('hex');
}

// Request body for PUT .../providers/Microsoft.Resources/deployments/{name}. Secure parameters travel
// only in this body, never on a command line.
export function deploymentBody(template, parameters) {
  const wrapped = Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, { value }]));
  return JSON.stringify({ properties: { mode: 'Incremental', template, parameters: wrapped } });
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Environment variables the gateway expands at boot; an undefined one fails boot.
export function configVariables(yaml) {
  const names = new Set();
  for (const line of yaml.split(/\r?\n/)) {
    for (const m of stripComment(line).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]);
  }
  return [...names].sort();
}

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

// An address inside the range: the first host address, or the range's own address for a /31 or /32.
// The forged X-Forwarded-For probe (T-42) needs an address the allow list admits.
export function addressInside(cidr) {
  const { network, prefix } = parseCidr(cidr);
  const size = blockSize(prefix);
  const start = network - (network % size);
  return formatIpv4(size > 2 ? start + 1 : start);
}

// Which client secret the app step uses, and which of this run's secrets have no holder (ADR-0003,
// "Redeploys, rotation and recovery"). The live app is the record: installed is the key id in the
// app's template, deployed in the same request as the secret listSecrets returns, with the first three
// characters of that secret as a hint Graph also reports; readyKeyId is the key id of the latest ready
// revision. Neither is ever removed. When the installed secret matches no key by id and hint, or a
// ready revision reads a key it does not name (one from before OIDC_CREDENTIAL_ID), no key is known to
// be unused, so nothing is removed until a revision that reads a new key is ready (Coder review, round 3).
export function keyPlan({ credentials, ownName, installed, readyRevision = null, readyKeyId, now, minRemainingMs = DAY_MS }) {
  const match = installed?.keyId ? credentials.find((c) => c.keyId === installed.keyId) : undefined;
  if (installed && (!match || match.hint !== installed.hint)) return { action: 'rotate', removeNow: [] };
  if (readyRevision && !readyKeyId) {
    const reusable = match && Date.parse(match.endDateTime) - now > minRemainingMs;
    return reusable ? { action: 'reuse', keyId: match.keyId, removeNow: [] } : { action: 'rotate', removeNow: [] };
  }
  const keep = new Set([installed?.keyId, readyKeyId].filter(Boolean));
  const removeNow = credentials.filter((c) => c.displayName === ownName && !keep.has(c.keyId)).map((c) => c.keyId);
  if (match && Date.parse(match.endDateTime) - now > minRemainingMs) return { action: 'reuse', keyId: match.keyId, removeNow };
  return { action: 'rotate', removeNow };
}

// After a rollout, no other secret goes until the ready revision is the one waited for and both it and
// the app's template hold the deployed key; otherwise the reason, for the operator.
export function promotionError({ revision, after, keyId }) {
  if (after.readyRevision === revision && after.readyKeyId === keyId && after.installedKeyId === keyId) return null;
  return `revision ${after.readyRevision} reads key ${after.readyKeyId} and the app holds ${after.installedKeyId}, not ${keyId}; no secret was removed`;
}
// This run's secrets other than the one a ready revision now reads.
export const supersededKeys = ({ credentials, ownName, keyId }) => credentials
  .filter((c) => c.displayName === ownName && c.keyId !== keyId).map((c) => c.keyId);

// Every Foundry account a base deployment recorded in this state may have granted the gateway identity
// a role on, so teardown looks at each one (Coder review, round 2).
export function withFoundryTarget(targets, target) {
  const same = (t) => t.resourceGroup.toLowerCase() === target.resourceGroup.toLowerCase() && t.account.toLowerCase() === target.account.toLowerCase();
  return targets.some(same) ? [...targets] : [...targets, target];
}
export function foundryAccountIds(state) {
  const account = (t) => `/subscriptions/${state.subscriptionId}/resourceGroups/${t.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${t.account}`;
  const ids = [...(state.foundryTargets ?? []), ...(state.foundry ? [state.foundry] : [])].map(account);
  const granted = state.foundryRoleAssignmentId?.split('/providers/Microsoft.Authorization/')[0];
  if (granted) ids.push(granted);
  const seen = new Set();
  return ids.filter((id) => !seen.has(id.toLowerCase()) && seen.add(id.toLowerCase()));
}

// The state fields a deployment's outputs set. Both steps deploy the whole template, the Foundry role
// assignment included, so both record its id (Architect review, round 3). A missing output is an error,
// not an undefined field in the state.
const OUTPUT_NAMES = ['acrName', 'acrLoginServer', 'appName', 'gatewayFqdn', 'identityId', 'identityClientId', 'identityPrincipalId',
  'workspaceName', 'workspaceCustomerId', 'foundryRoleAssignmentId'];
export function stateFromOutputs(out) {
  const missing = OUTPUT_NAMES.filter((name) => typeof out[name] !== 'string' || !out[name]);
  if (missing.length) throw new Error(`the deployment returned no ${missing.join(', ')}`);
  return {
    acrName: out.acrName, acrLoginServer: out.acrLoginServer, appName: out.appName, gatewayFqdn: out.gatewayFqdn,
    identity: { id: out.identityId, clientId: out.identityClientId, principalId: out.identityPrincipalId },
    workspace: { name: out.workspaceName, customerId: out.workspaceCustomerId }, foundryRoleAssignmentId: out.foundryRoleAssignmentId,
  };
}

// Whether a deployment re-created, by intent, the Foundry role assignment an unrestored record names.
export const restoredByDeployment = (pending, out) => pending?.kind === 'armRole'
  && typeof pending.assignmentId === 'string' && pending.assignmentId.toLowerCase() === out.foundryRoleAssignmentId.toLowerCase();

// ARM what-if changes as report lines: the change type and resource, then the path of each property a
// Modify creates, deletes or changes. Values are left out; NoEffect changes are skipped.
export function whatIfLines(changes) {
  const paths = (delta, prefix = '') => delta.flatMap((d) => {
    const at = prefix ? `${prefix}.${d.path}` : d.path;
    if (d.children?.length) return paths(d.children, at);
    return d.propertyChangeType === 'NoEffect' ? [] : [`            ${d.propertyChangeType.padEnd(7)} ${at}`];
  });
  return changes.flatMap((c) => [`${c.changeType.padEnd(9)} ${c.resourceId.split('/providers/').at(-1)}`,
    ...(c.changeType === 'Modify' ? paths(c.delta ?? []) : [])]);
}
// Validation, then what-if, then the deployment: changes to existing Azure resources are previewed
// first (docs/CHARTER.md, constraints), and nothing is deployed when the preview fails.
export async function deployWithPreview({ validate, whatIf, report, run, previewOnly }) {
  await validate();
  report(await whatIf());
  return previewOnly ? null : run();
}