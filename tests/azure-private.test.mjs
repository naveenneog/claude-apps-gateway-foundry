// T-74: infra/azure-private/Deploy-Gateway.ps1 against a fake Azure CLI (P-10, ADR-0005). -Plan reads the subscription and
// prints the commands that would change it; the private-network properties are in those commands; no secret is on a
// command line; a re-run over existing resources changes nothing; the gateway's Container App definition.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'infra', 'azure-private', 'Deploy-Gateway.ps1');
const fake = path.join(repo, 'tests', 'azure-private', 'fake-az.mjs');
const skip = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0 && 'PowerShell 7 (pwsh) is not on PATH';
const ACCOUNT = { id: '00000000-0000-4000-8000-00000000aaaa', tenantId: '11111111-1111-4111-8111-111111111111' };
const ME = { id: 'user-1', userPrincipalName: 'dev@contoso.example', mail: 'dev@contoso.example' };
const RG = 'rg-claude-gw-internal';
const suffix = crypto.createHash('sha256').update(`${ACCOUNT.id}/${RG}`).digest('hex').slice(0, 6);
const PREMIUM = JSON.parse(fs.readFileSync(path.join(repo, 'infra', 'azure-test', 'entra-app.json'), 'utf8')).appRoles.find((r) => r.value === 'Gateway.Premium').id;
const DOMAIN = 'blue-1.eastus2.azurecontainerapps.io';
const CHANGE = /^(create|update|add|add-record|invoke|build|reset|delete|remove|import)$/;

function run(t, world, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-azp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worldFile = path.join(dir, 'world.json');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(worldFile, JSON.stringify({ 'account show': ACCOUNT, 'ad signed-in-user show': ME, ...world }));
  fs.writeFileSync(log, '');
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8', timeout: 180_000, env: { ...process.env, CGW_AZ_COMMAND: fake, CGW_FAKE_AZ_WORLD: worldFile, CGW_FAKE_AZ_LOG: log } });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const planned = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('  PLAN  az ')).map((l) => l.slice('  PLAN  az '.length));
  // pwsh on Linux colours an error and wraps it at the console width, so messages are matched in `flat`: the output
  // without colour codes and with every run of whitespace as one space.
  const out = `${r.stdout}${r.stderr}`.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
  return { status: r.status, out, flat: out.replace(/\s+/g, ' '), calls, planned };
}
const commandWords = (argv) => argv.slice(0, argv.findIndex((a) => a.startsWith('-')) >>> 0);
const changesRun = (calls) => calls.filter((argv) => commandWords(argv).some((w) => CHANGE.test(w)));
const one = (planned, re) => { const hits = planned.filter((l) => re.test(l)); assert.equal(hits.length, 1, `${re}: ${hits.length} planned commands match\n${planned.join('\n')}`); return hits[0]; };

