import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cidrContains, configVariables } from '../infra/azure-test/lib/plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const read = (rel) => raw(rel).replace(/\r\n/g, '\n');
const readJson = (rel) => JSON.parse(read(rel));

const template = readJson('infra/azure-test/gateway-test.json');
const manifest = readJson('infra/azure-test/entra-app.json');
const config = read('config/gateway.azure-test.yaml');
const dockerfile = read('infra/azure-test/image/Dockerfile');
const entrypoint = read('infra/azure-test/image/gateway-entrypoint.sh');

const resources = (type) => template.resources.filter((r) => r.type === type);
function one(type, list = template.resources) {
  const found = list.filter((r) => r.type === type);
  assert.equal(found.length, 1, `exactly one ${type}`);
  return found[0];
}
const app = one('Microsoft.App/containerApps');
const containers = Object.fromEntries(app.properties.template.containers.map((c) => [c.name, c]));
const envOf = (container) => Object.fromEntries(container.env.map((e) => [e.name, e]));
const param = (name) => `[parameters('${name}')]`;

// Top-level YAML block (the key line and the indented lines under it), comments removed.
function block(yaml, key) {
  const lines = yaml.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, '')).filter((l) => !/^\s*#/.test(l));
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  assert.ok(start >= 0, `config has a top-level ${key}:`);
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}
function field(text, key) {
  const m = new RegExp(`^\\s*(?:- )?${key}:\\s*(.+?)\\s*$`, 'm').exec(text);
  assert.ok(m, `config sets ${key}`);
  return m[1];
}
const flowList = (value) => value.replace(/^\[|\]$/g, '').split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter(Boolean);
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];

test('config: every ${VAR} it references is set on the gateway container, secrets through secretRef', () => {
  const env = envOf(containers.gateway);
  const vars = configVariables(config);
  assert.ok(vars.length >= 8, `expected at least 8 variables, found ${vars}`);
  for (const name of vars) assert.ok(env[name], `${name} is set on the gateway container`);
  for (const [name, entry] of Object.entries(env)) {
    if (/SECRET|PASSWORD|TOKEN|KEY$/.test(name)) {
      assert.ok(entry.secretRef && entry.value === undefined, `${name} comes from a secretRef, not a literal value`);
    }
  }
  for (const key of ['client_secret', 'jwt_secret', 'password']) {
    assert.match(field(config, key), /^"\$\{[A-Z_]+\}"$/, `${key} is a quoted \${VAR} reference`);
  }
  assert.doesNotMatch(config.replace(/\$\{[^}]+\}/g, ''), /[A-Za-z0-9+/_-]{32,}/, 'no long literal that could be a secret');
});

test('config and template: both allow lists are bound to the one testerCidr parameter, which has no default', () => {
  assert.deepEqual(flowList(field(block(config, 'access_control'), 'allow_cidrs')), ['${TESTER_CIDR}']);
  assert.equal(envOf(containers.gateway).TESTER_CIDR.value, param('testerCidr'));
  const rules = app.properties.configuration.ingress.ipSecurityRestrictions;
  assert.equal(rules.length, 1, 'one ingress rule');
  assert.equal(rules[0].action, 'Allow');
  assert.equal(rules[0].ipAddressRange, param('testerCidr'));
  assert.equal(template.parameters.testerCidr.defaultValue, undefined, 'testerCidr must be supplied');
});

test('config: trusted proxies are private ranges only, so a public client cannot vouch for an address', () => {
  const proxies = flowList(field(block(config, 'listen'), 'trusted_proxies'));
  assert.ok(proxies.length >= 1);
  for (const cidr of proxies) {
    const [network] = cidr.split('/');
    assert.ok(PRIVATE.some((range) => cidrContains(range, network)), `${cidr} lies in a private range`);
  }
});

