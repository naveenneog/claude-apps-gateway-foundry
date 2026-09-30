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
const LIB = path.join(repo, 'infra', 'azure-private', 'lib');
const imports = (...names) => names.map((n) => `Import-Module '${path.join(LIB, n)}.psm1' -DisableNameChecking;`).join(' ');
const COLLECTOR_TAG = 'opentelemetry-collector-contrib:0.161.0';
const COLLECTOR_DIGEST = /CollectorDigest = '(sha256:[0-9a-f]{64})'/.exec(fs.readFileSync(script, 'utf8'))[1];
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

// Runs Deploy-Gateway.ps1 with args, or a PowerShell command on the step modules, against the fake Azure CLI.
function run(t, world, args, command) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-azp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worldFile = path.join(dir, 'world.json');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(worldFile, JSON.stringify({ 'account show': ACCOUNT, 'ad signed-in-user show': ME, ...world }));
  fs.writeFileSync(log, '');
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', ...(command ? ['-Command', command] : ['-File', script, ...args])], {
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A PowerShell command on the step modules, with the Azure CLI runner started against the fake.
const onModules = (body, plan = false) => `$ErrorActionPreference = 'Stop'; ${imports('Az', 'Steps.Base', 'AppDefinition', 'Steps.App', 'Steps.Telemetry', 'Steps.Dev')}
  Initialize-AzRunner${plan ? ' -Plan' : ''}; try { ${body} } finally { Clear-AzSecrets }`;

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
    'acr show': { name: 'acr' }, 'acr repository show': { digest: 'sha256:0123' }, [`acr repository show --image ${COLLECTOR_TAG}`]: { digest: COLLECTOR_DIGEST },
    'identity show': { principalId: 'p-1', clientId: 'c-1' },
    'role assignment list': [{ id: 'ra-1' }],
    'monitor log-analytics workspace show': { id: '/ws/log-claude-gw', customerId: 'ws-1', retentionInDays: 30,
      features: { immediatePurgeDataOn30Days: true, enableLogAccessUsingOnlyResourcePermissions: false } },
    // Usage and AzureActivity keep at least 90 days (U-30); every other table is at the workspace's 30 days.
    'monitor log-analytics workspace table list': [{ name: 'AppMetrics', retentionInDays: 30, totalRetentionInDays: 30 },
      { name: 'ContainerAppConsoleLogs_CL', retentionInDays: 30, totalRetentionInDays: 30 }, { name: 'Usage', retentionInDays: 90, totalRetentionInDays: 90 },
      { name: 'AzureActivity', retentionInDays: 90, totalRetentionInDays: 90 }],
    'resource show': { id: '/appi/1', properties: { DisableLocalAuth: true, WorkspaceResourceId: '/ws/log-claude-gw', ConnectionString: 'InstrumentationKey=k-1' } },
    'containerapp env show': { properties: { defaultDomain: DOMAIN, staticIp: '10.40.0.5' } },
    'network private-dns record-set a show': { aRecords: [{ ipv4Address: '10.40.0.5' }] },
    'ad app list': [app], 'ad sp show': { id: 'sp-1' }, rest: { value: [{ principalId: ME.id, appRoleId: PREMIUM }] },
    'containerapp show': { properties: { latestRevisionName: 'r1', latestReadyRevisionName: 'r1', configuration: { ingress: { fqdn: `ca-claude-gw.${DOMAIN}` } } } },
    'vm show': { name: 'vm-dev' }, 'network bastion show': { name: 'bas' },
  };
}

test('T-74 a re-run over resources that exist plans no change before the app, and finds each resource', { skip }, (t) => {
  const r = run(t, fullWorld(), ['-Plan', '-Step', 'network,dns,foundry,postgres,registry,identity,environment,telemetry,entra']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.planned, []);
  assert.match(r.out, /Plan: 0 command\(s\) would change/);
  for (const found of ['resource group', 'private endpoint pe-foundry', 'public network access and local authentication disabled', 'record \\* -> 10\\.40\\.0\\.5',
    'Gateway\\.Premium for dev@contoso\\.example', 'Application Insights appi-claude-gw with local authentication off',
    '2 table\\(s\\) at 30 days or less; Usage and AzureActivity keep their 90-day minimum',
    'workspace log-claude-gw: retention 30 days, purge at 30 days, workspace permissions required',
    'image opentelemetry-collector-contrib:0\\.161\\.0 at the pinned digest']) assert.match(r.out, new RegExp(`FOUND ${found}`));
});

