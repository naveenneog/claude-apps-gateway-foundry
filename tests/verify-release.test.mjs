// Behavioural tests for infra/azure-test/image/verify-release.sh. The image build trusts the release
// only through this script, so each check it makes is broken once here with a throwaway signing key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'infra', 'azure-test', 'image', 'verify-release.sh');
// MSYS tools on Windows (Git Bash, its gpg) read C:\x\y as /c/x/y; a C:/x/y value is taken as relative.
const posix = (p) => (process.platform === 'win32'
  ? p.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/')
  : p);

function findBash() {
  const candidates = process.platform === 'win32'
    ? [process.env.GIT_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash'];
  return candidates.find((p) => p && path.isAbsolute(p) && fs.existsSync(p)) ?? null;
}
const bash = findBash();
const tools = bash && spawnSync(bash, ['-c', 'command -v gpg && command -v gpgconf && command -v sha256sum'], { encoding: 'utf8' }).status === 0;
const skip = tools ? false : 'bash with gpg, gpgconf and sha256sum not found';

const sh = (code, env = {}) => spawnSync(bash, ['-c', code], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
let work;
const signers = {};

function newSigner(name) {
  const home = posix(fs.mkdtempSync(path.join(work, `gpg-${name}-`)));
  const uid = `${name} <${name}@example.invalid>`;
  const gen = sh('gpg --batch --pinentry-mode loopback --passphrase "" --quick-gen-key "$UID_NAME" ed25519 sign 1d', { GNUPGHOME: home, UID_NAME: uid });
  assert.equal(gen.status, 0, gen.stderr);
  const listing = sh('gpg --batch --with-colons --fingerprint "$UID_NAME"', { GNUPGHOME: home, UID_NAME: uid });
  const fingerprint = /^fpr:{9}([0-9A-F]{40}):/m.exec(listing.stdout)?.[1];
  assert.ok(fingerprint, `fingerprint for ${name}`);
  const exported = sh('gpg --batch --armor --export "$UID_NAME"', { GNUPGHOME: home, UID_NAME: uid });
  assert.equal(exported.status, 0, exported.stderr);
  return { home, fingerprint, armored: exported.stdout };
}

function sign(signer, file) {
  const r = sh('gpg --batch --yes --pinentry-mode loopback --passphrase "" --local-user "$FPR" --detach-sign -o "$FILE.sig" "$FILE"',
    { GNUPGHOME: signer.home, FPR: signer.fingerprint, FILE: posix(file) });
  assert.equal(r.status, 0, r.stderr);
}

// A release directory as the Dockerfile lays it out: key.asc, manifest.json, manifest.json.sig, claude.
function release({ signer = signers.good, keys = [signers.good], version = '9.9.9', checksum } = {}) {
  const dir = fs.mkdtempSync(path.join(work, 'rel-'));
  const binary = crypto.randomBytes(4096);
  const sha = crypto.createHash('sha256').update(binary).digest('hex');
  fs.writeFileSync(path.join(dir, 'claude'), binary);
  const manifest = { version, platforms: { 'linux-x64': { binary: 'claude', checksum: checksum ?? sha, size: binary.length } } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  sign(signer, path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'key.asc'), keys.map((k) => k.armored).join('\n'));
  return { dir, sha };
}

function verify(dir, { version = '9.9.9', pinned, fingerprint = signers.good.fingerprint, platform = 'linux-x64' }) {
  return spawnSync(bash, [posix(script), posix(dir), version, platform, pinned, fingerprint], { encoding: 'utf8', timeout: 60_000 });
}

function refuses(result, message) {
  assert.notEqual(result.status, 0, `exit status ${result.status}; stdout: ${result.stdout}`);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stdout, /verified/);
}

before(() => {
  if (skip) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-'));
  signers.good = newSigner('release');
  signers.attacker = newSigner('attacker');
});

after(() => {
  if (!work) return;
  for (const s of Object.values(signers)) sh('gpgconf --kill gpg-agent', { GNUPGHOME: s.home });
  fs.rmSync(work, { recursive: true, force: true });
});

test('an untouched release set verifies', { skip }, () => {
  const { dir, sha } = release();
  const r = verify(dir, { pinned: sha });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified/);
});

test('a binary changed after the manifest was signed is refused', { skip }, () => {
  const { dir, sha } = release();
  fs.appendFileSync(path.join(dir, 'claude'), Buffer.from([0]));
  refuses(verify(dir, { pinned: sha }), /binary checksum/);
});

test('a manifest changed after signing is refused', { skip }, () => {
  const { dir, sha } = release();
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"size"', '"size" ') + ' ');
  refuses(verify(dir, { pinned: sha }), /signature does not verify/);
});

test('a manifest signed by another key, shipped with that key, is refused', { skip }, () => {
  const { dir, sha } = release({ signer: signers.attacker, keys: [signers.attacker] });
  refuses(verify(dir, { pinned: sha }), /does not hold key/);
});

test('a manifest signed by another key is refused even when the expected key is also in key.asc', { skip }, () => {
  const { dir, sha } = release({ signer: signers.attacker, keys: [signers.good, signers.attacker] });
  refuses(verify(dir, { pinned: sha }), /not signed by key/);
});

test('a pinned checksum the signed manifest does not list is refused', { skip }, () => {
  const { dir } = release();
  refuses(verify(dir, { pinned: 'a'.repeat(64) }), /manifest checksum for linux-x64 is not the pinned value/);
});

test('a manifest for another version is refused', { skip }, () => {
  const { dir, sha } = release({ version: '9.9.8' });
  refuses(verify(dir, { pinned: sha }), /manifest version 9\.9\.8 is not 9\.9\.9/);
});

test('a platform the manifest does not list is refused', { skip }, () => {
  const { dir, sha } = release();
  refuses(verify(dir, { pinned: sha, platform: 'linux-arm64' }), /no checksum for linux-arm64/);
});

test('malformed arguments and missing files are refused before any check runs', { skip }, () => {
  const { dir, sha } = release();
  refuses(verify(dir, { pinned: 'not-hex' }), /pinned SHA-256/);
  refuses(verify(dir, { pinned: sha, fingerprint: 'abc' }), /key fingerprint/);
  refuses(verify(dir, { pinned: sha, platform: 'linux x64;' }), /platform/);
  fs.rmSync(path.join(dir, 'manifest.json.sig'));
  refuses(verify(dir, { pinned: sha }), /missing .*manifest\.json\.sig/);
  const usage = spawnSync(bash, [posix(script), posix(dir)], { encoding: 'utf8' });
  refuses(usage, /usage/);
});
