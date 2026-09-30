#!/usr/bin/env node
// Publishes a committed revision of the working repository as one commit of the public repository (ADR-0006, T-77).
// It fails closed: nothing is committed or pushed unless every check before it passed.
//   node scripts/publish/publish-public.mjs --public-dir <clone of the public repository> --public-url <its URL>
//     --deny-file <file outside the repository> [--source-dir <working repository>] [--source <revision>]
//     [--trailer "Key: value"]... [--push]
// 1. The clone: origin fetches from and pushes to --public-url only; nothing is uncommitted; the effective author and
//    committer are GitHub no-reply addresses; no ref holds a commit of the working repository; and its main is
//    origin's main, or a publication of this revision prepared on top of it.
// 2. The revision's files come from git's object store, and check-public.mjs checks them with the deny file.
// 3. The clone's files are replaced; the staged tree has to equal the revision's tree.
// 4. The commit is written from that tree with origin's main as its only parent, and its tree, parent, identities and
//    message are checked before main moves. With --push, the checker checks that exact commit again with the current
//    deny file, and then exactly that commit goes to origin's main: git refuses anything but a fast-forward, and no
//    tag goes with it. No hook of the clone runs.
// A prepared publication, or one whose push failed, is pushed by running again with --push.
// Exit 0: published, prepared, or nothing to publish; 1: refused or failed; 2: usage error.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportRevision, git, GitError } from './git-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, 'check-public.mjs');
const NO_REPLY = /@users\.noreply\.github\.com$/i;

class Refusal extends Error {}
class UsageError extends Error {}

const comparableUrl = (url) => url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();

