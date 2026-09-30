// T-76's negatives: scripts/publish/verify-public.mjs, which checks the public repository after a publication
// (ADR-0006). A bare repository stands in for GitHub; scripts/publish/publish-public.mjs publishes into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = path.join(ROOT, 'scripts', 'publish', 'publish-public.mjs');
const VERIFY = path.join(ROOT, 'scripts', 'publish', 'verify-public.mjs');
const IDENTITY = ['-c', 'user.name=tester', '-c', 'user.email=1+tester@users.noreply.github.com'];

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...IDENTITY, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function node(script, ...args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// A working repository with two commits, published once into a bare repository through a fresh public clone.
function published(files = { 'README.md': 'first\n', 'docs/a.md': 'a\n' }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-verify-'));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'remote.git');
  const pub = path.join(base, 'public');
  fs.mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(source, 'first.md'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'one');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), body);
  }
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'two');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]).status, 0);
  fs.mkdirSync(pub);
  git(pub, 'init', '-q', '-b', 'main');
  git(pub, 'remote', 'add', 'origin', remote);
  git(pub, 'config', 'user.name', 'tester');
  git(pub, 'config', 'user.email', '1+tester@users.noreply.github.com');
  const deny = path.join(base, 'deny.txt');
  fs.writeFileSync(deny, 'unused-word\n');
  const r = node(PUBLISH, '--source-dir', source, '--public-dir', pub, '--public-url', remote, '--deny-file', deny, '--push');
  assert.equal(r.code, 0, r.out);
  return { base, source, remote, deny, sha: git(source, 'rev-parse', 'HEAD') };
}

const verify = (p, ...extra) => node(VERIFY, '--public-url', p.remote, '--source-dir', p.source, '--deny-file', p.deny, ...extra);

test('a clean publication verifies: no source commit in any ref, main holds the source tree, the checker passes', () => {
  const p = published();
  const r = verify(p);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /refs\/heads\/main/);
  assert.match(r.out, /1 commit on main, 1 in every ref, 0 of the working repository/);
  assert.match(r.out, /main holds the tree of [0-9a-f]{40}/);
  assert.match(r.out, /0 findings/);
});

test('a source commit in any ref fails, a branch or a tag alike, whatever main holds', () => {
  for (const [what, ref] of [['a branch', 'refs/heads/leak'], ['a tag', 'refs/tags/v0']]) {
    const p = published();
    const root = git(p.source, 'rev-list', '--max-parents=0', 'HEAD');
    git(p.source, 'push', '-q', p.remote, `${what === 'a tag' ? root : 'main'}:${ref}`);
    const r = verify(p);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, new RegExp(`${ref.replace(/\//g, '\\/')}`), what);
    assert.match(r.out, /[1-9]\d* of the working repository/, what);
  }
});

test('main holding another tree than the named source revision fails', () => {
  const p = published();
  fs.writeFileSync(path.join(p.source, 'later.md'), 'not published\n');
  git(p.source, 'add', '-A');
  git(p.source, 'commit', '-q', '-m', 'three');
  assert.equal(verify(p).code, 1, 'HEAD moved past the published revision');
  const r = verify(p, '--source', p.sha);
  assert.equal(r.code, 0, r.out);
});

test('a finding of the checker in the published tree fails', () => {
  const p = published({ 'docs/b.md': 'written by ZebraCorn\n' });
  fs.writeFileSync(p.deny, 'zebracorn\n');
  const r = verify(p);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs\/b\.md:1: deny-literal/);
});

test('a repository that cannot be cloned without credentials is an error', () => {
  const p = published();
  const r = node(VERIFY, '--public-url', path.join(p.base, 'missing.git'), '--source-dir', p.source, '--deny-file', p.deny);
  assert.equal(r.code, 2, r.out);
});

test('an SSH URL, or a URL that carries credentials, is refused: verification checks anonymous access', () => {
  const p = published();
  const cases = [
    ['git@example.com:owner/repo.git', /uses SSH/], ['ssh://git@example.com/owner/repo.git', /uses SSH/],
    ['https://someone:secret@example.com/owner/repo.git', /carries credentials/], ['https://token@example.com/owner/repo.git', /carries credentials/],
  ];
  for (const [url, message] of cases) {
    const r = node(VERIFY, '--public-url', url, '--source-dir', p.source, '--deny-file', p.deny);
    assert.equal(r.code, 2, `${url}: ${r.out}`);
    assert.match(r.out, message, url);
  }
});

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function gitAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
    let out = '';
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