test('T-74 -Step app reads the earlier steps without changing them, and updates the existing app', { skip }, (t) => {
  const r = run(t, fullWorld(), ['-Plan', '-Step', 'app']);
  assert.equal(r.status, 0, r.out);
  for (const step of ['environment', 'telemetry', 'entra']) assert.match(r.out, new RegExp(`== ${step} \\(read only, for the names later steps use\\)`));
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
  const world = { ...fullWorld(), 'containerapp secret show': 'existing-secret-value', 'containerapp secret show --secret-name appinsights-connection': 'InstrumentationKey=k-1' };
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

// The tables a workspace-based component adds; AppGenAIContent appeared by 2026-09-30, after U-30 listed eleven.
const APP_TABLES = ['AppAvailabilityResults', 'AppBrowserTimings', 'AppDependencies', 'AppExceptions', 'AppEvents', 'AppGenAIContent', 'AppMetrics',
  'AppPageViews', 'AppPerformanceCounters', 'AppRequests', 'AppSystemEvents', 'AppTraces'];

test('T-79 -Plan plans the telemetry: the component on the workspace, its publisher role, 30-day tables, workspace settings and the collector image', { skip }, (t) => {
  const r = run(t, { 'network private-endpoint dns-zone-group show': {} }, ['-Plan']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(changesRun(r.calls), [], 'a change ran under -Plan');
  one(r.planned, /^resource create -g rg-claude-gw-internal -n appi-claude-gw --resource-type Microsoft\.Insights\/components --api-version 2020-02-02 --is-full-object --properties @\S+$/);
  one(r.planned, /^role assignment create --assignee-object-id "<principal ID of id-claude-gw>" --assignee-principal-type ServicePrincipal --role "Monitoring Metrics Publisher" --scope \S+\/providers\/Microsoft\.Insights\/components\/appi-claude-gw$/);
  one(r.planned, /^resource update --ids \S+\/providers\/Microsoft\.OperationalInsights\/workspaces\/log-claude-gw --set properties\.retentionInDays=30 properties\.features\.immediatePurgeDataOn30Days=true properties\.features\.enableLogAccessUsingOnlyResourcePermissions=false$/);
  for (const table of APP_TABLES) {
    one(r.planned, new RegExp(`^monitor log-analytics workspace table update -g rg-claude-gw-internal --workspace-name log-claude-gw -n ${table} --retention-time 30 --total-retention-time 30$`));
  }
  one(r.planned, new RegExp(`^acr import -n acrclaudegw${suffix} --source ghcr\\.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1 --image opentelemetry-collector-contrib:0\\.161\\.0$`));
  assert.ok(r.out.indexOf('== environment') < r.out.indexOf('== telemetry') && r.out.indexOf('== telemetry') < r.out.indexOf('== app'), 'the telemetry step runs after the workspace exists and before the app');
});

test('T-79 a table above 30 days, a workspace that keeps data past 30 days, a missing role and local authentication on are each planned for change', { skip }, (t) => {
  const world = fullWorld();
  // Every table the workspace lists is checked, one the step has never heard of included; Usage and AzureActivity cannot go below 90.
  world['monitor log-analytics workspace table list'] = [{ name: 'AppMetrics', retentionInDays: 30, totalRetentionInDays: 90 },
    { name: 'AppGenAIContent', retentionInDays: 90, totalRetentionInDays: 90 }, { name: 'AppNotYetKnown', retentionInDays: 90, totalRetentionInDays: 90 },
    { name: 'ContainerAppConsoleLogs_CL', retentionInDays: 30, totalRetentionInDays: 30 }, { name: 'Usage', retentionInDays: 90, totalRetentionInDays: 90 },
    { name: 'AzureActivity', retentionInDays: 90, totalRetentionInDays: 90 }];
  world['monitor log-analytics workspace show'] = { ...world['monitor log-analytics workspace show'], features: { immediatePurgeDataOn30Days: false, enableLogAccessUsingOnlyResourcePermissions: false } };
  world['resource show'] = { ...world['resource show'], properties: { ...world['resource show'].properties, DisableLocalAuth: false } };
  world['role assignment list'] = [];
  const r = run(t, world, ['-Plan', '-Step', 'telemetry']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.planned.filter((l) => l.startsWith('monitor log-analytics workspace table update')).map((l) => l.match(/ -n (\S+) /)[1]),
    ['AppMetrics', 'AppGenAIContent', 'AppNotYetKnown']);
  one(r.planned, /^resource update --ids \/ws\/log-claude-gw --set properties\.retentionInDays=30 properties\.features\.immediatePurgeDataOn30Days=true properties\.features\.enableLogAccessUsingOnlyResourcePermissions=false$/);
  one(r.planned, /^resource update --ids \/appi\/1 --set properties\.DisableLocalAuth=true$/);
  one(r.planned, /^role assignment create .* --role "Monitoring Metrics Publisher" --scope \/appi\/1$/);
});

test('T-79 a workspace that keeps data 90 days is planned for 30, although its purge and permission settings and its tables are right', { skip }, (t) => {
  const world = fullWorld();
  world['monitor log-analytics workspace show'] = { ...world['monitor log-analytics workspace show'], retentionInDays: 90 };
  const r = run(t, world, ['-Plan', '-Step', 'telemetry']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.planned, ['resource update --ids /ws/log-claude-gw --set properties.retentionInDays=30 properties.features.immediatePurgeDataOn30Days=true properties.features.enableLogAccessUsingOnlyResourcePermissions=false']);
});

test('T-79 a collector tag at another digest stops the telemetry step before any change, naming both digests and the command that removes the tag', { skip }, (t) => {
  const world = fullWorld();
  world[`acr repository show --image ${COLLECTOR_TAG}`] = { digest: OTHER_DIGEST };
  world['monitor log-analytics workspace show'] = { ...world['monitor log-analytics workspace show'], retentionInDays: 90 };
  const r = run(t, world, ['-Plan', '-Step', 'telemetry']);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.flat, new RegExp(`The image ${esc(COLLECTOR_TAG)} in acrclaudegw${suffix} has digest ${OTHER_DIGEST}, not the pinned ${COLLECTOR_DIGEST}\\.`));
  assert.match(r.flat, new RegExp(`az acr repository untag -n acrclaudegw${suffix} --image ${esc(COLLECTOR_TAG)}`));
  assert.deepEqual(r.planned, [], 'a change was planned before the digest was checked');
});

test('T-79 after the import the step reads the digest again, and stops when the registry does not hold the pinned one', { skip }, (t) => {
  const world = { ...fullWorld(), [`acr repository show --image ${COLLECTOR_TAG}`]: { sequence: [null, { digest: OTHER_DIGEST }] } };
  const r = run(t, world, ['-Step', 'telemetry']);
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.calls.filter((argv) => argv.slice(0, 2).join(' ') === 'acr import').length, 1);
  assert.match(r.flat, new RegExp(`After the import, the image ${esc(COLLECTOR_TAG)} in acrclaudegw${suffix} has digest ${OTHER_DIGEST}, not the pinned ${COLLECTOR_DIGEST}\\.`));
});

test('T-79 the app references the collector by the pinned digest, and by a placeholder while the image is not in the registry', { skip }, (t) => {
  const image = (answer, plan) => {
    const r = run(t, { ...fullWorld(), [`acr repository show --image ${COLLECTOR_TAG}`]: answer }, null, onModules(`$c = @{ Telemetry = $true; ResourceGroup = '${RG}';
      SubscriptionId = '${ACCOUNT.id}'; Location = 'eastus2'; Workspace = 'log-claude-gw'; AppInsights = 'appi-claude-gw'; Identity = 'id-claude-gw';
      IdentityPrincipalId = 'p-1'; Acr = 'acr1'; CollectorVersion = '0.161.0'; CollectorDigest = '${COLLECTOR_DIGEST}' }; Step-Telemetry $c; 'IMAGE ' + $c.CollectorImage`, plan));
    assert.equal(r.status, 0, r.out);
    return /^IMAGE (.+)$/m.exec(r.out)[1];
  };
  const pinned = `acr1.azurecr.io/opentelemetry-collector-contrib@${COLLECTOR_DIGEST}`;
  assert.equal(image({ digest: COLLECTOR_DIGEST }, false), pinned);
  assert.equal(image({ sequence: [null, { digest: COLLECTOR_DIGEST }] }, false), pinned);
  assert.match(image(null, true), /^<.+>$/);
});

// The Application Insights component (ADR-0007): workspace-based on the gateway's workspace, local authentication off.
test('T-79 the component definition: kind other, on the workspace, local authentication off', { skip }, () => {
  const ps = `Import-Module '${path.join(repo, 'infra', 'azure-private', 'lib', 'Steps.Telemetry.psm1')}' -DisableNameChecking;
    ConvertTo-Json -Depth 10 -InputObject (New-ComponentDefinition @{ Location = 'northcentralus'; WorkspaceId = '/ws/log-claude-gw' })`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { location: 'northcentralus', kind: 'other',
    properties: { Application_Type: 'other', WorkspaceResourceId: '/ws/log-claude-gw', IngestionMode: 'LogAnalytics', DisableLocalAuth: true } });
});

