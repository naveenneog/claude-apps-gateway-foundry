import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cidrContains, configVariables, unsetConfigVariables, GATEWAY_COMMAND } from '../infra/azure-test/lib/plan.mjs';
import { renderGatewayConfig } from '../scripts/admin/new-gateway-config.mjs';

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

// P-34 (T-94): the installer deploys an operator's own admin file through this template, and the admin-ui and budgets
// stages need the gateway's admin API, whose write key the configuration reads as ${GATEWAY_ADMIN_WRITE_KEY}.
test('template: every test-topology rendering, the admin API ones included, has each ${VAR} it references set on the gateway', () => {
  const renderings = fs.readdirSync(path.join(root, 'config')).filter((f) => /^gateway\.azure-.+\.yaml$/.test(f) && f !== 'gateway.azure-private.yaml');
  assert.ok(renderings.length >= 3, `expected the test, demo and Contoso renderings, found ${renderings}`);
  for (const file of renderings) assert.deepEqual(unsetConfigVariables(read(`config/${file}`), template), [], file);
  const adminApi = renderGatewayConfig({ roles: ['Gateway.Standard'], models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }],
    deployment: { adminApi: true } });
  assert.ok(configVariables(adminApi).includes('GATEWAY_ADMIN_WRITE_KEY'), 'the admin block reads the write key from the environment');
  assert.deepEqual(unsetConfigVariables(adminApi, template), []);
  assert.equal(envOf(containers.gateway).GATEWAY_ADMIN_WRITE_KEY?.secretRef, 'admin-write-key');
});