// The value of a ref, or null when it does not exist.
function refValue(g, ref) {
  try {
    return g(['rev-parse', '--verify', '-q', ref]);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

function identity(g, variable, role) {
  const m = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(g(['var', variable]));
  if (!m || !NO_REPLY.test(m[2])) {
    throw new Refusal(`the ${role} git would record in the public clone is not a GitHub no-reply address; set user.email to it, with no GIT_${role.toUpperCase()}_EMAIL or ${role}.email overriding it`);
  }
  return { name: m[1], email: m[2] };
}

function checkPublicClone(g, options) {
  if (!fs.existsSync(path.join(options.publicDir, '.git'))) throw new Refusal(`${options.publicDir} is not a git clone`);
  const fetchUrl = g(['remote', 'get-url', 'origin']);
  if (comparableUrl(fetchUrl) !== comparableUrl(options.publicUrl)) throw new Refusal(`origin of ${options.publicDir} fetches from ${fetchUrl}, not ${options.publicUrl}`);
  const pushUrls = g(['remote', 'get-url', '--push', '--all', 'origin']).split('\n').filter(Boolean);
  if (pushUrls.length !== 1 || comparableUrl(pushUrls[0]) !== comparableUrl(options.publicUrl)) {
    throw new Refusal(`origin of ${options.publicDir} pushes to ${pushUrls.join(', ')}, not only to ${options.publicUrl}`);
  }
  if (g(['status', '--porcelain', '--untracked-files=all'])) throw new Refusal(`${options.publicDir} has uncommitted changes`);
  const author = identity(g, 'GIT_AUTHOR_IDENT', 'author');
  const committer = identity(g, 'GIT_COMMITTER_IDENT', 'committer');
  const sourceCommits = new Set(git(options.sourceDir, ['rev-list', '--all']).split('\n').filter(Boolean));
  const held = g(['rev-list', '--all']).split('\n').find((c) => sourceCommits.has(c));
  if (held) throw new Refusal(`${options.publicDir} holds ${held}, a commit of the source repository`);
  const head = g(['symbolic-ref', '-q', 'HEAD']);
  if (head !== 'refs/heads/main') {
    if (refValue(g, head) !== null) throw new Refusal(`the clone's HEAD is on ${head}, not refs/heads/main`);
    g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  return { author, committer };
}

// Origin's main, fetched into refs/remotes/origin/main, or null when origin has no main yet.
function originMain(g) {
  const advertised = g(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0] || null;
  if (!advertised) return null;
  g(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (refValue(g, 'refs/remotes/origin/main') !== advertised) throw new Refusal("origin's main moved while it was fetched; run again");
  return advertised;
}

function commitFacts(g, commit) {
  const text = g(['cat-file', '-p', commit]);
  const split = text.indexOf('\n\n');
  const header = text.slice(0, split).split('\n');
  const email = (kind) => /<([^>]*)>/.exec(header.find((l) => l.startsWith(`${kind} `)) ?? '')?.[1] ?? '';
  return {
    tree: header.find((l) => l.startsWith('tree '))?.slice(5),
    parents: header.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)),
    author: email('author'),
    committer: email('committer'),
    message: text.slice(split + 2),
  };
}

// True when `commit` publishes revision `sha` with tree `tree` on top of `parent` (null for the first publication).
function isPublication(g, commit, parent, tree, sha) {
  const facts = commitFacts(g, commit);
  return facts.tree === tree && facts.parents.join(' ') === (parent ?? '')
    && NO_REPLY.test(facts.author) && NO_REPLY.test(facts.committer)
    && facts.message.includes(`Source revision ${sha}, tree ${tree}`);
}

function runChecker(dir, denyFile) {
  const r = spawnSync(process.execPath, [CHECKER, '--root', dir, '--deny-file', denyFile], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`.trim();
  if (r.status === 2) throw new UsageError(out);
  if (r.status !== 0) throw new Refusal(`the checker refused the revision:\n${out}`);
  return out.split('\n').pop();
}

// Replaces the clone's files with the revision's, checks them, stages them, and writes the publication commit.
function prepare(g, options, { sha, tree, parent, author, committer }) {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-publish-'));
  let files;
  try {
    files = exportRevision(options.sourceDir, sha, exportDir);
    console.log(`checked: ${runChecker(exportDir, options.denyFile)}`);
    for (const entry of fs.readdirSync(options.publicDir)) {
      if (entry !== '.git') fs.rmSync(path.join(options.publicDir, entry), { recursive: true, force: true });
    }
    fs.cpSync(exportDir, options.publicDir, { recursive: true });
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
  g(['add', '-A']);
  // The index takes each file's mode from the revision, both ways, whatever core.fileMode lets git see on disk.
  const indexModes = new Map(g(['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return [line.slice(tab + 1), line.slice(0, 6)];
  }));
  for (const { file, mode } of files) {
    if (indexModes.get(file) !== mode) g(['update-index', `--chmod=${mode === '100755' ? '+x' : '-x'}`, '--', file]);
  }
  const staged = g(['write-tree']);
  if (staged !== tree) {
    throw new Refusal(`the staged tree ${staged} differs from the source tree ${tree}; nothing was committed, and ${options.publicDir} holds the staged copy for inspection`);
  }
  const message = [`Publish ${sha.slice(0, 12)} of the working repository`, '', `Source revision ${sha}, tree ${tree} (ADR-0006).`];
  if (options.trailers.length) message.push('', ...options.trailers);
  const env = { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email };
  const commit = g(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: `${message.join('\n')}\n`, env });
  if (!isPublication(g, commit, parent, tree, sha)) throw new Refusal(`the new commit ${commit} does not hold what was checked`);
  g(['update-ref', '-m', `publish ${sha}`, 'refs/heads/main', commit, parent ?? '']);
  return commit;
}

// Checks the exact tree of `commit`, read back from the clone, with the current deny file.
function checkCommit(options, commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-publish-commit-'));
  try {
    exportRevision(options.publicDir, commit, dir);
    return runChecker(dir, options.denyFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every push, a prepared publication's included, first checks the exact commit it sends with the current deny file.
function push(g, options, commit) {
  console.log(`checked ${commit}: ${checkCommit(options, commit)}`);
  try {
    g(['-c', 'push.followTags=false', 'push', '--quiet', '--no-verify', 'origin', `${commit}:refs/heads/main`]);
  } catch (err) {
    throw new Refusal(`committed ${commit} in the clone; the push failed: ${err.message}. Run again with --push to push it`);
  }
  if (g(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0] !== commit) throw new Refusal(`origin's main is not ${commit} after the push`);
  g(['update-ref', 'refs/remotes/origin/main', commit]);
  console.log(`pushed ${commit} to ${options.publicUrl} main`);
}

function publish(options) {
  const sha = git(options.sourceDir, ['rev-parse', '--verify', '--end-of-options', `${options.source}^{commit}`]);
  const tree = git(options.sourceDir, ['rev-parse', `${sha}^{tree}`]);
  console.log(`source ${sha}, tree ${tree}`);
  const noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-no-hooks-'));
  const g = (args, extra) => git(options.publicDir, ['-c', `core.hooksPath=${noHooks}`, ...args], extra);
  try {
    const { author, committer } = checkPublicClone(g, options);
    const remote = originMain(g);
    const local = refValue(g, 'refs/heads/main');
    if (remote && g(['rev-parse', `${remote}^{tree}`]) === tree) {
      console.log(`nothing to publish: origin's main ${remote} holds tree ${tree}`);
      return;
    }
    let commit = local;
    if (local && local !== remote) {
      if (!isPublication(g, local, remote, tree, sha)) {
        throw new Refusal(`the clone's main ${local} is neither origin's main (${remote ?? 'none'}) nor a publication of ${sha.slice(0, 12)} prepared on it; run git reset --hard origin/main in the clone, or clone it again`);
      }
      console.log(`prepared ${local} publishes ${sha}`);
    } else {
      commit = prepare(g, options, { sha, tree, parent: remote, author, committer });
      console.log(`committed ${commit} in ${options.publicDir}`);
    }
    if (options.push) push(g, options, commit);
    else console.log('run again with --push to push it');
  } finally {
    fs.rmSync(noHooks, { recursive: true, force: true });
  }
}

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'source-dir': { type: 'string' }, source: { type: 'string' }, 'public-dir': { type: 'string' },
      'public-url': { type: 'string' }, 'deny-file': { type: 'string' }, trailer: { type: 'string', multiple: true },
      push: { type: 'boolean' },
    },
  });
  for (const required of ['public-dir', 'public-url', 'deny-file']) {
    if (!values[required]) throw new UsageError(`--${required} is required`);
  }
  if (!fs.existsSync(values['deny-file'])) throw new UsageError(`the deny file ${values['deny-file']} does not exist`);
  const trailers = values.trailer ?? [];
  const bad = trailers.find((t) => !/^[A-Za-z][\w-]*: \S/.test(t) || /[\r\n]/.test(t));
  if (bad !== undefined) throw new UsageError(`a trailer is "Key: value" on one line: ${JSON.stringify(bad)}`);
  return {
    sourceDir: path.resolve(values['source-dir'] ?? path.join(HERE, '..', '..')),
    source: values.source ?? 'HEAD',
    publicDir: path.resolve(values['public-dir']),
    publicUrl: values['public-url'],
    denyFile: path.resolve(values['deny-file']),
    trailers,
    push: Boolean(values.push),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publish(parse(process.argv.slice(2)));
  } catch (err) {
    console.error(`publish-public: ${err.message}`);
    process.exitCode = err instanceof Refusal || err instanceof GitError ? 1 : 2;
  }
}
