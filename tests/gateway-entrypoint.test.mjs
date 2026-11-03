import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfSignedCertificate } from '../infra/azure-test/lib/x509.mjs';

// T-151 (P-45): the gateway image's entrypoint, run with bash and a stand-in for the claude binary.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repo, 'infra', 'azure-test', 'image', 'gateway-entrypoint.sh');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' ? (fs.existsSync(gitBash) ? gitBash : null) : 'bash';
const skip = !bash && 'no bash (Git for Windows) to run the entrypoint with';
const posix = (p) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/') : p);

const CONFIG = [
  'listen:', '  port: 8080', 'oidc:', '  issuer: "${OIDC_ISSUER}"', '  client_id: "${OIDC_CLIENT_ID}"', '  client_secret: "${OIDC_CLIENT_SECRET}"',
  '  groups_claim: roles', 'store:', '  max_connections: 10', '',
].join('\n');

function run(t, env, config = CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gateway.yaml'), config);
  // The stand-in prints its arguments, then the configuration and the key files the gateway would read.
  fs.writeFileSync(path.join(dir, 'claude'), '#!/usr/bin/env bash\necho "ARGS $*"\ncfg="${@: -1}"\necho "CONFIG-BEGIN"; cat "$cfg"; echo "CONFIG-END"\n'
    + 'for f in "$GATEWAY_IDP_DIR"/key.pem "$GATEWAY_IDP_DIR"/cert.pem; do [ -f "$f" ] && echo "FILE $(basename "$f") $(head -n1 "$f") $(stat -c %a "$f" 2>/dev/null || echo na)"; done\nexit 0\n');
  const r = spawnSync(bash, [posix(entrypoint)], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CLAUDE_BIN: posix(path.join(dir, 'claude')), GATEWAY_CONFIG: posix(path.join(dir, 'gateway.yaml')), GATEWAY_IDP_DIR: posix(path.join(dir, 'idp')), ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir };
}

test('T-151 entrypoint: with GATEWAY_IDP_PEM it writes the key and the first certificate and swaps client_secret for private_key_jwt', { skip }, (t) => {
  const { keyPem, certPem } = selfSignedCertificate({ commonName: 'claude-gateway', months: 12 });
  const r = run(t, { GATEWAY_IDP_PEM: `${keyPem}${certPem}${certPem}`, GATEWAY_PG_HOST: 'psql-x.postgres.database.azure.com' });
  assert.equal(r.status, 0, r.out);
  const config = /CONFIG-BEGIN\n([\s\S]*)CONFIG-END/.exec(r.out)[1];
  assert.doesNotMatch(config, /client_secret/);
  assert.match(config, /\n  client_id: "\$\{OIDC_CLIENT_ID\}"\n  token_endpoint_auth_method: private_key_jwt\n  client_assertion:\n    private_key_pem: \$\{file:[^}]+\/key\.pem\}\n    certificate_pem: \$\{file:[^}]+\/cert\.pem\}\n  groups_claim: roles\n/);
  assert.match(r.out, /FILE key\.pem -----BEGIN PRIVATE KEY----- (600|na)/); // a PEM boundary marker: not-a-secret
  assert.match(r.out, /FILE cert\.pem -----BEGIN CERTIFICATE----- (600|na)/);
  assert.equal((fs.readFileSync(path.join(r.dir, 'idp', 'cert.pem'), 'utf8').match(/BEGIN CERTIFICATE/g) ?? []).length, 1, 'only the first certificate');
  assert.match(r.out, /ARGS gateway --config \S+idp\/gateway\.yaml/);
});

test('T-151 entrypoint: without GATEWAY_IDP_PEM the mounted configuration is used unchanged, and a managed database is not waited for', { skip }, (t) => {
  const r = run(t, { GATEWAY_IDP_PEM: '', GATEWAY_PG_HOST: 'psql-x.postgres.database.azure.com' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ARGS gateway --config \S+\/gateway\.yaml/);
  assert.doesNotMatch(r.out, /idp\/gateway\.yaml/);
  assert.match(r.out, /client_secret: "\$\{OIDC_CLIENT_SECRET\}"/);
});

test('T-151 entrypoint refuses to start on a PEM without a key or a certificate, or a configuration without the client_secret line', { skip }, (t) => {
  const { certPem, keyPem } = selfSignedCertificate({ commonName: 'claude-gateway', months: 1 });
  for (const [pem, message] of [[certPem, /no private key/], [keyPem, /no certificate/]]) {
    const r = run(t, { GATEWAY_IDP_PEM: pem, GATEWAY_PG_HOST: 'db' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, message);
    assert.doesNotMatch(r.out, /ARGS/, 'the gateway was not started');
  }
  const noLine = run(t, { GATEWAY_IDP_PEM: `${keyPem}${certPem}`, GATEWAY_PG_HOST: 'db' }, CONFIG.replace(/ {2}client_secret.*\n/, ''));
  assert.notEqual(noLine.status, 0);
  assert.match(noLine.out, /has no line .*client_secret.* to replace/);
  assert.doesNotMatch(noLine.out, /ARGS/);
});