test('config and template: both allow lists are bound to the one testerCidr parameter, which has no default', () => {
  assert.deepEqual(flowList(field(block(config, 'access_control'), 'allow_cidrs')), ['${TESTER_CIDR}']);
  assert.equal(envOf(containers.gateway).TESTER_CIDR.value, param('testerCidr'));
  // ADR-0017: one Allow rule on testerCidr unless anyAddress empties the list (T-157 checks the expression in full).
  const rules = app.properties.configuration.ingress.ipSecurityRestrictions;
  assert.match(rules, /createArray\(createObject\('name', 'tester-egress', 'description', '[^']+', 'action', 'Allow', 'ipAddressRange', parameters\('testerCidr'\)\)\)/);
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
  assert.match(entrypoint, /^\s*exec "\$CLAUDE_BIN" gateway --config "\$CONFIG"$/m, 'entrypoint execs the gateway');
  const exec = [null, /^CONFIG="\$\{GATEWAY_CONFIG:-(\S+)\}"$/m.exec(entrypoint)?.[1]];
  assert.equal(exec[1], `${containers.gateway.volumeMounts[0].mountPath}/gateway.yaml`);
  const cpu = Object.values(containers).reduce((n, c) => n + Number(/[\d.]+/.exec(c.resources.cpu)[0]), 0);
  const memory = Object.values(containers).reduce((n, c) => n + Number(/[\d.]+/.exec(c.resources.memory)[0]), 0);
  assert.equal(memory, cpu * 2, 'consumption plan pairs 2 GiB with each vCPU');
});

test('template: secrets come only from secure parameters; the registry and Foundry use the one identity', () => {
  const secrets = Object.fromEntries(app.properties.configuration.secrets.map((s) => [s.name, s.value]));
  assert.deepEqual(Object.keys(secrets).sort(), ['admin-pacer-key', 'admin-write-key', 'gateway-config', 'jwt-secret', 'oidc-client-secret', 'pg-password']);
  for (const name of ['admin-pacer-key', 'admin-write-key', 'jwt-secret', 'oidc-client-secret', 'pg-password']) {
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
  // 2.1.311 (ADR-0016, 2026-11-03): manifest.json platforms.linux-x64.checksum; verify-release.sh checks the signed manifest.
  assert.ok(sha.startsWith('86dc1fcc') && sha.endsWith('be8489ada'), 'matches the 2.1.311 manifest checksum');
  assert.match(dockerfile, /^ARG CLAUDE_VERSION=2\.1\.311$/m);
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
  const loop = /^\s*for _ in \{1\.\.(\d+)\}; do$/m.exec(entrypoint);
  assert.ok(loop && Number(loop[1]) <= 120, 'the store wait is bounded');
  const attributes = read('.gitattributes');
  assert.match(attributes, /^\*\.sh text eol=lf$/m);
  assert.match(attributes, /^Dockerfile text eol=lf$/m);
});

test('admin-ui deploy: Graph app-role grants target the resource service principal', () => {
  const deploy = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(deploy, /az rest --method post --url "https:\/\/graph\.microsoft\.com\/v1\.0\/servicePrincipals\/\$graphSpId\/appRoleAssignedTo"/);
  assert.match(deploy, /principalId = \$identityPrincipalId; resourceId = \$graphSpId; appRoleId = \$role\.Id/);
  assert.doesNotMatch(deploy, /servicePrincipals\/\$identityPrincipalId\/appRoleAssignedTo/);
});

// T-104 (ADR-0010): admin-ui's new Azure permission is Container Apps Contributor on the gateway app only, never the
// resource group; sign-in (authConfigs) exists only when enabled, and ADMIN_UI_SIGN_IN follows it; the new Graph
// permissions are named, and User.ReadWrite.All is granted only on request.
test('T-104 admin-ui main.bicep: Container Apps Contributor scoped to the gateway app, the new environment, and sign-in only when enabled', () => {
  const bicep = read('admin-ui/infra/main.bicep');
  const block = bicep.replace(/\r\n/g, '\n').split(/^(?=resource )/m)
    .find((b) => /^resource \w+ 'Microsoft\.Authorization\/roleAssignments@/.test(b) && b.includes("'358470bc-b998-42bd-ab17-a7e34c199c0f'"));
  assert.ok(block, 'a role assignment of Container Apps Contributor (358470bc-...)');
  assert.match(block, /^\s*scope: gatewayApp$/m, 'scoped to the gateway container app');
  assert.match(bicep, /resource gatewayApp 'Microsoft\.App\/containerApps@[^']+' existing = \{ name: gatewayAppName \}/);
  for (const name of ['GATEWAY_RESOURCE_ID', 'GATEWAY_TOPOLOGY', 'GATEWAY_ADMIN_FILE_PATH', 'ADMIN_UI_SIGN_IN']) {
    assert.match(bicep, new RegExp(`\\{ name: '${name}', value: `), `${name} is set`);
  }
  assert.match(bicep, /\{ name: 'GATEWAY_RESOURCE_ID', value: gatewayApp\.id \}/);
  assert.match(bicep, /\{ name: 'ADMIN_UI_SIGN_IN', value: enableSignIn \? 'required' : 'off' \}/);
  assert.match(bicep, /resource auth 'Microsoft\.App\/containerApps\/authConfigs@[^']+' = if \(enableSignIn\) \{/);
  assert.match(bicep, /unauthenticatedClientAction: 'RedirectToLoginPage'/);
  assert.match(bicep, /excludedPaths: \[ '\/api\/health' \]/, 'probes and health checks stay unauthenticated');
  assert.match(bicep, /@allowed\(\[ 'test', 'private' \]\)\s*\nparam gatewayTopology string/);
});

// T-169 (ADR-0019 amendment): a full PUT of the gateway app is also authorised against the environment it names
// (LinkedAuthorizationFailed, Microsoft.App/managedEnvironments/join/action), and a role scoped to the app alone does
// not reach the environment. Container Apps Operator is the smallest built-in role with join; it has no write.
test('T-169 admin-ui main.bicep: Container Apps Operator on the gateway environment, for the linked join check', () => {
  const bicep = read('admin-ui/infra/main.bicep');
  const block = bicep.replace(/\r\n/g, '\n').split(/^(?=resource )/m)
    .find((b) => /^resource \w+ 'Microsoft\.Authorization\/roleAssignments@/.test(b) && b.includes("'f3bd1b5c-91fa-40e7-afe7-0c11d331232c'"));
  assert.ok(block, 'a role assignment of Container Apps Operator (f3bd1b5c-...)');
  assert.match(block, /^\s*scope: environment$/m, 'scoped to the gateway environment only');
  assert.doesNotMatch(bicep, /scope: resourceGroup\(\)/, 'never the resource group');
  // A grant made by hand or in the Portal has a random name; declaring it again under Bicep's name fails with
  // RoleAssignmentExists, so the deploy skips the assignment when the identity already holds the role there.
  assert.match(block, /^resource gatewayEnvironmentJoin 'Microsoft\.Authorization\/roleAssignments@[^']+' = if \(grantEnvironmentJoin\) \{/);
  assert.match(bicep, /param grantEnvironmentJoin bool = true/);
  const deploy = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(deploy, /grantEnvironmentJoin\s+= @\{ value = \$grantEnvironmentJoin \}/);
  assert.match(deploy, /az role assignment list --assignee \$existingPrincipal --scope \$environmentId --role f3bd1b5c-91fa-40e7-afe7-0c11d331232c/);
  assert.match(deploy, /if \(\$existingPrincipal -and \$environmentId\)/, 'an empty --assignee or --scope would widen the list (Azure CLI)');
});

test('T-104 T-146 Deploy-AdminUi.ps1 grants four Graph permissions, never User.ReadWrite.All, and makes admin-ui an owner of the gateway app', () => {
  const deploy = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(deploy, /@\{ Value = 'Application\.ReadWrite\.OwnedBy'; Id = '18a4783c-866b-4cc7-a460-3d5e5662c884' \}/);
  const needed = /\$NEEDED_GRAPH_ROLES = @\(([\s\S]*?)\n\)/.exec(deploy)?.[1] ?? '';
  assert.deepEqual([...needed.matchAll(/Value = '([^']+)'/g)].map((m) => m[1]).sort(),
    ['AppRoleAssignment.ReadWrite.All', 'Application.Read.All', 'Application.ReadWrite.OwnedBy', 'User.Read.All']);
  assert.doesNotMatch(deploy, /GrantUserWrite/, 'the switch is gone (ADR-0015)');
  assert.doesNotMatch(deploy, /NEEDED_GRAPH_ROLES \+=/, 'nothing adds a permission to the list');
  assert.match(deploy, /applications\/\$gatewayAppObjectId\/owners\/`?\$ref/);
  assert.match(deploy, /\[switch\]\$EnableSignIn/);
  assert.match(deploy, /gatewayAppName\s+= @\{ value = \$GatewayAppName \}/);
  assert.match(deploy, /enableSignIn\s+= @\{ value = \[bool\]\$EnableSignIn \}/);
});

test('T-146 Deploy-AdminUi.ps1 prints the command that removes a User.ReadWrite.All grant an earlier install left, and does not remove it itself', () => {
  const deploy = read('admin-ui/infra/Deploy-AdminUi.ps1');
  const step = /Step 'Grant Microsoft Graph application permissions[\s\S]*?\n\}\n/.exec(deploy.replace(/\r\n/g, '\n'))?.[0] ?? '';
  assert.match(step, /\$LEGACY_USER_WRITE = '741f803b-c850-494e-b5df-cde7c675a1ca'/);
  assert.match(step, /Write-Warning/);
  assert.match(step, /az rest --method delete --url `"https:\/\/graph\.microsoft\.com\/v1\.0\/servicePrincipals\/\$identityPrincipalId\/appRoleAssignments\/\$\(\$legacy\.id\)`"/);
  assert.doesNotMatch(step.replace(/Write-Warning[^\n]*\n/g, ''), /--method delete/, 'the delete is printed for an administrator, not run');
  assert.match(step, /query 'value\[\]\.\{id:id,appRoleId:appRoleId,resourceId:resourceId\}'/);
  // Code review, P-44: the warning must run, not only read right. Executed with stub values in PowerShell 7; an
  // unescaped quote split it into two arguments and stopped the deploy under $ErrorActionPreference = 'Stop'.
  const block = /\$LEGACY_USER_WRITE = [\s\S]*?\n    \}\n/.exec(step)?.[0];
  assert.ok(block, 'the legacy-permission block');
  const script = `$ErrorActionPreference = 'Stop'\n$identityPrincipalId = 'P1'\n$graphSpId = 'G1'\n` +
    `$assignments = @([pscustomobject]@{ id = 'L1'; appRoleId = '741f803b-c850-494e-b5df-cde7c675a1ca'; resourceId = 'G1' })\n${block}`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p44-')), 'legacy.ps1');
  fs.writeFileSync(file, script);
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the warning block failed: ${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /az rest --method delete --url "?https:\/\/graph\.microsoft\.com\/v1\.0\/servicePrincipals\/P1\/appRoleAssignments\/L1"?/);
});
// T-108 (ADR-0011): an existing default-access assignment must not count as AdminUi.Admin, and a deployment without
// sign-in says that the console is then limited by IP address only.
test('T-108 Deploy-AdminUi.ps1 counts only an AdminUi.Admin assignment as "already admin", and warns when sign-in is off', () => {
  const deploy = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(deploy, /Where-Object \{ \$_\.principalId -eq \$userId -and \$_\.appRoleId -eq \$roleId \}/);
  assert.match(deploy, /if \(-not \$EnableSignIn\) \{[^}]*Write-Warning [^}]*not limited to administrators/);
});

// T-114 (ADR-0012): the managed database option in the test topology's template.
test('T-114 template: a database parameter chooses sidecar (default) or managed, and the Flexible Server exists only for managed', () => {
  const { type, defaultValue, allowedValues } = template.parameters.database;
  assert.deepEqual({ type, defaultValue, allowedValues }, { type: 'string', defaultValue: 'sidecar', allowedValues: ['sidecar', 'managed'] });
  const server = template.resources.find((r) => r.type === 'Microsoft.DBforPostgreSQL/flexibleServers');
  assert.equal(server.condition, "[equals(parameters('database'), 'managed')]");
  assert.deepEqual(server.sku, { name: 'Standard_B1ms', tier: 'Burstable' });
  assert.equal(server.properties.version, '16');
  // U-105: B1ms can be refused in the app's region, so the server's region is its own parameter, and its name carries
  // the region because ARM keeps a refused server's name in the first region for a while.
  assert.equal(server.location, "[parameters('databaseLocation')]");
  assert.equal(template.parameters.databaseLocation.defaultValue, "[parameters('location')]");
  assert.equal(template.variables.pgServerName, "[concat('psql-claude-gw-', substring(variables('suffix'), 0, 8), '-', parameters('databaseLocation'))]");
  assert.equal(server.properties.administratorLogin, 'gateway');
  assert.equal(server.properties.administratorLoginPassword, "[parameters('postgresPassword')]");
  assert.equal(server.properties.backup.backupRetentionDays, 35);
  assert.equal(server.properties.network.publicNetworkAccess, 'Enabled');
  const db = template.resources.find((r) => r.type === 'Microsoft.DBforPostgreSQL/flexibleServers/databases');
  assert.equal(db.condition, server.condition);
  assert.match(db.name, /'gateway'\)\]$|\/gateway'\)\]$/);
  assert.ok(app.dependsOn.some((d) => d.includes('Microsoft.DBforPostgreSQL/flexibleServers/databases')), 'the app waits for the database');
  assert.ok(!template.resources.some((r) => r.type === 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules'), 'rules follow the app outbound addresses, set by deploy.mjs');
});

test('T-114 template: the gateway gets GATEWAY_PG_HOST, 127.0.0.1 for the sidecar and the server name for managed, so both renderings boot', () => {
  const host = containers.gateway.env.find((e) => e.name === 'GATEWAY_PG_HOST');
  assert.equal(host.value, "[if(equals(parameters('database'), 'managed'), format('{0}.postgres.database.azure.com', variables('pgServerName')), '127.0.0.1')]");
  const admin = JSON.parse(read('config/gateway-admin.azure-test.json'));
  admin.deployment = { ...admin.deployment, database: 'managed' };
  assert.deepEqual(unsetConfigVariables(renderGatewayConfig(admin), template), []);
});

test('T-114 the managed gateway command is the one the entrypoint execs, with the config the template mounts', () => {
  const bin = /^CLAUDE_BIN="\$\{CLAUDE_BIN:-(\S+)\}"$/m.exec(entrypoint)[1];
  const config = /^CONFIG="\$\{GATEWAY_CONFIG:-(\S+)\}"$/m.exec(entrypoint)[1];
  assert.match(entrypoint, /^exec "\$CLAUDE_BIN" gateway --config "\$CONFIG"$/m);
  assert.deepEqual(GATEWAY_COMMAND, { command: [bin], args: ['gateway', '--config', config] });
});

// T-137 (ADR-0014): the pacer key exists wherever the admin API does, keeps its value on a later run, and the job that
// uses it is admin-ui's own image and identity on a five-minute schedule, reading the key from the gateway app.
test('T-137 template: GATEWAY_ADMIN_PACER_KEY is set from admin-pacer-key, and a paced rendering has every variable it reads', () => {
  assert.equal(envOf(containers.gateway).GATEWAY_ADMIN_PACER_KEY?.secretRef, 'admin-pacer-key');
  const paced = renderGatewayConfig({ roles: ['Gateway.Standard'], models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }],
    deployment: { adminApi: true }, spendPacing: { softLimitPercent: 80 } });
  assert.ok(configVariables(paced).includes('GATEWAY_ADMIN_PACER_KEY'));
  assert.deepEqual(unsetConfigVariables(paced, template), []);
  const deploy = read('infra/azure-test/deploy.mjs') + read('infra/azure-test/lib/credentials.mjs');
  assert.match(deploy, /registerSecret\(live\.secrets\['admin-pacer-key'\] \|\| newSecret\(32\)\)/, 'a later run keeps the live value');
  assert.match(deploy, /gatewayAdminPacerKey: secrets\.pacer/);
});

test('T-137 admin-ui main.bicep: job-spend-pacer runs every five minutes from admin-ui\'s image and identity, with no key of its own', () => {
  const bicep = read('admin-ui/infra/main.bicep').replace(/\r\n/g, '\n');
  const job = bicep.split(/^(?=resource )/m).find((b) => /^resource \w+ 'Microsoft\.App\/jobs@/.test(b));
  assert.ok(job, 'a Container Apps job');
  assert.match(job, /name: 'job-spend-pacer'/);
  assert.match(job, /triggerType: 'Schedule'/);
  assert.match(job, /cronExpression: '\*\/5 \* \* \* \*'/);
  assert.match(job, /environmentId: environment\.id/);
  assert.match(job, /userAssignedIdentities: \{ '\$\{identity\.id\}': \{\} \}/);
  assert.match(job, /image: '\$\{acrLoginServer\}\/\$\{imageTag\}'/);
  assert.match(job, /command: \[ 'node', 'server\/pacer-job\.mjs' \]/);
  for (const name of ['AZURE_CLIENT_ID', 'GATEWAY_URL', 'GATEWAY_RESOURCE_ID']) assert.match(job, new RegExp(`\\{ name: '${name}', value: `), name);
  assert.match(job, /\{ name: 'GATEWAY_ADMIN_FILE_JSON', secretRef: 'gateway-admin-file-json' \}/);
  assert.doesNotMatch(job, /gatewayAdminWriteKey|PACER_KEY|admin-pacer-key|write-key/i, 'the job reads the keys from the gateway app, so none is passed to it');
  assert.match(job, /dependsOn: \[[^\]]*gatewayConfigWriter/, 'the role that lets it read the gateway app\'s secrets exists first');
});

// T-157: the console template drops its IP rule only when asked, and Deploy-AdminUi.ps1 refuses that without sign-in.
test('T-157 main.bicep has an allowAnyAddress switch; Deploy-AdminUi.ps1 passes it and refuses it without -EnableSignIn', () => {
  const bicep = read('admin-ui/infra/main.bicep');
  assert.match(bicep, /param allowAnyAddress bool = false/);
  assert.match(bicep, /ipSecurityRestrictions: allowAnyAddress \? \[\] : \[/);
  const deploy = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(deploy, /\[switch\]\$AllowAnyAddress/);
  assert.match(deploy, /allowAnyAddress\s+= @\{ value = \[bool\]\$AllowAnyAddress \}/);
  assert.match(deploy, /if \(\$AllowAnyAddress -and -not \$EnableSignIn\) \{ throw/);
});

// T-157: the gateway template drops its IP rule only when anyAddress is true.
test('T-157 gateway-test.json has an anyAddress parameter that empties ipSecurityRestrictions', () => {
  const t = JSON.parse(read('infra/azure-test/gateway-test.json'));
  assert.deepEqual(t.parameters.anyAddress, { type: 'bool', defaultValue: false, metadata: t.parameters.anyAddress.metadata });
  const app = t.resources.find((r) => r.type === 'Microsoft.App/containerApps');
  const rules = app.properties.configuration.ingress.ipSecurityRestrictions;
  assert.equal(typeof rules, 'string');
  assert.match(rules, /^\[if\(parameters\('anyAddress'\), createArray\(\), createArray\(createObject\('name', 'tester-egress'.*'ipAddressRange', parameters\('testerCidr'\)\)\)\)\]$/);
});

test('T-156 admin-ui main.bicep tags its identity, app and job with ownTags, which Deploy-AdminUi.ps1 reads from the gateway app', () => {
  const bicep = read('admin-ui/infra/main.bicep').replace(/\r\n/g, '\n');
  assert.match(bicep, /^param ownTags object = \{\}$/m);
  for (const name of ["'id-admin-ui'", 'appName', "'job-spend-pacer'"]) {
    assert.match(bicep, new RegExp(`  name: ${name}\\n  location: location\\n  tags: ownTags\\n`), name);
  }
  const ps = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(ps, /az containerapp show -g \$ResourceGroup -n \$GatewayAppName --query tags -o json/);
  assert.match(ps, /ownTags\s+= @\{ value = \$gatewayTags \}/);
});
test('T-153 admin-ui main.bicep: job-signin-renewer runs daily from admin-ui\'s image and identity, only with the gateway\'s app registration', () => {
  const bicep = read('admin-ui/infra/main.bicep').replace(/\r\n/g, '\n');
  const job = bicep.split(/^(?=resource )/m).find((b) => /^resource renewerJob /.test(b));
  assert.match(job, /= if \(!empty\(gatewayApplicationObjectId\)\) \{/);
  assert.match(job, /name: 'job-signin-renewer'/);
  assert.match(job, /cronExpression: '17 3 \* \* \*'/);
  assert.match(job, /userAssignedIdentities: \{ '\$\{identity\.id\}': \{\} \}/);
  assert.match(job, /command: \[ 'node', 'server\/signin-renewer\.mjs' \]/);
  for (const env of ['AZURE_CLIENT_ID', 'GATEWAY_RESOURCE_ID', 'GATEWAY_APPLICATION_OBJECT_ID', 'SIGNIN_CERTIFICATE_MONTHS', 'SIGNIN_SECRET_DAYS']) assert.match(job, new RegExp(`name: '${env}'`), env);
  assert.doesNotMatch(job, /secrets:/, 'no secret of its own: it reads the gateway app');
  const ps = read('admin-ui/infra/Deploy-AdminUi.ps1');
  assert.match(ps, /gatewayApplicationObjectId = @\{ value = \$gatewayAppObjectId \}/);
});
test('image hardening (2026-11-03): admin-ui runs on Microsoft\'s distroless Node.js image, pinned by digest, as a non-root user', () => {
  const df = read('admin-ui/Dockerfile').replace(/\r\n/g, '\n');
  const froms = df.match(/^FROM .+$/gm);
  assert.deepEqual(froms.length, 1);
  assert.match(froms[0], /^FROM mcr\.microsoft\.com\/azurelinux\/distroless\/nodejs:[\w.-]+-nonroot-[\w.-]+@sha256:[0-9a-f]{64}$/);
  assert.match(df, /^USER nonroot$/m);
  assert.doesNotMatch(df, /^RUN /m, 'distroless has no shell to RUN with');
  assert.match(df, /^CMD \["node", "server\/server\.mjs"\]$/m);
});