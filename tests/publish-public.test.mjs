// T-77: scripts/publish/publish-public.mjs, which publishes a committed revision as one commit of the public
// repository (ADR-0006). Temporary repositories stand in for the working repository, the public clone and GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'publish', 'publish-public.mjs');
const IDENTITY = ['-c', 'user.name=tester', '-c', 'user.email=1+tester@users.noreply.github.com'];

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...IDENTITY, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    if (body === null) { fs.rmSync(file); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

// A working repository with two commits and an executable script, an empty bare repository for GitHub, and a fresh
// public clone of it with a GitHub no-reply identity.
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-pub-'));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'remote.git');
  const pub = path.join(base, 'public');
  fs.mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  write(source, { 'README.md': 'first\n', 'docs/a.md': 'a\n' });
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'one');
  write(source, { 'docs/b.md': 'b\n', 'run.sh': '#!/bin/sh\necho hi\n' });
  git(source, 'add', '-A');
  git(source, 'update-index', '--chmod=+x', 'run.sh');
  git(source, 'commit', '-q', '-m', 'two');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  fs.mkdirSync(pub);
  git(pub, 'init', '-q', '-b', 'main');
  git(pub, 'remote', 'add', 'origin', remote);
  git(pub, 'config', 'user.name', 'tester');
  git(pub, 'config', 'user.email', '1+tester@users.noreply.github.com');
  const deny = path.join(base, 'deny.txt');
  fs.writeFileSync(deny, 'zebracorn\n');
  return { base, source, remote, pub, deny };
}

function publish(s, ...extra) {
  return publishWith(s, {}, ...extra);
}

function publishWith(s, env, ...extra) {
  const args = [SCRIPT, '--source-dir', s.source, '--public-dir', s.pub, '--public-url', s.remote, '--deny-file', s.deny, ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const commits = (dir, ref = 'HEAD') => Number(git(dir, 'rev-list', '--count', ref));
// A bare repository is named with --git-dir: with safe.bareRepository=explicit, `git -C <bare>` fails for every command.
const inBare = (remote, ...args) => spawnSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' });

test('the first publication commits the source tree exactly, as one commit without the source history', () => {
  const s = setup();
  const r = publish(s, '--push');
  assert.equal(r.code, 0, r.out);
  assert.equal(commits(s.pub), 1);
  assert.equal(git(s.pub, 'rev-parse', 'HEAD^{tree}'), git(s.source, 'rev-parse', 'HEAD^{tree}'), 'same files, bytes and modes');
  assert.match(git(s.pub, 'log', '-1', '--format=%B'), new RegExp(git(s.source, 'rev-parse', 'HEAD')));
  assert.equal(git(s.pub, 'log', '-1', '--format=%ae %ce'), '1+tester@users.noreply.github.com 1+tester@users.noreply.github.com');
  assert.equal(git(s.pub, 'log', '-1', '--format=%P'), '', 'the first publication has no parent');
  const pushed = inBare(s.remote, 'rev-parse', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.stdout.trim(), git(s.pub, 'rev-parse', 'HEAD'), 'pushed to main');
  assert.equal(inBare(s.remote, 'cat-file', '-e', `${pushed.stdout.trim()}^{commit}`).status, 0, 'control: the lookup finds a present commit');
  for (const commit of git(s.source, 'rev-list', '--all').split('\n')) {
    assert.notEqual(inBare(s.remote, 'cat-file', '-e', `${commit}^{commit}`).status, 0, `source commit ${commit} reached the remote`);
  }
});

test('a later publication removes the files the source deleted and adds one commit', () => {
  const s = setup();
  assert.equal(publish(s, '--push').code, 0);
  write(s.source, { 'docs/a.md': null, 'docs/c.md': 'c\n' });
  git(s.source, 'add', '-A');
  git(s.source, 'commit', '-q', '-m', 'three');
  const r = publish(s, '--push');
  assert.equal(r.code, 0, r.out);
  assert.equal(commits(s.pub), 2);
  assert.equal(git(s.pub, 'log', '-1', '--format=%P'), git(s.pub, 'rev-parse', 'HEAD~1'), 'the parent is the published main');
  assert.equal(git(s.pub, 'rev-parse', 'HEAD^{tree}'), git(s.source, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(fs.existsSync(path.join(s.pub, 'docs', 'a.md')), false);
});

test('executable bits follow the source both ways, on disk where the file system holds them and in the tree', () => {
  const s = setup();
  assert.equal(publish(s, '--push').code, 0);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(s.pub, 'run.sh')).mode & 0o100, 'run.sh is executable on disk');
  assert.equal(git(s.pub, 'status', '--porcelain'), '', 'the clone is clean after a publication with an executable file');
  git(s.source, 'update-index', '--chmod=-x', 'run.sh');
  git(s.source, 'commit', '-q', '-m', 'run.sh no longer executable');
  const r = publish(s, '--push');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.pub, 'rev-parse', 'HEAD^{tree}'), git(s.source, 'rev-parse', 'HEAD^{tree}'));
  assert.match(git(s.pub, 'ls-files', '-s', 'run.sh'), /^100644 /);
});