test('config and template: listener, ingress and probes use one port; the store is the sidecar', () => {
  const listen = block(config, 'listen');
  const port = Number(field(listen, 'port'));
  assert.equal(field(listen, 'host'), '0.0.0.0');
  assert.equal(field(listen, 'public_url'), '"${GATEWAY_PUBLIC_URL}"');
  const ingress = app.properties.configuration.ingress;
  assert.equal(ingress.targetPort, port);
  assert.equal(ingress.external, true);
  assert.equal(ingress.allowInsecure, false);
  const probes = Object.fromEntries(containers.gateway.probes.map((p) => [p.type, p.httpGet]));
  assert.deepEqual(Object.keys(probes).sort(), ['Liveness', 'Readiness', 'Startup']);
  assert.equal(probes.Liveness.path, '/healthz');
  assert.equal(probes.Startup.path, '/healthz');
  assert.equal(probes.Readiness.path, '/readyz');
  for (const probe of Object.values(probes)) assert.equal(probe.port, port);

  const url = new URL(field(block(config, 'store'), 'postgres_url'));
  const pg = envOf(containers.postgres);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5432');
  assert.equal(url.password, '', 'the password is not in the URL');
  assert.equal(url.username, pg.POSTGRES_USER.value);
  assert.equal(url.pathname.slice(1), pg.POSTGRES_DB.value);
  assert.equal(pg.POSTGRES_PASSWORD.secretRef, 'pg-password');
  assert.equal(envOf(containers.gateway).GATEWAY_PG_PASSWORD.secretRef, 'pg-password');
  assert.ok(containers.postgres.args.includes('listen_addresses=127.0.0.1'), 'PostgreSQL listens on loopback only');
  assert.match(entrypoint, /^\s*if \(exec 3<>\/dev\/tcp\/127\.0\.0\.1\/5432\) 2>\/dev\/null; then$/m);
});

test('config and manifest: admission by app role uses exactly the roles the app registration defines', () => {
  const oidc = block(config, 'oidc');
  assert.equal(field(oidc, 'groups_claim'), 'roles');
  const roles = manifest.appRoles.map((r) => r.value).sort();
  assert.deepEqual(flowList(field(oidc, 'allowed_groups')).sort(), roles);
  assert.deepEqual(roles, ['Gateway.Premium', 'Gateway.Standard']);
  assert.deepEqual(flowList(field(oidc, 'allowed_email_domains')), ['${ALLOWED_EMAIL_DOMAIN}']);
});

test('config and template: one Foundry upstream through managed identity, on the account the role is granted on', () => {
  const upstreams = block(config, 'upstreams');
  assert.equal((upstreams.match(/provider:/g) ?? []).length, 1, 'one upstream');
  assert.equal(field(upstreams, 'provider'), 'foundry');
  assert.equal(field(upstreams, 'resource'), '"${FOUNDRY_RESOURCE}"');
  assert.equal(field(upstreams, 'auth'), '{ use_azure_ad: true }');
  assert.doesNotMatch(upstreams, /api_key/);
  const env = envOf(containers.gateway);
  assert.equal(env.FOUNDRY_RESOURCE.value, param('foundryAccountName'));
  assert.match(env.AZURE_CLIENT_ID.value, /reference\(.*userAssignedIdentities.*\)\.clientId\]$/);

  const nested = one('Microsoft.Resources/deployments');
  assert.equal(nested.resourceGroup, param('foundryResourceGroup'));
  assert.equal(nested.properties.parameters.accountName.value, param('foundryAccountName'));
  assert.match(nested.properties.parameters.principalId.value, /userAssignedIdentities.*\)\.principalId\]$/);
  const grant = one('Microsoft.Authorization/roleAssignments', nested.properties.template.resources);
  assert.match(grant.properties.roleDefinitionId, /a97b65f3-24c7-4388-baec-2e87135dc908/, 'Cognitive Services User');
  assert.equal(grant.properties.principalType, 'ServicePrincipal');
  assert.equal(grant.properties.principalId, param('principalId'));
  assert.match(grant.scope, /Microsoft\.CognitiveServices\/accounts\/\{0\}', parameters\('accountName'\)/);
});