test('T-79 the Container App definition with telemetry: the collector sidecar by digest, its configuration as a secret volume, and the loopback allowed', { skip }, () => {
  const collectorConfig = path.join(repo, 'config', 'otel-collector.azure-private.json');
  const definition = (telemetry) => {
    const ps = `Import-Module '${path.join(repo, 'infra', 'azure-private', 'lib', 'AppDefinition.psm1')}';
      $c = @{ Location = 'eastus2'; IdentityId = '/id/uai'; IdentityClientId = 'client-1'; EnvironmentId = '/env/1'; Acr = 'acr1'; Fqdn = 'ca.${DOMAIN}';
        TenantId = 't-1'; AppId = 'app-1'; AllowedEmailDomain = 'contoso.example'; PostgresUser = 'gatewayadmin'; Postgres = 'psql-1'; Foundry = 'ai-1';
        MaxUpstreamRequests = 256; ConfigFile = '${path.join(repo, 'config', 'gateway.azure-private.yaml')}'; Image = 'acr1.azurecr.io/claude-gateway@sha256:1';
        Cpu = '1.0'; Memory = '2Gi'; MinReplicas = 2; MaxReplicas = 10; ConcurrentRequests = 150; Telemetry = $${telemetry};
        CollectorImage = 'acr1.azurecr.io/opentelemetry-collector-contrib@sha256:2'; CollectorConfigFile = '${collectorConfig}' };
      ConvertTo-Json -Depth 20 -InputObject (New-AppDefinition $c)`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const envOf = (container) => Object.fromEntries(container.env.map((e) => [e.name, e.value ?? `secretref:${e.secretRef}`]));
  const on = definition('true');
  const [gateway, collector] = on.properties.template.containers;
  assert.equal(on.properties.template.containers.length, 2);
  assert.equal(envOf(gateway).CLAUDE_GATEWAY_ALLOW_LOOPBACK, '1', 'the gateway refuses a loopback destination without it');
  assert.equal(collector.name, 'otel-collector');
  assert.equal(collector.image, 'acr1.azurecr.io/opentelemetry-collector-contrib@sha256:2');
  assert.deepEqual(collector.args, ['--config=/etc/otelcol/config.yaml']);
  assert.deepEqual(collector.resources, { cpu: 0.25, memory: '0.5Gi' });
  assert.deepEqual(collector.volumeMounts, [{ volumeName: 'otel-config', mountPath: '/etc/otelcol' }]);
  const text = fs.readFileSync(collectorConfig, 'utf8');
  assert.deepEqual(envOf(collector), { AZURE_CLIENT_ID: 'client-1', APPLICATIONINSIGHTS_CONNECTION_STRING: 'secretref:appinsights-connection',
    OTEL_CONFIG_SHA256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') });
  const secrets = Object.fromEntries(on.properties.configuration.secrets.map((s) => [s.name, s.value]));
  assert.equal(secrets['otel-config'], text);
  assert.equal(secrets['appinsights-connection'], '__APPINSIGHTS__');
  assert.ok(on.properties.template.volumes.some((v) => v.name === 'otel-config' && v.storageType === 'Secret'
    && v.secrets.length === 1 && v.secrets[0].secretRef === 'otel-config' && v.secrets[0].path === 'config.yaml'));
  const off = definition('false');
  assert.equal(off.properties.template.containers.length, 1);
  assert.equal(envOf(off.properties.template.containers[0]).CLAUDE_GATEWAY_ALLOW_LOOPBACK, undefined);
  assert.ok(!off.properties.configuration.secrets.some((s) => ['otel-config', 'appinsights-connection'].includes(s.name)));
});

test('T-79 while telemetry is on, the app step refuses to deploy when anyone but the operator holds a role of the app registration', { skip }, (t) => {
  const world = fullWorld();
  world.rest = { value: [{ principalId: ME.id, appRoleId: PREMIUM }, { principalId: 'user-2', principalDisplayName: 'Other Dev', principalType: 'User', appRoleId: PREMIUM }] };
  for (const args of [['-Step', 'app'], ['-Plan', '-Step', 'app']]) {
    const r = run(t, world, args);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.flat, new RegExp(`Only the operator may hold a role of claude-apps-gateway-private-${suffix} while telemetry is on\\b.*Other holders: Other Dev \\(User user-2\\)\\.`));
    assert.deepEqual(changesRun(r.calls), []);
    assert.deepEqual(r.planned, [], `${args.join(' ')} planned a change before the rule stopped it`);
  }
});

test('T-79 the entra step reads every page of the role holders', { skip }, (t) => {
  const first = 'https://graph.microsoft.com/v1.0/servicePrincipals/sp-1/appRoleAssignedTo';
  const next = `${first}?$skiptoken=page-2`;
  const world = { ...fullWorld(), [`rest --url ${first}`]: { value: [{ principalId: ME.id, appRoleId: PREMIUM }], '@odata.nextLink': next },
    [`rest --url ${next}`]: { value: [{ principalId: 'user-3', principalDisplayName: 'Page Two', principalType: 'User', appRoleId: PREMIUM }] } };
  const r = run(t, world, ['-Plan', '-Step', 'app']);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.flat, /Other holders: Page Two \(User user-3\)\./);
});

test('T-79 a role-holder page that is missing, fails or holds no list stops the entra step, so a partial list never passes the operator-only rule', { skip }, (t) => {
  // Council round 2 (QA): a later page that answered not-found ended the paging, and the first page alone passed the rule.
  const first = 'https://graph.microsoft.com/v1.0/servicePrincipals/sp-1/appRoleAssignedTo';
  const next = `${first}?$skiptoken=page-2`;
  const world = (second) => ({ ...fullWorld(), [`rest --url ${first}`]: { value: [{ principalId: ME.id, appRoleId: PREMIUM }], '@odata.nextLink': next },
    [`rest --url ${next}`]: second });
  const control = run(t, world({ value: [] }), ['-Plan', '-Step', 'app']);
  assert.equal(control.status, 0, `an empty last page is a complete list: ${control.out}`);
  for (const [name, second, reason] of [
    ['not found', null, /failed \(3\): \(ResourceNotFound\)/],
    ['unavailable', { fail: 'ERROR: Service Unavailable' }, /failed \(1\): ERROR: Service Unavailable/],
    ['no list', { '@odata.context': 'page-2' }, /The role holders of service principal sp-1 were not read: a page of \S+ holds no list of assignments\./],
    ['a list that is not one', { value: { principalId: ME.id, appRoleId: PREMIUM } }, /The role holders of service principal sp-1 were not read: a page of \S+ holds no list of assignments\./],
  ]) {
    const r = run(t, world(second), ['-Plan', '-Step', 'app']);
    assert.notEqual(r.status, 0, `${name}: ${r.out}`);
    assert.match(r.flat, reason, name);
    assert.deepEqual(r.planned, [], `${name}: a change was planned after a partial read`);
  }
});

test('T-79 a service principal the entra step creates has no role holders to read: the step assigns the operator without asking Graph for them', { skip }, (t) => {
  // Graph can take seconds to know a new service principal; a read of its holders then answers not found.
  const holders = 'https://graph.microsoft.com/v1.0/servicePrincipals/sp-new/appRoleAssignedTo';
  const world = { ...fullWorld(), 'ad sp show': null, 'ad sp create': { id: 'sp-new' }, [`rest --url ${holders}`]: null, 'rest --method POST': { id: 'assignment-1' } };
  const r = run(t, world, ['-Step', 'entra']);
  assert.equal(r.status, 0, r.out);
  const rest = r.calls.filter((argv) => argv[0] === 'rest').map((argv) => argv[argv.indexOf('--method') + 1]);
  assert.deepEqual(rest, ['POST'], 'the step read the holders of the service principal it had just created');
});

test('T-79 the operator-only rule: another holder or holders not read stop the app step while telemetry is on; telemetry off lifts the rule', { skip }, (t) => {
  const r = run(t, {}, null, onModules(`$me = [pscustomobject]@{ Id = '${ME.id}'; Name = $null; Type = 'User' }
    $group = [pscustomobject]@{ Id = 'g-1'; Name = 'Developers'; Type = 'Group' }
    $cases = [ordered]@{ 'operator only' = @($true, @($me)); 'a group too' = @($true, @($me, $group)); 'telemetry off' = @($false, @($me, $group)); 'not read' = @($true, $null) }
    foreach ($name in $cases.Keys) {
      $c = @{ Telemetry = $cases[$name][0]; AppRegistration = 'app-reg'; OperatorId = '${ME.id}' }
      if ($null -ne $cases[$name][1]) { $c.RoleHolders = $cases[$name][1] }
      try { Assert-OnlyOperatorHoldsRoles $c; '{0}=ok' -f $name } catch { '{0}={1}' -f $name, $_.Exception.Message }
    }`));
  assert.equal(r.status, 0, r.out);
  const said = Object.fromEntries(r.out.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(said['operator only'], 'ok');
  assert.match(said['a group too'], /^Only the operator may hold a role of app-reg while telemetry is on\b.*Other holders: Developers \(Group g-1\)\./);
  assert.equal(said['telemetry off'], 'ok');
  assert.match(said['not read'], /^The holders of the roles of app-reg were not read\b/);
});

test('T-79 a changed Application Insights connection string reaches the running app: the step restarts the latest revision', { skip }, (t) => {
  const world = { ...fullWorld(), 'containerapp secret show': 'existing-secret-value', 'containerapp secret show --secret-name appinsights-connection': 'InstrumentationKey=old' };
  const r = run(t, world, ['-Step', 'app']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls.filter((argv) => argv.slice(0, 3).join(' ') === 'containerapp revision restart').map((argv) => argv[argv.indexOf('--revision') + 1]), ['r1']);
});

test('T-74 a secret the app step cannot read stops it before any change; only a secret the app does not have is made anew', { skip }, (t) => {
  // On 2026-09-30 a read that failed with 503 Service Unavailable counted as a missing secret, and the step appended a new
  // client secret. The Azure CLI's answer for a missing secret, measured the same day, is the "does not have" message.
  const base = { ...fullWorld(), 'containerapp secret show': 'existing-secret-value', 'containerapp secret show --secret-name appinsights-connection': 'InstrumentationKey=k-1' };
  const unavailable = { fail: "ERROR: Service Unavailable(<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN'>" };
  for (const name of ['jwt-secret', 'pg-password', 'oidc-client-secret', 'appinsights-connection']) {
    const r = run(t, { ...base, [`containerapp secret show --secret-name ${name}`]: unavailable }, ['-Step', 'app']);
    assert.notEqual(r.status, 0, `${name}: ${r.out}`);
    assert.match(r.flat, new RegExp(`az containerapp secret show -g ${RG} -n ca-claude-gw --secret-name ${name} --query value failed \\(1\\): ERROR: Service Unavailable`));
    assert.deepEqual(changesRun(r.calls), [], `${name}: a change ran after a failed read`);
  }
  const missing = { fail: 'ERROR: The containerapp ca-claude-gw does not have a secret assigned with name oidc-client-secret.' };
  const r = run(t, { ...base, 'containerapp secret show --secret-name oidc-client-secret': missing }, ['-Step', 'app']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls.filter((argv) => argv.slice(0, 4).join(' ') === 'ad app credential reset').length, 1);
});

test('T-74 the app step reads every secret before it changes any: a failed read after a missing or rotated secret leaves Azure unchanged', { skip }, (t) => {
  // Council round 2: a new PostgreSQL password or an appended client secret, made before a later read failed, stayed behind.
  const base = { ...fullWorld(), 'containerapp secret show': 'existing-secret-value', 'containerapp secret show --secret-name appinsights-connection': 'InstrumentationKey=k-1' };
  const unavailable = { fail: 'ERROR: Service Unavailable' };
  const missing = (name) => ({ fail: `ERROR: The containerapp ca-claude-gw does not have a secret assigned with name ${name}.` });
  const cases = [
    ['a rotation, then the connection string unreadable', { 'containerapp secret show --secret-name appinsights-connection': unavailable }, ['-RotateClientSecret']],
    ['pg-password missing, then the client secret unreadable', { 'containerapp secret show --secret-name pg-password': missing('pg-password'),
      'containerapp secret show --secret-name oidc-client-secret': unavailable }, []],
    ['pg-password missing, then the connection string unreadable', { 'containerapp secret show --secret-name pg-password': missing('pg-password'),
      'containerapp secret show --secret-name appinsights-connection': unavailable }, []],
  ];
  for (const [name, overrides, extra] of cases) {
    const r = run(t, { ...base, ...overrides }, ['-Step', 'app', ...extra]);
    assert.notEqual(r.status, 0, `${name}: ${r.out}`);
    assert.match(r.flat, /failed \(1\): ERROR: Service Unavailable/, name);
    assert.deepEqual(changesRun(r.calls), [], `${name}: a change ran before every secret was read`);
  }
});

test('T-78 and T-32 verdicts: the metric accepted, 404 for logs and traces, the metric arrived with its attributes, local authentication off, no other role holder', { skip }, (t) => {
  const r = run(t, {}, null, `${imports('Az', 'Steps.Telemetry')}
    $good = [pscustomobject]@{ 'user.email' = 'verify@contoso.example'; model = 'claude-sonnet-5'; type = 'input' }
    $base = @{ Posted = @{ metrics = 200; logs = 404; traces = 404 }; Notes = @{}; Properties = $good; LocalAuthDisabled = $true; OtherRoleHolders = @(); WaitMinutes = 10 }
    $lost = 'no HTTP response (exec exit 3: gone)'
    $cases = [ordered]@{
      'good' = @{}
      'metric refused' = @{ Posted = @{ metrics = 403; logs = 404; traces = 404 } }
      'logs accepted' = @{ Posted = @{ metrics = 200; logs = 200; traces = 404 } }
      'logs 400' = @{ Posted = @{ metrics = 200; logs = 400; traces = 404 } }
      'traces 415' = @{ Posted = @{ metrics = 200; logs = 404; traces = 415 } }
      'traces 429' = @{ Posted = @{ metrics = 200; logs = 404; traces = 429 } }
      'no answer' = @{ Posted = @{ metrics = 0; logs = 0; traces = 0 }; Notes = @{ metrics = $lost; logs = $lost; traces = $lost } }
      'not arrived' = @{ Properties = $null }
      'no user.email' = @{ Properties = [pscustomobject]@{ model = 'claude-sonnet-5'; type = 'input' } }
      'another model' = @{ Properties = [pscustomobject]@{ 'user.email' = 'verify@contoso.example'; model = 'claude-opus-5'; type = 'input' } }
      'local auth on' = @{ LocalAuthDisabled = $false }
      'another holder' = @{ OtherRoleHolders = @('Other Dev (User user-2)') }
      'holders not read' = @{ OtherRoleHolders = $null }
    }
    foreach ($name in $cases.Keys) {
      $o = $base.Clone(); foreach ($k in $cases[$name].Keys) { $o[$k] = $cases[$name][$k] }
      $v = Get-TelemetryChecks $o
      '{0}={1}|{2}' -f $name, @($v.Values | Where-Object { -not $_ }).Count, (@($v.Keys | Where-Object { -not $v[$_] }) -join ' ; ')
    }`);
  assert.equal(r.status, 0, r.out);
  const lines = r.out.split(/\r?\n/).filter((l) => l.includes('|')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).split('|')]);
  assert.deepEqual(Object.fromEntries(lines.map(([k, [n]]) => [k, Number(n)])), { good: 0, 'metric refused': 1, 'logs accepted': 1, 'logs 400': 1,
    'traces 415': 1, 'traces 429': 1, 'no answer': 2, 'not arrived': 2, 'no user.email': 1, 'another model': 1, 'local auth on': 1, 'another holder': 1, 'holders not read': 1 });
  const failed = Object.fromEntries(lines.map(([k, [, keys]]) => [k, keys]));
  assert.match(failed['no answer'], /the collector accepts a metric: no HTTP response \(exec exit 3: gone\) \(T-78\)/);
  assert.match(failed['logs 400'], /the collector has no pipeline for logs or traces: HTTP 400 and HTTP 404 \(T-32\)/);
  assert.match(failed['not arrived'], /the metric reaches AppMetrics within 10 minutes \(T-78\) ; the metric keeps its user\.email, model and type/);
  assert.match(failed['another holder'], /role holders other than the operator: Other Dev \(User user-2\)/);
  assert.match(failed['holders not read'], /role holders other than the operator: not read/);
});