test('T-74 -Plan on an empty subscription prints every change with its private-network properties and runs none', { skip }, (t) => {
  // The Azure CLI answers a DNS zone group that does not exist with {} and exit code 0 (measured 2026-09-29).
  const r = run(t, { 'network private-endpoint dns-zone-group show': {} }, ['-Plan']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Plan: \d+ command\(s\) would change the subscription; nothing was changed\./);
  assert.deepEqual(changesRun(r.calls), [], 'a change ran under -Plan');
  one(r.planned, /^network vnet subnet create .* -n snet-aca --address-prefixes 10\.40\.0\.0\/23 --delegations Microsoft\.App\/environments$/);
  one(r.planned, /^network vnet subnet create .* -n snet-pg --address-prefixes 10\.40\.3\.0\/27 --delegations Microsoft\.DBforPostgreSQL\/flexibleServers$/);
  one(r.planned, /^containerapp env create .* --infrastructure-subnet-resource-id \S+\/subnets\/snet-aca --internal-only true /);
  one(r.planned, new RegExp(`^postgres flexible-server create .* --vnet vnet-claude-gw --subnet snet-pg --private-dns-zone psql-claude-gw-${suffix}\\.private\\.postgres\\.database\\.azure\\.com `));
  one(r.planned, new RegExp(`^resource update --ids \\S+/accounts/ai-claude-gw-${suffix} --set properties\\.publicNetworkAccess=Disabled properties\\.disableLocalAuth=true$`));
  one(r.planned, /^network private-endpoint create .* --subnet snet-pe --private-connection-resource-id \S+ --group-id account /);
  for (const [verb, zone] of [['create', 'privatelink.cognitiveservices.azure.com'], ['add', 'privatelink.openai.azure.com'], ['add', 'privatelink.services.ai.azure.com']]) {
    one(r.planned, new RegExp(`^network private-endpoint dns-zone-group ${verb} .* --private-dns-zone ${zone.replaceAll('.', '\\.')} `));
  }
  assert.equal(r.planned.filter((l) => /^rest --method put --url https:\/\/management\.azure\.com\/\S+\/deployments\/claude-(sonnet|opus)-5\?api-version=\S+ --body @\S+$/.test(l)).length, 2);
  one(r.planned, /^network private-dns record-set a add-record .* -n "\*" -a "<static IP>"$/);
  one(r.planned, /^containerapp create -g rg-claude-gw-internal -n ca-claude-gw --yaml \S+$/);
  one(r.planned, /^vm create .* --subnet snet-dev --public-ip-address "" --nsg "" /);
  one(r.planned, /^network bastion create .* --sku Developer --vnet-name vnet-claude-gw$/);
  for (const line of r.planned.filter((l) => l.includes('--admin-password'))) assert.match(line, /--admin-password @\S+/, `a password on the command line: ${line}`);
  assert.equal(r.planned.filter((l) => l.includes('--admin-password')).length, 2);
});

function fullWorld() {
  const app = { displayName: `claude-apps-gateway-private-${suffix}`, appId: 'app-1', web: { redirectUris: [`https://ca-claude-gw.${DOMAIN}/oauth/callback`] }, api: { requestedAccessTokenVersion: 2 } };
  return {
    'group show': { name: RG }, 'network vnet show': { name: 'vnet' }, 'network nat gateway show': { name: 'ng' }, 'network vnet subnet show': { name: 'snet' },
    'network private-dns zone show': { name: 'zone' }, 'network private-dns link vnet show': { name: 'link' },
    'cognitiveservices account show': { properties: { publicNetworkAccess: 'Disabled', disableLocalAuth: true } },
    'cognitiveservices account deployment show': { name: 'deployment' }, 'network private-endpoint show': { name: 'pe-foundry' },
    'network private-endpoint dns-zone-group show': { privateDnsZoneConfigs: [{ name: 'cognitiveservices' }, { name: 'openai' }, { name: 'services-ai' }] },
    'postgres flexible-server show': { network: { publicNetworkAccess: 'Disabled' } }, 'postgres flexible-server db show': { name: 'gateway' },
    'acr show': { name: 'acr' }, 'acr repository show': { digest: 'sha256:0123' }, 'identity show': { principalId: 'p-1', clientId: 'c-1' },
    'role assignment list': [{ id: 'ra-1' }], 'monitor log-analytics workspace show': { customerId: 'ws-1' },
    'containerapp env show': { properties: { defaultDomain: DOMAIN, staticIp: '10.40.0.5' } },
    'network private-dns record-set a show': { aRecords: [{ ipv4Address: '10.40.0.5' }] },
    'ad app list': [app], 'ad sp show': { id: 'sp-1' }, rest: { value: [{ principalId: ME.id, appRoleId: PREMIUM }] },
    'containerapp show': { properties: { latestRevisionName: 'r1', latestReadyRevisionName: 'r1', configuration: { ingress: { fqdn: `ca-claude-gw.${DOMAIN}` } } } },
    'vm show': { name: 'vm-dev' }, 'network bastion show': { name: 'bas' },
  };
}

