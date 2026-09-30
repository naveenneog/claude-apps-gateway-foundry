#!/usr/bin/env node
// Verifies the public repository after a publication (ADR-0006, T-76), as a reader without credentials sees it.
//   node scripts/publish/verify-public.mjs --public-url <url> --deny-file <file> [--source-dir <dir>] [--source <rev>]
// The URL is HTTPS without credentials, or a local path; an HTTP URL must answer an anonymous smart-HTTP request.
// The mirror is cloned with no git configuration or git, credential or SSH environment variable of this process, so
// nothing can authenticate it. Then: the mirror is not shallow and no ref reaches a commit of the working repository;
// main holds the tree of --source, and only then are its files exported and checked with the deny file; and every
// commit on main is a publication, naming a source revision whose tree it holds, by GitHub no-reply identities.
// Exit 0: verified; 1: a check failed; 2: usage error, or the repository cannot be read anonymously.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportRevision, git } from './git-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, 'check-public.mjs');
const NO_REPLY = /@users\.noreply\.github\.com$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// 'http' for a URL an anonymous reader can fetch, 'local' for a path; anything that could authenticate is refused.
function urlKind(url) {
  if (/^[\w.+-]+@[^/:]+:/.test(url) || /^(?:ssh|git):/i.test(url)) throw new Error(`${url} uses SSH or git://, which can authenticate; anonymous verification uses the HTTPS URL`);
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error(`${url} carries credentials; anonymous verification uses the URL without them`);
    if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) throw new Error(`${url} is plain HTTP; anonymous verification uses HTTPS`);
    return 'http';
  }
  if (/^file:\/\//i.test(url) || path.isAbsolute(url)) return 'local';
  throw new Error(`${url} is neither an HTTPS URL nor a local path, so anonymous verification cannot use it`);
}

// The request git makes first, sent by Node with no credentials: anything but 200 means readers without credentials
// are refused.
async function probe(url) {
  const target = `${url.replace(/\/+$/, '')}/info/refs?service=git-upload-pack`;
  let response;
  try {
    response = await fetch(target, { headers: { 'User-Agent': 'git/2 verify-public' } });
  } catch (err) {
    throw new Error(`${url} could not be reached: ${err.message}`);
  }
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`${url} answers an anonymous request with HTTP ${response.status}; readers without credentials cannot clone it`);
}

// The environment of the anonymous clone: no GIT_*, GCM_* or SSH_* variable, an empty global configuration, no system
// configuration, and prompts off.
function anonymousEnvironment(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GCM_|SSH_)/i.test(key)));
  const config = path.join(home, 'gitconfig');
  fs.writeFileSync(config, '');
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