const VERIFY_C = `$c = @{ ResourceGroup = '${RG}'; App = 'ca-claude-gw'; Fqdn = 'ca-claude-gw.${DOMAIN}'; Postgres = 'psql-1'; Foundry = 'ai-1'; DevVm = 'vm-dev';
  Workspace = 'log-claude-gw'; AppInsights = 'appi-claude-gw'; Telemetry = $true; TelemetryWaitMinutes = 0; TelemetryPollSeconds = 0; AppRegistration = 'app-reg';
  OperatorId = '${ME.id}'; RoleHolders = @([pscustomobject]@{ Id = '${ME.id}'; Name = $null; Type = 'User' }) };`;
const METRIC_ROW = (model) => ({ tables: [{ rows: [[JSON.stringify({ 'user.email': 'verify@contoso.example', model, type: 'input' })]] }] });
const telemetryWorld = (overrides = {}) => ({ ...fullWorld(), 'containerapp exec': 'metrics 200\nlogs 404\ntraces 404', 'rest --method post': METRIC_ROW('claude-sonnet-5'),
  'vm run-command invoke': { value: [{ message: JSON.stringify({ gateway: ['10.40.0.5'], postgres: ['10.40.3.4'], foundry: ['10.40.2.4'], readyz: 200, certificate: 'n/a' }) }, { message: '' }] },
  ...overrides });