test('a revision the checker fails is neither copied nor committed', () => {
  const s = setup();
  assert.equal(publish(s, '--push').code, 0);
  write(s.source, { 'docs/b.md': 'written by ZebraCorn\n' });
  git(s.source, 'commit', '-q', '-am', 'planted');
  const before = git(s.pub, 'rev-parse', 'HEAD');
  const r = publish(s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs\/b\.md:1: deny-literal/);
  assert.equal(git(s.pub, 'rev-parse', 'HEAD'), before);
  assert.equal(git(s.pub, 'status', '--porcelain'), '', 'the public work tree is untouched');
});

test('an uncommitted change in the source is not published: the committed revision is', () => {
  const s = setup();
  write(s.source, { 'docs/a.md': 'not committed\n' });
  const r = publish(s);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(s.pub, 'docs', 'a.md'), 'utf8'), 'a\n');
});

test('a public repository holding a source commit, with changes, with another origin or another identity is refused', () => {
  const other = (s) => path.join(s.base, 'elsewhere.git');
  const cases = [
    ['holds source history', (s) => { git(s.pub, 'fetch', '-q', s.source, 'main'); git(s.pub, 'update-ref', 'refs/heads/old', 'FETCH_HEAD'); }, /commit of the source repository/],
    ['uncommitted changes', (s) => write(s.pub, { 'stray.md': 'x\n' }), /uncommitted changes/],
    ['another origin', (s) => git(s.pub, 'remote', 'set-url', 'origin', other(s)), /origin/],
    ['another push URL', (s) => git(s.pub, 'config', 'remote.origin.pushurl', other(s)), /push/],
    ['another configured identity', (s) => git(s.pub, 'config', 'user.email', 'someone@corp.example.net'), /no-reply/],
    ['an unpublished commit on main', (s) => { write(s.pub, { 'local.md': 'x\n' }); git(s.pub, 'add', '-A'); git(s.pub, 'commit', '-q', '-m', 'local'); }, /origin's main/],
  ];
  for (const [what, spoil, message] of cases) {
    const s = setup();
    spoil(s);
    const before = spawnSync('git', ['-C', s.pub, 'rev-parse', '--verify', '-q', 'main'], { encoding: 'utf8' }).stdout.trim();
    const r = publish(s, '--push');
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, message, what);
    assert.equal(spawnSync('git', ['-C', s.pub, 'rev-parse', '--verify', '-q', 'main'], { encoding: 'utf8' }).stdout.trim(), before, `${what}: nothing committed`);
    const remoteMain = inBare(s.remote, 'rev-parse', '--verify', '-q', 'refs/heads/main');
    assert.equal(remoteMain.stderr, '', `${what}: the remote lookup ran`);
    assert.notEqual(remoteMain.status, 0, `${what}: nothing pushed`);
  }
});

test('an effective commit identity other than a no-reply address, set in the environment, is refused', () => {
  for (const variable of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
    const s = setup();
    const r = publishWith(s, { [variable]: 'someone@corp.example.net' }, '--push');
    assert.equal(r.code, 1, `${variable}: ${r.out}`);
    assert.match(r.out, /no-reply/, variable);
    assert.notEqual(spawnSync('git', ['-C', s.pub, 'rev-parse', '--verify', '-q', 'main']).status, 0, `${variable}: nothing committed`);
    assert.notEqual(inBare(s.remote, 'rev-parse', '--verify', '-q', 'refs/heads/main').status, 0, `${variable}: nothing pushed`);
  }
});