function mirror(url, dir, home) {
  const args = ['-c', 'credential.helper=', '-c', 'http.extraHeader=', 'clone', '--mirror', '--quiet', url, dir];
  const r = spawnSync('git', args, { env: anonymousEnvironment(home), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${url} could not be cloned without credentials: ${String(r.stderr).trim()}`);
}

// Checks every commit on main: a publication whose message names a source revision, whose tree that revision has,
// made by GitHub no-reply identities.
function mainHistoryFailures(repo, sourceDir) {
  const bare = { bare: true };
  const failures = [];
  for (const line of git(repo, ['log', '--format=%H%x00%T%x00%ae%x00%ce%x00%B%x01', 'refs/heads/main'], bare).split('\x01')) {
    const [commit, tree, author, committer, message] = line.replace(/^\n/, '').split('\0');
    if (!commit) continue;
    const named = /Source revision ([0-9a-f]{40}), tree ([0-9a-f]{40})/.exec(message ?? '');
    let sourceTree = null;
    if (named) {
      try {
        sourceTree = git(sourceDir, ['rev-parse', '--verify', '-q', `${named[1]}^{tree}`]);
      } catch {
        sourceTree = null;
      }
    }
    if (!named || named[2] !== tree || sourceTree !== tree) {
      failures.push(`${commit} on main is no publication: it names no source revision of the working repository whose tree it holds`);
    }
    if (!NO_REPLY.test(author) || !NO_REPLY.test(committer)) failures.push(`${commit} on main was made by an identity other than a GitHub no-reply address`);
  }
  return failures;
}

async function verify({ publicUrl, sourceDir, source, denyFile }) {
  const kind = urlKind(publicUrl);
  if (kind === 'http') await probe(publicUrl);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-verify-'));
  const failures = [];
  try {
    const repo = path.join(work, 'mirror.git');
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    mirror(publicUrl, repo, home);
    const bare = { bare: true };
    const refs = git(repo, ['for-each-ref', '--format=%(refname)'], bare).split('\n').filter(Boolean);
    console.log(`refs: ${refs.join(', ') || 'none'}`);
    if (git(repo, ['rev-parse', '--is-shallow-repository'], bare) !== 'false') failures.push('the mirror is shallow');
    const sourceCommits = new Set(git(sourceDir, ['rev-list', '--all']).split('\n').filter(Boolean));
    const all = git(repo, ['rev-list', '--all'], bare).split('\n').filter(Boolean);
    const shared = all.filter((c) => sourceCommits.has(c));
    const onMain = refs.includes('refs/heads/main') ? Number(git(repo, ['rev-list', '--count', 'refs/heads/main'], bare)) : 0;
    console.log(`commits: ${onMain} commit${onMain === 1 ? '' : 's'} on main, ${all.length} in every ref, ${shared.length} of the working repository`);
    if (shared.length) {
      const holders = refs.filter((ref) => git(repo, ['rev-list', ref], bare).split('\n').some((c) => sourceCommits.has(c)));
      failures.push(`${shared.length} commit${shared.length === 1 ? '' : 's'} of the working repository, reachable from ${holders.join(', ')}`);
    }
    if (!onMain) return [...failures, 'no main branch'];
    failures.push(...mainHistoryFailures(repo, sourceDir));
    const sha = git(sourceDir, ['rev-parse', '--verify', '--end-of-options', `${source}^{commit}`]);
    const tree = git(sourceDir, ['rev-parse', `${sha}^{tree}`]);
    const mainTree = git(repo, ['rev-parse', 'refs/heads/main^{tree}'], bare);
    if (mainTree !== tree) return [...failures, `main holds tree ${mainTree}, not ${tree}, the tree of ${sha}; its files were not exported`];
    console.log(`tree: main holds the tree of ${sha}`);
    const files = path.join(work, 'main');
    exportRevision(repo, 'refs/heads/main', files, bare);
    const check = spawnSync(process.execPath, [CHECKER, '--root', files, '--deny-file', denyFile], { encoding: 'utf8' });
    const out = `${check.stdout}${check.stderr}`.trim();
    console.log(`checker:\n${out}`);
    if (check.status === 2) throw new Error(`the checker could not run: ${out}`);
    if (check.status !== 0) failures.push('the checker found values in main');
    return failures;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { 'public-url': { type: 'string' }, 'deny-file': { type: 'string' }, 'source-dir': { type: 'string' }, source: { type: 'string' } },
  });
  for (const required of ['public-url', 'deny-file']) if (!values[required]) throw new Error(`--${required} is required`);
  if (!fs.existsSync(values['deny-file'])) throw new Error(`the deny file ${values['deny-file']} does not exist`);
  return {
    publicUrl: values['public-url'],
    denyFile: path.resolve(values['deny-file']),
    sourceDir: path.resolve(values['source-dir'] ?? path.join(HERE, '..', '..')),
    source: values.source ?? 'HEAD',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failures = await verify(parse(process.argv.slice(2)));
    for (const f of failures) console.log(`failed: ${f}`);
    console.log(failures.length ? `${failures.length} check${failures.length === 1 ? '' : 's'} failed` : 'verified');
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error(`verify-public: ${err.message}`);
    process.exitCode = 2;
  }
}