// Serves a bare repository over git's dumb HTTP protocol, recording each request's Authorization and Cookie headers;
// with a token, a request that sends it neither as Basic credentials nor as the session cookie gets 401, as a private
// repository answers, except for the paths in `open`.
async function serve(bare, token, open = []) {
  assert.equal(spawnSync('git', ['--git-dir', bare, 'update-server-info']).status, 0);
  const root = path.resolve(bare);
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([req.headers.authorization, req.headers.cookie].filter(Boolean).join(' ') || null);
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/repo\.git\/?/, '');
    const authorised = req.headers.authorization === `Basic ${token}` || (req.headers.cookie ?? '').includes(`session=${token}`);
    if (token && !open.includes(rel) && !authorised) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end();
      return;
    }
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/repo.git`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a repository served without credentials verifies over HTTP', async () => {
  const p = published();
  const site = await serve(p.remote);
  try {
    const r = await runAsync([VERIFY, '--public-url', site.url, '--source-dir', p.source, '--deny-file', p.deny]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verified/);
  } finally {
    await site.close();
  }
});

test('a repository that answers only with credentials is refused, although ambient git configuration holds them', async () => {
  const p = published();
  const token = Buffer.from('tester:secret').toString('base64');
  const site = await serve(p.remote, token);
  const ambient = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${token}` };
  try {
    const control = await gitAsync(['ls-remote', site.url], ambient);
    assert.equal(control.code, 0, `control: the ambient header opens the repository: ${control.out}`);
    const before = site.seen.length;
    const r = await runAsync([VERIFY, '--public-url', site.url, '--source-dir', p.source, '--deny-file', p.deny], ambient);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /anonymous/);
    assert.ok(site.seen.length > before, 'verification reached the server');
    assert.deepEqual(site.seen.slice(before).filter(Boolean), [], 'verification sent no Authorization header');
  } finally {
    await site.close();
  }
});

test('the clone runs without this process\'s git configuration: credentials it holds do not reach the server', async () => {
  const p = published();
  const token = Buffer.from('tester:secret').toString('base64');
  const site = await serve(p.remote, token, ['info/refs']);
  // A session cookie in a cookie file that the process's git configuration names: no -c flag of the clone resets it.
  const cookies = path.join(p.base, 'cookies.txt');
  fs.writeFileSync(cookies, `127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\t${token}\n`);
  const ambient = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.cookieFile', GIT_CONFIG_VALUE_0: cookies };
  try {
    const control = await gitAsync(['clone', '-q', '--mirror', site.url, path.join(p.base, 'control.git')], ambient);
    assert.equal(control.code, 0, `control: the ambient cookie opens the objects: ${control.out}`);
    const before = site.seen.length;
    const r = await runAsync([VERIFY, '--public-url', site.url, '--source-dir', p.source, '--deny-file', p.deny], ambient);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /could not be cloned without credentials/);
    assert.ok(site.seen.length > before + 1, 'the clone reached the server after the probe');
    assert.deepEqual(site.seen.slice(before).filter(Boolean), [], 'no request of verification carried credentials or the cookie');
  } finally {
    await site.close();
  }
});

test('a commit on main that is no publication, or carries another identity, fails', () => {
  const good = '1+tester@users.noreply.github.com';
  const bad = 'someone@corp.example.net';
  const cases = [
    ['no source revision named', { author: good, committer: good }, () => 'a change made on GitHub', /no publication/],
    ['a named source revision with another tree', { author: good, committer: good }, (p, tree) => `Publish\n\nSource revision ${git(p.source, 'rev-list', '--max-parents=0', 'HEAD')}, tree ${tree} (ADR-0006).`, /no publication/],
    ['another author', { author: bad, committer: good }, (p, tree) => `Publish again\n\nSource revision ${p.sha}, tree ${tree} (ADR-0006).`, /no-reply/],
    ['another committer', { author: good, committer: bad }, (p, tree) => `Publish again\n\nSource revision ${p.sha}, tree ${tree} (ADR-0006).`, /no-reply/],
  ];
  for (const [what, identity, message, expected] of cases) {
    const p = published();
    const work = path.join(p.base, 'work');
    assert.equal(spawnSync('git', ['clone', '-q', p.remote, work]).status, 0);
    const tree = git(work, 'rev-parse', 'HEAD^{tree}');
    const commit = spawnSync('git', ['-C', work, 'commit-tree', tree, '-p', 'HEAD', '-F', '-'], {
      input: message(p, tree), encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: identity.author, GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: identity.committer },
    }).stdout.trim();
    git(work, 'push', '-q', 'origin', `${commit}:refs/heads/main`);
    const r = verify(p, '--source', p.sha);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, expected, what);
    assert.match(r.out, /tree: main holds the tree of/, `${what}: the main-tree check passed, so the history check decided`);
  }
});

test('main holding another tree stops before its files are exported or checked', () => {
  const p = published();
  fs.writeFileSync(path.join(p.source, 'later.md'), 'not published\n');
  git(p.source, 'add', '-A');
  git(p.source, 'commit', '-q', '-m', 'three');
  const r = verify(p);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /checker:/);
});
