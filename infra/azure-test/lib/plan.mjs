// Pure helpers for the Azure test deployment (docs/adr/0003-*.md): address ranges, the app registration
// body, secret generation, ARM request bodies and gateway config variables. No network or file access.
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

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

// ADR-0017: the gateway's ingress range. --any-address opens it to every address (0.0.0.0/0, which assertTesterCidr
// refuses on purpose, so the wide range always needs the explicit option); otherwise the tester range is checked.
export function ingressRange({ testerCidr, anyAddress = false }) {
  if (anyAddress && testerCidr) throw new Error('pass either --tester-cidr or --any-address, not both');
  if (anyAddress) return '0.0.0.0/0';
  if (!testerCidr) throw new Error('pass --tester-cidr <range> or --any-address');
  return assertTesterCidr(testerCidr);
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

// --client-secret-days as given on the command line: absent means 365 (ADR-0016, amended 2026-11-03).
export function secretDays(text) {
  if (text === undefined) return 365;
  if (!/^[0-9]+$/.test(text) || Number(text) < 1 || Number(text) > 365) throw new Error(`--client-secret-days must be 1 to 365, got '${text}'`);
  return Number(text);
}

// ADR-0016: --credential-months, the sign-in certificate's validity; absent means 12.
export function credentialMonths(text) {
  if (text === undefined) return 12;
  if (!/^[0-9]+$/.test(text) || Number(text) < 1 || Number(text) > 24) throw new Error(`--credential-months must be 1 to 24, got '${text}'`);
  return Number(text);
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

// The secret names and gateway-container variables a template's Container App defines.
function appSettingsOf(template) {
  const app = template.resources.find((r) => r.type === 'Microsoft.App/containerApps');
  const gateway = app.properties.template.containers.find((c) => c.name === 'gateway');
  return { secrets: app.properties.configuration.secrets.map((s) => s.name), env: gateway.env.map((e) => e.name) };
}

// What redeploying the template would delete from the live app: secrets and gateway variables added by hand, such as a
// cross-tenant Foundry credential (docs/UNKNOWNS.md, U-80). live is { secretNames, gatewayEnv }.
// ADR-0016: either sign-in setting belongs to the template, so a switch between a secret and a certificate is not refused.
const SIGN_IN = { secrets: ['oidc-client-secret', 'oidc-certificate'], env: ['OIDC_CLIENT_SECRET', 'GATEWAY_IDP_PEM'] };
export function unmanagedAppSettings(live, template) {
  const tpl = appSettingsOf(template);
  const own = { secrets: [...tpl.secrets, ...SIGN_IN.secrets], env: [...tpl.env, ...SIGN_IN.env] };
  return [...live.secretNames.filter((n) => !own.secrets.includes(n)).map((n) => `secret ${n}`),
    ...live.gatewayEnv.filter((n) => !own.env.includes(n)).map((n) => `environment variable ${n}`)];
}

// The gateway reads the secret-mounted YAML only at startup. A secret update alone starts no revision, so the hash of
// the rendered config is also placed in CONFIG_UPDATED_AT: a changed config starts a revision, an unchanged one does not.
export const configRevision = (yaml) => createHash('sha256').update(yaml).digest('hex');

// ADR-0010: once admin-ui has saved, the app holds the admin file as the gateway-admin-file secret. The app stage
// redeploys that secret and the saved config together, so it neither deletes nor overwrites the console's work.
export function templateForConsole(template, owned) {
  const t = structuredClone(template);
  t.parameters.configUpdatedAt = { type: 'string', defaultValue: '' };
  const app = t.resources.find((r) => r.type === 'Microsoft.App/containerApps');
  app.properties.template.containers.find((c) => c.name === 'gateway').env.push({ name: 'CONFIG_UPDATED_AT', value: "[parameters('configUpdatedAt')]" });
  if (owned) {
    t.parameters.gatewayAdminFile = { type: 'securestring', defaultValue: '' };
    app.properties.configuration.secrets.push({ name: 'gateway-admin-file', value: "[parameters('gatewayAdminFile')]" });
  }
  return t;
}

// What admin-ui saved on the live app ({ secrets, configUpdatedAt }), or null when the console has never saved.
export function consoleConfig(live) {
  const adminFile = live.secrets?.['gateway-admin-file'];
  if (!adminFile) return null;
  const yaml = live.secrets['gateway-config'];
  if (!yaml) throw new Error('the app holds gateway-admin-file but no gateway-config secret; save the configuration again in the admin console');
  return { yaml, adminFile, stamp: live.configUpdatedAt ?? '' };
}

// ADR-0012: the store a rendered configuration uses. "managed" connects to ${GATEWAY_PG_HOST}; the sidecar to 127.0.0.1.
export function databaseOf(yaml) {
  const url = yaml.split(/\r?\n/).map(stripComment).find((l) => /^\s*postgres_url:/.test(l)) ?? '';
  return url.includes('${GATEWAY_PG_HOST}') ? 'managed' : 'sidecar';
}

// The gateway run directly. image/gateway-entrypoint.sh waits for the sidecar on 127.0.0.1:5432 before it execs this
// (U-35); an app without the sidecar needs it as the container's command and args instead.
export const GATEWAY_COMMAND = Object.freeze({ command: ['/usr/local/bin/claude'], args: ['gateway', '--config', '/etc/claude/gateway.yaml'] });

// The template as deployed for one database choice. The template keeps the sidecar container literal, so that
// appSettingsOf and unmanagedAppSettings read one shape; "managed" drops it and its EmptyDir volume.
export function templateForDatabase(template, database) {
  if (!['sidecar', 'managed'].includes(database)) throw new Error(`database must be sidecar or managed, not ${JSON.stringify(database)}`);
  const out = structuredClone(template);
  if (database === 'sidecar') return out;
  const app = out.resources.find((r) => r.type === 'Microsoft.App/containerApps').properties.template;
  const dropped = new Set(app.containers.filter((c) => c.name === 'postgres').flatMap((c) => (c.volumeMounts ?? []).map((m) => m.volumeName)));
  app.containers = app.containers.filter((c) => c.name !== 'postgres');
  app.volumes = (app.volumes ?? []).filter((v) => !dropped.has(v.name));
  const gateway = app.containers.find((c) => c.name === 'gateway');
  gateway.command = [...GATEWAY_COMMAND.command];
  gateway.args = [...GATEWAY_COMMAND.args];
  return out;
}

// ADR-0018: the managed database on its own, created by the base stage before anything else: the template's
// PostgreSQL resources and pgServerName output, with the same parameters and variables, so the names match.
export function templateForDatabaseFirst(template) {
  const out = structuredClone(template);
  out.resources = out.resources.filter((r) => r.type.startsWith('Microsoft.DBforPostgreSQL/'));
  out.outputs = { pgServerName: out.outputs.pgServerName };
  return out;
}

// ADR-0018: --database-location as a comma-separated list of region names, tried in order; absent means the app's.
export function databaseRegions(option, location) {
  if (option === undefined) return [location];
  const regions = String(option).split(',').map((r) => r.trim());
  const bad = regions.find((r) => !/^[a-z0-9]+$/.test(r));
  if (bad !== undefined) throw new Error(`--database-location takes region names such as eastus or eastus,centralus, not ${JSON.stringify(option)}`);
  return [...new Set(regions)];
}

// The managed database's region (U-105): the one recorded when the server was created, else the first the option
// lists, else the app's. A recorded region the option does not list is refused: the template would create a second server.
export function databaseLocationFor({ option, state, location }) {
  const regions = databaseRegions(option, location);
  if (option !== undefined && state && !regions.includes(state)) throw new Error(`the managed database is already in ${state}; a --database-location without it would create a second server`);
  return state ?? regions[0];
}

// The Flexible Server administrator password: the app's pg-password with a capital letter added when it has none
// (U-102). Idempotent, so the next deployment, which reads the app's secret back, keeps the same value.
export function databasePassword(secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('the database password is empty');
  return /[A-Z]/.test(secret) ? secret : `${secret}A`;
}

const OUTBOUND_RULE = /^aca-outbound-/;
// Firewall rules that allow exactly the app's outbound addresses (U-101). Rules not named aca-outbound-* are left alone.
export function firewallPlan(rules, outboundIps) {
  if (!outboundIps?.length) throw new Error('the app reports no outbound address, so no firewall rule can be set');
  for (const ip of outboundIps) {
    parseIpv4(ip);
    if (ip === '0.0.0.0') throw new Error('0.0.0.0 would allow every Azure service; refusing it');
  }
  const want = new Map(outboundIps.map((ip) => [`aca-outbound-${ip.replace(/\./g, '-')}`, ip]));
  const have = new Map((rules ?? []).filter((r) => OUTBOUND_RULE.test(r.name)).map((r) => [r.name, r.properties?.startIpAddress]));
  return {
    add: [...want].filter(([name, ip]) => have.get(name) !== ip).map(([name, ip]) => ({ name, ip })),
    remove: [...have.keys()].filter((name) => !want.has(name)),
  };
}

// The ${VAR} references of a configuration that the template does not set on the gateway container.
export const unsetConfigVariables = (yaml, template) => configVariables(yaml).filter((v) => !appSettingsOf(template).env.includes(v));

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
// The domain oidc.allowed_email_domains admits: --email-domain, else the signed-in user's mail domain, else, for an
// account with no mail address (common in test tenants), its user principal name's domain, which Entra puts in the
// email claim for such accounts (the Contoso install of 2026-10-17 signed in that way).
export function emailDomainFor({ option, mail, upn }) {
  if (option) return { domain: option, from: 'option' };
  const domainOf = (address) => (/^[^@\s#]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(address ?? '') ?? [])[1];
  if (domainOf(mail)) return { domain: domainOf(mail), from: 'mail' };
  if (domainOf(upn)) return { domain: domainOf(upn), from: 'userPrincipalName' };
  throw new Error('the signed-in user has no mail address or user principal name with a domain; run the installer with -EmailDomain <your email domain>');
}