test('config: the models are exactly the two deployments on that account, with nothing built in', () => {
  assert.equal(field(config, 'auto_include_builtin_models'), 'false');
  const models = block(config, 'models');
  const ids = [...models.matchAll(/^\s*- id: (\S+)$/gm)].map((m) => m[1]);
  const deployments = [...models.matchAll(/^\s*upstream_model: \{ foundry: (\S+) \}$/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(deployments, ids, 'each model maps to the deployment of the same name');
});

test('config: keys that need a newer gateway appear only when the image pins that version or later', () => {
  const version = /^ARG CLAUDE_VERSION=(\d+)\.(\d+)\.(\d+)$/m.exec(dockerfile);
  assert.ok(version, 'Dockerfile pins CLAUDE_VERSION');
  const [major, minor, patch] = version.slice(1).map(Number);
  const atLeast = (a, b, c) => major > a || (major === a && (minor > b || (minor === b && patch >= c)));
  if (/connect_timeout_seconds/.test(config)) assert.ok(atLeast(2, 1, 274), 'store.connect_timeout_seconds needs 2.1.274');
});

test('template: one replica, one revision, sidecar data on replica storage, config mounted only into the gateway', () => {
  const t = app.properties.template;
  assert.equal(app.condition, param('deployApp'));
  assert.equal(app.properties.configuration.activeRevisionsMode, 'Single');
  assert.deepEqual([t.scale.minReplicas, t.scale.maxReplicas], [1, 1]);
  const volumes = Object.fromEntries(t.volumes.map((v) => [v.name, v]));
  assert.equal(volumes['gateway-config'].storageType, 'Secret');
  assert.deepEqual(volumes['gateway-config'].secrets, [{ secretRef: 'gateway-config', path: 'gateway.yaml' }]);
  assert.equal(volumes.pgdata.storageType, 'EmptyDir');
  assert.deepEqual(containers.gateway.volumeMounts, [{ volumeName: 'gateway-config', mountPath: '/etc/claude' }]);
  assert.deepEqual(containers.postgres.volumeMounts.map((m) => m.volumeName), ['pgdata']);
  const pgMount = containers.postgres.volumeMounts[0].mountPath;
  assert.ok(envOf(containers.postgres).PGDATA.value.startsWith(`${pgMount}/`), 'PGDATA lives on the EmptyDir volume');
  const exec = /^\s*exec \/usr\/local\/bin\/claude gateway --config (\S+)$/m.exec(entrypoint);
  assert.ok(exec, 'entrypoint execs the gateway');
  assert.equal(exec[1], `${containers.gateway.volumeMounts[0].mountPath}/gateway.yaml`);
  const cpu = Object.values(containers).reduce((n, c) => n + Number(/[\d.]+/.exec(c.resources.cpu)[0]), 0);
  const memory = Object.values(containers).reduce((n, c) => n + Number(/[\d.]+/.exec(c.resources.memory)[0]), 0);
  assert.equal(memory, cpu * 2, 'consumption plan pairs 2 GiB with each vCPU');
});

test('template: secrets come only from secure parameters; the registry and Foundry use the one identity', () => {
  const secrets = Object.fromEntries(app.properties.configuration.secrets.map((s) => [s.name, s.value]));
  assert.deepEqual(Object.keys(secrets).sort(), ['gateway-config', 'jwt-secret', 'oidc-client-secret', 'pg-password']);
  for (const name of ['jwt-secret', 'oidc-client-secret', 'pg-password']) {
    const p = /^\[parameters\('(\w+)'\)\]$/.exec(secrets[name])?.[1];
    assert.ok(p, `${name} is a parameter reference`);
    assert.equal(template.parameters[p].type.toLowerCase(), 'securestring', `${p} is a securestring`);
  }
  const identityId = Object.keys(app.identity.userAssignedIdentities);
  assert.equal(app.identity.type, 'UserAssigned');
  assert.equal(identityId.length, 1);
  const [registry] = app.properties.configuration.registries;
  assert.equal(registry.identity, identityId[0]);
  assert.equal(registry.passwordSecretRef, undefined);
  const acr = one('Microsoft.ContainerRegistry/registries');
  assert.equal(acr.properties.adminUserEnabled, false);
  assert.equal(acr.properties.policies.azureADAuthenticationAsArmPolicy.status, 'enabled');
  const [pull] = resources('Microsoft.Authorization/roleAssignments');
  assert.match(pull.properties.roleDefinitionId, /7f951dda-4ed3-4680-a7ca-43fe172d538d/, 'AcrPull');
  assert.equal(pull.properties.principalType, 'ServicePrincipal');
  assert.match(pull.properties.principalId, /userAssignedIdentities.*\)\.principalId\]$/);
  assert.match(pull.scope, /Microsoft\.ContainerRegistry\/registries/);
});

test('template: a new client secret starts a new revision, because a secret change alone restarts nothing', () => {
  assert.equal(envOf(containers.gateway).OIDC_CREDENTIAL_ID?.value, param('oidcCredentialId'));
  assert.equal(template.parameters.oidcCredentialId?.type, 'string', 'the key id is not secret');
});

test('template: logs go to a workspace that keeps them 30 days and purges on day 30', () => {
  const teardown = read('infra/azure-test/teardown.mjs');
  assert.equal(/^const IDENTITY = '([^']+)';$/m.exec(teardown)?.[1], template.variables.identityName,
    'teardown looks up the identity the template creates');
  const ws = one('Microsoft.OperationalInsights/workspaces');
  assert.equal(ws.properties.retentionInDays, 30);
  assert.equal(ws.properties.features.immediatePurgeDataOn30Days, true);
  assert.equal(one('Microsoft.App/managedEnvironments').properties.appLogsConfiguration.destination, 'log-analytics');
  for (const name of ['gatewayFqdn', 'acrName', 'identityPrincipalId', 'foundryRoleAssignmentId']) {
    assert.ok(template.outputs[name], `template outputs ${name}`);
  }
});