test('T-74 a re-run over resources that exist plans no change before the app, and finds each resource', { skip }, (t) => {
  const r = run(t, fullWorld(), ['-Plan', '-Step', 'network,dns,foundry,postgres,registry,identity,environment,entra']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.planned, []);
  assert.match(r.out, /Plan: 0 command\(s\) would change/);
  for (const found of ['resource group', 'private endpoint pe-foundry', 'public network access and local authentication disabled', 'record \\* -> 10\\.40\\.0\\.5',
    'Gateway\\.Premium for dev@contoso\\.example']) assert.match(r.out, new RegExp(`FOUND ${found}`));
});

test('T-74 -Step app reads the earlier steps without changing them, and updates the existing app', { skip }, (t) => {
  const r = run(t, fullWorld(), ['-Plan', '-Step', 'app']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /== environment \(read only, for the names later steps use\)/);
  assert.deepEqual(r.planned.map((l) => l.split(' --yaml')[0]), ['containerapp update -g rg-claude-gw-internal -n ca-claude-gw']);
});

test('T-74 -Step app without the plan stops before any change when an earlier step has not run', { skip }, (t) => {
  const world = fullWorld();
  world['containerapp env show'] = null;
  const r = run(t, world, ['-Step', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.flat, /The app step needs DefaultDomain from earlier steps/);
  assert.deepEqual(changesRun(r.calls), []);
});

test('T-74 a Claude deployment needs the organization attestation, and the step stops before creating one without it', { skip }, (t) => {
  const world = fullWorld();
  world['cognitiveservices account deployment show'] = null;
  const r = run(t, world, ['-Step', 'foundry']);
  assert.notEqual(r.status, 0);
  assert.match(r.flat, /needs -ClaudeOrganizationName/);
  assert.deepEqual(changesRun(r.calls), []);
  assert.deepEqual(r.calls.filter((argv) => argv[0] === 'rest'), [], 'a deployment was written without the attestation');
});

test('T-74 the image build waits for its run without streaming the log, and a failed build stops the deployment', { skip }, (t) => {
  const world = fullWorld();
  world['acr repository show'] = null;
  world['acr build'] = { runId: 'cj9', status: 'Failed' };
  const r = run(t, world, ['-Step', 'registry']);
  assert.notEqual(r.status, 0);
  assert.match(r.flat, /The image build cj9 ended with status Failed; az acr task logs --registry acrclaudegw\w+ --run-id cj9 prints its log\./);
  const builds = r.calls.filter((argv) => argv[0] === 'acr' && argv[1] === 'build');
  assert.equal(builds.length, 1);
  assert.ok(builds[0].includes('--no-logs'), `the build streams its log: ${builds[0].join(' ')}`);
});

test('T-74 the default replica ceiling fits the default PostgreSQL size, twice over for a rollout: 2 × replicas × store connections ≤ its user connections', () => {
  // Maximum user connections by SKU, https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits (2026-09-29).
  // While a new revision starts, the old one's replicas still hold their connections: on 2026-09-29 the rollout to
  // ca-claude-gw--0000001 logged "remaining connection slots are reserved" at 2 × 2 replicas × 10 connections.
  const userConnections = { Standard_B1ms: 35, Standard_B2s: 414, Standard_D2ds_v5: 844, Standard_D4ds_v5: 1703 };
  const text = fs.readFileSync(script, 'utf8');
  const defaultOf = (name) => new RegExp(`\\$${name} = '?([\\w.]+)'?`).exec(text)?.[1];
  const sku = defaultOf('PostgresSku');
  const maxReplicas = Number(defaultOf('MaxReplicas'));
  const perReplica = JSON.parse(fs.readFileSync(path.join(repo, 'config', 'gateway-admin.azure-private.json'), 'utf8')).deployment.storeConnectionsPerReplica;
  assert.ok(userConnections[sku], `no connection limit recorded for the default SKU ${sku}`);
  assert.ok(2 * maxReplicas * perReplica <= userConnections[sku],
    `2 × ${maxReplicas} replicas × ${perReplica} connections = ${2 * maxReplicas * perReplica}, more than the ${userConnections[sku]} user connections of ${sku}`);
});

test('T-74 a rotated client secret reaches the running app: the step restarts the latest revision, and only when a secret changed', { skip }, (t) => {
  // A secret change creates no revision and reaches none until one restarts or a new one is deployed
  // (https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets).
  const world = { ...fullWorld(), 'containerapp secret show': 'existing-secret-value' };
  const restarts = (r) => r.calls.filter((argv) => argv.slice(0, 3).join(' ') === 'containerapp revision restart');
  const rotated = run(t, world, ['-Step', 'app', '-RotateClientSecret']);
  assert.equal(rotated.status, 0, rotated.out);
  assert.deepEqual(restarts(rotated).map((argv) => argv[argv.indexOf('--revision') + 1]), ['r1']);
  const kept = run(t, world, ['-Step', 'app']);
  assert.equal(kept.status, 0, kept.out);
  assert.deepEqual(restarts(kept), [], 'a run that changed no secret restarted the app');
  const planned = run(t, world, ['-Plan', '-Step', 'app', '-RotateClientSecret']);
  assert.equal(planned.planned.filter((l) => l.startsWith('containerapp revision restart')).length, 1, planned.planned.join('\n'));
});

test('T-74 an unknown step is refused before anything is read or changed', { skip }, (t) => {
  const r = run(t, {}, ['-Plan', '-Step', 'network,bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.flat, /Unknown step bogus; the steps are all, network, dns/);
  assert.deepEqual(r.planned, []);
});

test('T-74 the verify verdicts: private addresses only, /readyz 200, Foundry 403 from outside, PostgreSQL public access Disabled', { skip }, () => {
  const ps = `Import-Module '${path.join(repo, 'infra', 'azure-private', 'lib', 'Az.psm1')}'; Import-Module '${path.join(repo, 'infra', 'azure-private', 'lib', 'Steps.Dev.psm1')}' -DisableNameChecking;
    $good = [pscustomobject]@{ gateway = @('10.40.0.5'); postgres = @('10.40.3.4'); foundry = @('10.40.2.4'); readyz = 200 };
    $cases = @(
      @('good', $good, 403, 'Disabled'),
      @('public gateway address', [pscustomobject]@{ gateway = @('10.40.0.5', '20.1.2.3'); postgres = $good.postgres; foundry = $good.foundry; readyz = 200 }, 403, 'Disabled'),
      @('no gateway address', [pscustomobject]@{ gateway = @(); postgres = $good.postgres; foundry = $good.foundry; readyz = 200 }, 403, 'Disabled'),
      @('readyz 503', [pscustomobject]@{ gateway = $good.gateway; postgres = $good.postgres; foundry = $good.foundry; readyz = 503 }, 403, 'Disabled'),
      @('Foundry answers outside', $good, 200, 'Disabled'),
      @('Foundry no answer', $good, 0, 'Disabled'),
      @('PostgreSQL public', $good, 403, 'Enabled'),
      @('CGNAT and 172.16', [pscustomobject]@{ gateway = @('100.64.0.9'); postgres = @('172.20.0.4'); foundry = @('192.168.1.4'); readyz = 200 }, 403, 'Disabled'),
      @('172.32 is public', [pscustomobject]@{ gateway = @('172.32.0.9'); postgres = $good.postgres; foundry = $good.foundry; readyz = 200 }, 403, 'Disabled'));
    $cases | ForEach-Object { $v = Get-VerifyChecks $_[1] $_[2] $_[3]; '{0}={1}' -f $_[0], (@($v.Values | Where-Object { -not $_ }).Count) }`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const failed = Object.fromEntries(r.stdout.trim().split(/\r?\n/).map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
  assert.deepEqual(failed, { good: 0, 'public gateway address': 1, 'no gateway address': 1, 'readyz 503': 1, 'Foundry answers outside': 1,
    'Foundry no answer': 1, 'PostgreSQL public': 1, 'CGNAT and 172.16': 0, '172.32 is public': 1 });
});

test('T-74 the Container App definition: internal ingress on 8080, scale rule, probes, drain window and secrets by reference', { skip }, () => {
  const ps = `Import-Module '${path.join(repo, 'infra', 'azure-private', 'lib', 'AppDefinition.psm1')}';
    $c = @{ Location = 'eastus2'; IdentityId = '/id/uai'; IdentityClientId = 'client-1'; EnvironmentId = '/env/1'; Acr = 'acr1'; Fqdn = 'ca.${DOMAIN}';
      Subnets = @{ aca = '10.40.0.0/23' }; TenantId = 't-1'; AppId = 'app-1'; AllowedEmailDomain = 'contoso.example'; PostgresUser = 'gatewayadmin'; Postgres = 'psql-1';
      Foundry = 'ai-1'; MaxUpstreamRequests = 256; ConfigFile = '${path.join(repo, 'config', 'gateway.azure-private.yaml')}'; Image = 'acr1.azurecr.io/claude-gateway@sha256:1';
      Cpu = '1.0'; Memory = '2Gi'; MinReplicas = 2; MaxReplicas = 10; ConcurrentRequests = 150 };
    ConvertTo-Json -Depth 20 -InputObject (New-AppDefinition $c)`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(d.properties.configuration.ingress, { external: true, targetPort: 8080, transport: 'http', allowInsecure: false });
  const container = d.properties.template.containers[0];
  assert.deepEqual([container.command, container.args], [['/usr/local/bin/claude'], ['gateway', '--config', '/etc/claude/gateway.yaml']]);
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value ?? `secretref:${e.secretRef}`]));
  assert.equal(env.GATEWAY_INGRESS_CIDR, undefined, 'the ingress addresses are constants in the configuration, not a variable');
  // The configuration is a secret, and a changed secret reaches no running revision; its hash in the template makes a
  // configuration change deploy a new revision (https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets).
  const configText = fs.readFileSync(path.join(repo, 'config', 'gateway.azure-private.yaml'), 'utf8');
  assert.equal(env.GATEWAY_CONFIG_SHA256, crypto.createHash('sha256').update(configText, 'utf8').digest('hex'));
  assert.equal(env.AZURE_CLIENT_ID, 'client-1');
  assert.equal(env.GATEWAY_PUBLIC_URL, `https://ca.${DOMAIN}`);
  for (const [name, ref] of [['OIDC_CLIENT_SECRET', 'oidc-client-secret'], ['GATEWAY_JWT_SECRET', 'jwt-secret'], ['GATEWAY_PG_PASSWORD', 'pg-password']]) assert.equal(env[name], `secretref:${ref}`);
  assert.ok(d.properties.template.terminationGracePeriodSeconds * 1000 >= Number(env.CLAUDE_GATEWAY_DRAIN_TIMEOUT_MS) + 5000, 'the grace period is not 5 s longer than the drain window');
  const probes = Object.fromEntries(container.probes.map((p) => [p.type, p.httpGet.path]));
  assert.deepEqual(probes, { Startup: '/healthz', Liveness: '/healthz', Readiness: '/readyz' });
  assert.deepEqual(d.properties.template.scale, { minReplicas: 2, maxReplicas: 10, rules: [{ name: 'http-concurrency', http: { metadata: { concurrentRequests: '150' } } }] });
  const secrets = Object.fromEntries(d.properties.configuration.secrets.map((s) => [s.name, s.value]));
  assert.equal(secrets['gateway-config'], fs.readFileSync(path.join(repo, 'config', 'gateway.azure-private.yaml'), 'utf8'));
  assert.deepEqual([secrets['jwt-secret'], secrets['pg-password'], secrets['oidc-client-secret']], ['__JWT__', '__PG__', '__OIDC__']);
});