test('a prepared publication, and one whose push failed, is pushed by running again with --push', () => {
  const s = setup();
  const prepared = publish(s);
  assert.equal(prepared.code, 0, prepared.out);
  assert.notEqual(inBare(s.remote, 'rev-parse', '--verify', '-q', 'refs/heads/main').status, 0, 'prepared, not pushed');
  const pushed = publish(s, '--push');
  assert.equal(pushed.code, 0, pushed.out);
  assert.equal(inBare(s.remote, 'rev-parse', 'refs/heads/main').stdout.trim(), git(s.pub, 'rev-parse', 'HEAD'));
  assert.equal(commits(s.pub), 1, 'no second commit');

  const t = setup();
  const hook = path.join(t.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho refused by the test >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const failed = publish(t, '--push');
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /committed [0-9a-f]{40} in the clone; the push failed/);
  const local = git(t.pub, 'rev-parse', 'HEAD');
  fs.rmSync(hook);
  const retried = publish(t, '--push');
  assert.equal(retried.code, 0, retried.out);
  assert.equal(inBare(t.remote, 'rev-parse', 'refs/heads/main').stdout.trim(), local, 'the same commit');
  assert.equal(commits(t.pub), 1);
});

test('every push checks the exact commit with the current deny file, a prepared one included', () => {
  const s = setup();
  fs.writeFileSync(s.deny, 'unused-word\n');
  write(s.source, { 'docs/b.md': 'written by ZebraCorn\n' });
  git(s.source, 'commit', '-q', '-am', 'a word the deny file does not hold yet');
  const prepared = publish(s);
  assert.equal(prepared.code, 0, prepared.out);
  const commit = git(s.pub, 'rev-parse', 'HEAD');
  fs.writeFileSync(s.deny, 'zebracorn\n');
  const refused = publish(s, '--push');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /docs\/b\.md:1: deny-literal/);
  assert.notEqual(inBare(s.remote, 'rev-parse', '--verify', '-q', 'refs/heads/main').status, 0, 'nothing pushed');
  fs.writeFileSync(s.deny, 'unused-word\n');
  const pushed = publish(s, '--push');
  assert.equal(pushed.code, 0, pushed.out);
  assert.equal(inBare(s.remote, 'rev-parse', 'refs/heads/main').stdout.trim(), commit, 'the prepared commit, once');
  assert.equal(commits(s.pub), 1);
});

test('hooks of the public clone do not run: a pre-push hook cannot stop the push nor a ref hook change files', () => {
  const s = setup();
  const hooks = path.join(s.pub, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(hooks, 'reference-transaction'), '#!/bin/sh\necho hooked > hooked.txt\n');
  for (const name of ['pre-push', 'reference-transaction']) fs.chmodSync(path.join(hooks, name), 0o755);
  const r = publish(s, '--push');
  assert.equal(r.code, 0, r.out);
  assert.equal(inBare(s.remote, 'rev-parse', 'refs/heads/main').stdout.trim(), git(s.pub, 'rev-parse', 'HEAD'));
  assert.equal(fs.existsSync(path.join(s.pub, 'hooked.txt')), false);
});

test('a source tree entry that could write outside the export folder, or into .git, is refused before anything is written', () => {
  const marker = `cgw-outside-${process.pid}-${Date.now()}.txt`;
  const cases = [
    [[`..\\${marker}`], /no safe path/], [['.git'], /no safe path/], [['GIT~1'], /no safe path/], [['a:b'], /no safe path/],
    [['tab\there.md'], /no safe path/], [['A.md', 'a.md'], /name the same file/],
  ];
  for (const [names, message] of cases) {
    const s = setup();
    const blob = spawnSync('git', ['-C', s.source, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf8' }).stdout.trim();
    const input = names.map((n) => `100644 blob ${blob}\t${n}\0`).join('');
    const tree = spawnSync('git', ['-C', s.source, 'mktree', '-z'], { input, encoding: 'utf8' }).stdout.trim();
    assert.match(tree, /^[0-9a-f]{40}$/, `${names}: git builds the tree`);
    git(s.source, 'update-ref', 'refs/heads/main', git(s.source, 'commit-tree', tree, '-p', 'HEAD', '-m', 'crafted'));
    const r = publish(s, '--push');
    assert.equal(r.code, 1, `${names}: ${r.out}`);
    assert.match(r.out, message, String(names));
    assert.equal(fs.existsSync(path.join(os.tmpdir(), marker)), false, `${names}: nothing written outside`);
    assert.equal(git(s.pub, 'status', '--porcelain'), '', `${names}: the clone is untouched`);
  }
});

test('a revision whose tree the public repository already holds publishes nothing', () => {
  const s = setup();
  assert.equal(publish(s, '--push').code, 0);
  const r = publish(s);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing to publish/i);
  assert.equal(commits(s.pub), 1);
});

test('a missing deny file is a usage error: publication always checks the deny list', () => {
  const s = setup();
  const r = spawnSync(process.execPath, [SCRIPT, '--source-dir', s.source, '--public-dir', s.pub, '--public-url', s.remote], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});