const execs = (r) => r.calls.filter((argv) => argv.slice(0, 2).join(' ') === 'containerapp exec').length;

test('T-78 the verify step checks telemetry when the admin file turns it on, and only then', { skip }, (t) => {
  // The Foundry request from this machine is replaced, at module level, by its expected answer.
  const verify = (world, telemetry) => run(t, world, null, onModules(`& (Get-Module Steps.Dev) { function script:Get-FoundryOutsideStatus($c) { 403 } }
    ${VERIFY_C} $c.Telemetry = $${telemetry}; Step-Verify $c`));
  const on = verify(telemetryWorld(), true);
  assert.equal(on.status, 0, on.out);
  assert.equal(execs(on), 3);
  assert.match(on.flat, /PASS Foundry refuses a request from outside the VNet: 403/);
  const off = verify(telemetryWorld(), false);
  assert.equal(off.status, 0, off.out);
  assert.equal(execs(off), 0);
  const refused = verify(telemetryWorld({ 'containerapp exec': 'metrics 503\nlogs 404\ntraces 404' }), true);
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.flat, /FAIL the collector accepts a metric: HTTP 503 .*a telemetry check failed/);
});

test('T-78 the delivery check: three tries per signal, a missing answer named with its exec exit code, arrival and attributes checked apart', { skip }, (t) => {
  const deliver = (world) => run(t, world, null, onModules(`${VERIFY_C} Test-TelemetryDelivery $c`));
  const lost = deliver(telemetryWorld({ 'containerapp exec': null }));
  assert.notEqual(lost.status, 0, lost.out);
  assert.equal(execs(lost), 9);
  assert.match(lost.flat, /FAIL the collector accepts a metric: no HTTP response \(exec exit 3: \(ResourceNotFound\) containerapp exec: not found\) \(T-78\)/);
  assert.match(lost.flat, /a telemetry check failed/);
  // The exec proxy prints its messages on standard output as "INFO: ..." and "ERROR: ..." (azure-cli, containerapp/_ssh_utils.py).
  const stopped = deliver(telemetryWorld({ 'containerapp exec': "INFO: Connecting to the container 'gateway'...\nERROR: The container gateway is not running" }));
  assert.equal(execs(stopped), 9);
  assert.match(stopped.flat, /FAIL the collector accepts a metric: no HTTP response \(exec exit 0: ERROR: The container gateway is not running\) \(T-78\)/);
  const retried = deliver(telemetryWorld({ 'containerapp exec': { sequence: [null, 'metrics 200\nlogs 404\ntraces 404'] } }));
  assert.equal(retried.status, 0, retried.out);
  assert.equal(execs(retried), 4);
  assert.match(retried.flat, /PASS role holders other than the operator: none/);
  const late = deliver(telemetryWorld({ 'rest --method post': { tables: [{ rows: [] }] } }));
  assert.notEqual(late.status, 0, late.out);
  assert.match(late.flat, /waiting up to 0 minutes for cgw_verify_[0-9a-f]{8} in AppMetrics of log-claude-gw/);
  assert.equal(late.calls.filter((argv) => argv[0] === 'rest').length, 1, 'the workspace was not queried exactly once');
  assert.match(late.flat, /FAIL the metric reaches AppMetrics within 0 minutes/);
  const changed = deliver(telemetryWorld({ 'rest --method post': METRIC_ROW('claude-opus-5') }));
  assert.notEqual(changed.status, 0, changed.out);
  assert.match(changed.flat, /PASS the metric reaches AppMetrics within 0 minutes/);
  assert.match(changed.flat, /FAIL the metric keeps its user\.email, model and type/);
  const shared = run(t, telemetryWorld(), null, onModules(`${VERIFY_C} $c.RoleHolders += [pscustomobject]@{ Id = 'user-2'; Name = 'Other Dev'; Type = 'User' }; Test-TelemetryDelivery $c`));
  assert.notEqual(shared.status, 0, shared.out);
  assert.match(shared.flat, /FAIL role holders other than the operator: Other Dev \(User user-2\) \(ADR-0007\).*a telemetry check failed/);
});

test('T-78 -Step verify reads the entra step, for the role holders it checks', { skip }, (t) => {
  const r = run(t, fullWorld(), ['-Plan', '-Step', 'verify']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /== entra \(read only, for the names later steps use\)/);
});