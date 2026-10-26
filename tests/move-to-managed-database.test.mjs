// T-115 (ADR-0012): scripts/admin/move-to-managed-database.mjs's pure parts. The database-only deployment is cut from
// infra/azure-test/gateway-test.json, so the server is defined once; the reshape turns a live sidecar app into one that
// uses the managed server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { databaseTemplate, managedAdmin, managedReshape } from '../scripts/admin/move-to-managed-database.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'azure-test', 'gateway-test.json'), 'utf8'));

test('T-115 databaseTemplate holds only the server and database from gateway-test.json, with what they reference', () => {
  const t = databaseTemplate(template);
  assert.deepEqual(t.resources.map((r) => r.type), ['Microsoft.DBforPostgreSQL/flexibleServers', 'Microsoft.DBforPostgreSQL/flexibleServers/databases']);
  assert.deepEqual(t.resources, template.resources.filter((r) => r.type.startsWith('Microsoft.DBforPostgreSQL/')), 'the same definitions, not copies that can drift');
  assert.deepEqual(Object.keys(t.parameters).sort(), ['database', 'databaseLocation', 'location', 'postgresPassword', 'runId']);
  assert.deepEqual(Object.keys(t.variables).sort(), ['pgServerName', 'suffix', 'tags']);
  assert.equal(t.outputs.pgServerName.value, template.outputs.pgServerName.value);
  const text = JSON.stringify(t);
  for (const [, name] of text.matchAll(/parameters\('([A-Za-z]+)'\)/g)) assert.ok(name in t.parameters, `parameter ${name} is declared`);
  for (const [, name] of text.matchAll(/variables\('([A-Za-z]+)'\)/g)) assert.ok(name in t.variables, `variable ${name} is declared`);
});

const liveTemplate = () => ({
  containers: [
    { name: 'gateway', env: [{ name: 'GATEWAY_PG_PASSWORD', secretRef: 'pg-password' }], volumeMounts: [{ volumeName: 'gateway-config', mountPath: '/etc/claude' }] },
    { name: 'postgres', env: [], volumeMounts: [{ volumeName: 'pgdata', mountPath: '/var/lib/postgresql/data' }] },
  ],
  volumes: [{ name: 'gateway-config', storageType: 'Secret' }, { name: 'pgdata', storageType: 'EmptyDir' }],
});

test('T-115 managedReshape drops the sidecar and its volume, points the gateway at the server and makes the password acceptable', () => {
  const t = liveTemplate();
  const secrets = { 'pg-password': 'abc123' };
  managedReshape({ host: 'psql-claude-gw-x.postgres.database.azure.com' })({ template: t, secret: (n) => secrets[n], setSecret: (n, v) => { secrets[n] = v; } });
  assert.deepEqual(t.containers.map((c) => c.name), ['gateway']);
  assert.deepEqual(t.volumes.map((v) => v.name), ['gateway-config']);
  assert.deepEqual(t.containers[0].env.find((e) => e.name === 'GATEWAY_PG_HOST'), { name: 'GATEWAY_PG_HOST', value: 'psql-claude-gw-x.postgres.database.azure.com' });
  assert.equal(secrets['pg-password'], 'abc123A');
  assert.deepEqual(t.containers[0].command, ['/usr/local/bin/claude'], 'the entrypoint would wait for the removed sidecar');
  assert.deepEqual(t.containers[0].args, ['gateway', '--config', '/etc/claude/gateway.yaml']);
});

test('T-115 managedReshape run twice gives the same app, so a retried move is safe', () => {
  const t = liveTemplate();
  const secrets = { 'pg-password': 'abc123' };
  const io = { template: t, secret: (n) => secrets[n], setSecret: (n, v) => { secrets[n] = v; } };
  const reshape = managedReshape({ host: 'psql-h.postgres.database.azure.com' });
  reshape(io);
  const once = structuredClone(t);
  reshape(io);
  assert.deepEqual(t, once);
  assert.equal(secrets['pg-password'], 'abc123A');
  assert.equal(t.containers[0].env.filter((e) => e.name === 'GATEWAY_PG_HOST').length, 1);
});

test('T-115 managedReshape refuses a host that is not a Flexible Server name', () => {
  assert.throws(() => managedReshape({ host: 'evil.example.com' }), /postgres\.database\.azure\.com/);
});

test('T-115 managedAdmin moves only a live admin file, so another deployment\'s file is never written to this gateway', () => {
  const admin = { roles: ['A'], models: [], deployment: { adminApi: true } };
  assert.deepEqual(managedAdmin({ source: 'live', admin }).deployment, { adminApi: true, database: 'managed' });
  assert.equal(admin.deployment.database, undefined, 'the input is not changed');
  assert.throws(() => managedAdmin({ source: 'deploy', admin }), /no gateway-admin-file/);
});
