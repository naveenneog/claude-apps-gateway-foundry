// P-10 (T-73): the network-restricted topology of scripts/admin/new-gateway-config.mjs (ADR-0005). The gateway trusts
// X-Forwarded-For only from the Container Apps infrastructure subnet, reaches PostgreSQL over TLS, admits the listed
// developer networks, sizes the sign-in limits for a large rollout, and opts each policy in to Claude Desktop.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adminErrors, renderGatewayConfig } from '../scripts/admin/new-gateway-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const script = path.join(root, 'scripts', 'admin', 'new-gateway-config.mjs');
const ROLES = ['Gateway.Standard', 'Gateway.Premium'];
const privateAdmin = (deployment = {}) => ({
  roles: ROLES,
  models: [
    { id: 'claude-opus-5', label: 'Claude Opus 5', deployment: 'claude-opus-5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', deployment: 'claude-sonnet-5' },
  ],
  policies: [
    { role: 'Gateway.Premium', models: ['claude-opus-5', 'claude-sonnet-5'] },
    { role: 'Gateway.Standard', models: ['claude-sonnet-5'] },
  ],
  deployment: { developerCidrs: ['10.40.0.0/16', '10.200.0.0/14'], signInsPerAddress: 1000, codeSubmissionsPerAddress: 100,
    storeConnectionsPerReplica: 10, desktop: true, ...deployment },
});
const render = (admin) => renderGatewayConfig(admin, { topology: 'private', adminFile: 'config/gateway-admin.azure-private.json' });
const section = (yaml, name) => yaml.slice(yaml.indexOf(`\n${name}:\n`) + 1).split(/\n\n/)[0].trimEnd();

test('T-73 private topology: the header names the admin file the configuration was rendered from', () => {
  const header = (adminFile) => renderGatewayConfig(privateAdmin(), { topology: 'private', adminFile }).split('\n')[1];
  assert.equal(header('ops/customer-admin.json'), '# Generated from ops/customer-admin.json by the admin script new-gateway-config.mjs --topology private (ADR-0004).');
  assert.match(header('config/gateway-admin.azure-private.json'), /^# Generated from config\/gateway-admin\.azure-private\.json by/);
});

test('T-73 private topology: X-Forwarded-For is trusted only from the environment subnet, and the store uses TLS', () => {
  const yaml = render(privateAdmin());
  assert.equal(section(yaml, 'listen').split('\n').find((l) => l.includes('trusted_proxies')).trim(),
    'trusted_proxies: [100.100.0.0/17, 100.100.128.0/19, 100.100.160.0/19, 100.100.192.0/19]',
    'the Container Apps ingress connects from the workload profile environment\'s reserved ranges (measured: 100.100.0.168)');
  assert.doesNotMatch(yaml, /10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16|100\.64\.0\.0\/10/, 'a whole private range is trusted');
  assert.match(section(yaml, 'store'), /^ {2}postgres_url: "postgres:\/\/\$\{GATEWAY_PG_USER\}@\$\{GATEWAY_PG_HOST\}:5432\/gateway\?sslmode=require"$/m);
  assert.match(section(yaml, 'store'), /^ {2}password: "\$\{GATEWAY_PG_PASSWORD\}"$/m);
  assert.match(section(yaml, 'store'), /^ {2}max_connections: 10$/m);
  assert.match(section(yaml, 'store'), /^ {2}readiness_grace_seconds: 300$/m);
  assert.doesNotMatch(yaml, /127\.0\.0\.1|TESTER_CIDR/, 'the test topology leaked into the private one');
  assert.match(yaml, /^# .*ADR-0005/m);
});

test('T-73 private topology: the developer networks are the allow list, and the sign-in limits are the admin file\'s', () => {
  const yaml = render(privateAdmin());
  assert.equal(section(yaml, 'access_control'), 'access_control:\n  allow_cidrs: [10.40.0.0/16, 10.200.0.0/14]');
  assert.equal(section(yaml, 'rate_limits'), 'rate_limits:\n  device_authorization: { max: 1000, window_seconds: 600 }\n  device_verify: { max: 100, window_seconds: 600 }');
});

test('T-73 private topology: each policy opts in to Claude Desktop only when the admin file asks for it', () => {
  const on = section(render(privateAdmin()), 'managed');
  assert.equal(on.match(/^ {6}desktop: \{\}$/gm)?.length, 2, on);
  const off = section(render(privateAdmin({ desktop: false })), 'managed');
  assert.doesNotMatch(off, /desktop/);
});

test('T-73 the deployment block is validated: CIDRs, numbers, keys, and Claude Desktop without policies', () => {
  const errorsOf = (deployment, extra = {}) => adminErrors({ ...privateAdmin(deployment), ...extra }, ROLES);
  assert.deepEqual(errorsOf({}), []);
  for (const cidr of ['10.40.0.0/33', 'not-a-cidr', '10.40.0.1/16', '300.1.0.0/16', '10.40.0.0']) {
    assert.ok(errorsOf({ developerCidrs: [cidr] }).some((e) => e.includes('developerCidrs') && e.includes(cidr)), `${cidr} was accepted`);
  }
  assert.ok(errorsOf({ developerCidrs: [] }).some((e) => e.includes('developerCidrs')), 'an empty allow list was accepted');
  for (const [key, value] of [['signInsPerAddress', 0], ['codeSubmissionsPerAddress', 100001], ['storeConnectionsPerReplica', 1.5], ['signInsPerAddress', '1000']]) {
    assert.ok(errorsOf({ [key]: value }).some((e) => e.includes(key)), `${key} ${value} was accepted`);
  }
  assert.ok(errorsOf({ desktop: 'yes' }).some((e) => e.includes('desktop')));
  assert.ok(errorsOf({ colour: 'blue' }).some((e) => e.includes('colour')));
  assert.ok(errorsOf({}, { policies: undefined }).some((e) => e.includes('desktop') && e.includes('policies')), 'Claude Desktop without policies was accepted');
});

test('T-73 --topology private needs the deployment block, an unknown topology is refused, and the checked-in private config is current', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const admin = privateAdmin();
  delete admin.deployment;
  fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify(admin));
  const missing = spawnSync(process.execPath, [script, '--topology', 'private', '--admin', path.join(dir, 'admin.json'), '--out', path.join(dir, 'g.yaml')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /deployment/);
  assert.equal(fs.existsSync(path.join(dir, 'g.yaml')), false);
  const unknown = spawnSync(process.execPath, [script, '--topology', 'cloud', '--out', path.join(dir, 'g.yaml')], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--topology/);
  const check = spawnSync(process.execPath, [script, '--topology', 'private', '--admin', path.join(root, 'config', 'gateway-admin.azure-private.json'),
    '--out', path.join(root, 'config', 'gateway.azure-private.yaml'), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(render(JSON.parse(read('config/gateway-admin.azure-private.json'))), read('config/gateway.azure-private.yaml'));
});