test('entra-app.json: single tenant, email claim, two user roles, sign-in scopes only, no credentials', () => {
  assert.equal(manifest.signInAudience, 'AzureADMyOrg');
  assert.equal(manifest.web.redirectUris, undefined, 'the deploy tool sets the redirect URI');
  assert.deepEqual(manifest.web.implicitGrantSettings, { enableIdTokenIssuance: false, enableAccessTokenIssuance: false });
  assert.equal(manifest.passwordCredentials, undefined);
  assert.equal(manifest.keyCredentials, undefined);
  assert.ok(!manifest.groupMembershipClaims || manifest.groupMembershipClaims === 'None', 'no groups claim');
  assert.ok(manifest.optionalClaims.idToken.some((c) => c.name === 'email'));
  const ids = manifest.appRoles.map((r) => r.id);
  assert.equal(new Set(ids).size, 2);
  for (const role of manifest.appRoles) {
    assert.match(role.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(role.allowedMemberTypes, ['User']);
    assert.equal(role.isEnabled, true);
  }
  assert.deepEqual(manifest.requiredResourceAccess, [{
    resourceAppId: '00000003-0000-0000-c000-000000000000',
    resourceAccess: [
      { id: '37f7f235-527c-4136-accd-4a02d197296e', type: 'Scope' },
      { id: '14dad69e-099b-42c9-810b-d002981feec1', type: 'Scope' },
      { id: '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0', type: 'Scope' },
      { id: '7427e0e9-2fba-42fe-b0c0-848c9e6a8182', type: 'Scope' },
    ],
  }], 'openid, profile, email and offline_access, nothing else');
});

test('Dockerfile: pinned base, pinned release checked by verify-release.sh, non-root runtime', () => {
  const base = /^ARG BASE_IMAGE=(\S+)$/m.exec(dockerfile)?.[1];
  assert.match(base ?? '', /@sha256:[0-9a-f]{64}$/, 'base image pinned by digest');
  for (const from of dockerfile.match(/^FROM .+$/gm)) assert.match(from, /^FROM \$\{BASE_IMAGE\}( AS \w+)?$/);
  const sha = /^ARG CLAUDE_SHA256=([0-9a-f]{64})$/m.exec(dockerfile)?.[1];
  assert.ok(sha, 'CLAUDE_SHA256 pinned');
  assert.ok(sha.startsWith('1e08503d') && sha.endsWith('b322925b'), 'matches the checksum recorded in U-5');
  assert.match(dockerfile, /^ARG CLAUDE_VERSION=2\.1\.280$/m);
  assert.match(dockerfile, /^ARG CLAUDE_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE$/m);
  assert.match(dockerfile, /^\s+bash \/usr\/local\/bin\/verify-release\.sh \/release "\$\{CLAUDE_VERSION\}" linux-x64 "\$\{CLAUDE_SHA256\}" "\$\{CLAUDE_KEY_FINGERPRINT\}"; \\$/m);
  for (const url of dockerfile.match(/[a-z]+:\/\/\S+/g)) assert.match(url, /^https:\/\//, `${url} uses HTTPS`);
  assert.match(dockerfile, /^COPY --from=fetch \/release\/claude \/usr\/local\/bin\/claude$/m);
  assert.match(dockerfile, /^USER 10001:10001$/m);
  assert.match(dockerfile, /^ENV CLAUDE_CONFIG_DIR=\/tmp\/\.claude HOME=\/tmp$/m);
  assert.match(dockerfile, /^CMD \["\/bin\/bash", "\/usr\/local\/bin\/gateway-entrypoint\.sh"\]$/m);
});

test('shell scripts: LF endings, strict mode, a bounded wait, and git keeps them LF', () => {
  for (const rel of ['infra/azure-test/image/gateway-entrypoint.sh', 'infra/azure-test/image/verify-release.sh', 'infra/azure-test/image/Dockerfile']) {
    const text = raw(rel);
    assert.ok(!text.includes('\r'), `${rel} has no CR characters`);
    if (rel.endsWith('.sh')) assert.match(text, /^set -euo pipefail$/m, `${rel} runs in strict mode`);
  }
  const loop = /^for _ in \{1\.\.(\d+)\}; do$/m.exec(entrypoint);
  assert.ok(loop && Number(loop[1]) <= 120, 'the store wait is bounded');
  const attributes = read('.gitattributes');
  assert.match(attributes, /^\*\.sh text eol=lf$/m);
  assert.match(attributes, /^Dockerfile text eol=lf$/m);
});
