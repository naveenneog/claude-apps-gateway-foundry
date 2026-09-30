// Git plumbing shared by the publication scripts (ADR-0006): run git, and write the files of a commit from the object
// store into a folder, with the bytes git holds.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 1024 * 1024 * 1024;

export class GitError extends Error {}

// Runs git in `dir`: a work tree through -C, or a bare repository through --git-dir, since this environment's
// safe.bareRepository=explicit makes `git -C <bare>` fail. Returns trimmed text, or a Buffer with `binary`.
export function git(dir, args, { input, binary = false, bare = false, env } = {}) {
  const location = bare ? ['--git-dir', dir] : ['-C', dir];
  const r = spawnSync('git', [...location, ...args], { input, env, maxBuffer: MAX_OUTPUT, ...(binary ? {} : { encoding: 'utf8' }) });
  if (r.error) throw new GitError(`git could not run: ${r.error.message}`);
  if (r.status !== 0) throw new GitError(`git ${args.join(' ')} failed in ${dir}: ${String(r.stderr).trim()}`);
  return binary ? r.stdout : r.stdout.trim();
}

// A path component that could leave the folder, reach .git (its NTFS short name GIT~1 included), or that Windows
// cannot hold as written: a separator, a drive or stream colon, a control character, or a trailing dot or space.
const UNSAFE_COMPONENT = /^(?:\.\.?|\.git|git~\d+)$|[\\:\x00-\x1f]|[. ]$/i;

// The file each tree entry writes, checked for every entry before anything is written: every component is safe, the
// file stays inside `dir`, and no two entries name the same file on a case-insensitive file system.
function exportTargets(dir, entries) {
  const root = path.resolve(dir);
  const seen = new Map();
  return entries.map((e) => {
    const parts = e.file.split('/');
    const bad = parts.find((p) => p === '' || UNSAFE_COMPONENT.test(p));
    const target = path.resolve(root, ...parts);
    if (bad !== undefined || !target.startsWith(root + path.sep)) throw new GitError(`${JSON.stringify(e.file)} is no safe path to publish`);
    const key = target.toLowerCase();
    if (seen.has(key)) throw new GitError(`${JSON.stringify(e.file)} and ${JSON.stringify(seen.get(key))} name the same file`);
    seen.set(key, e.file);
    return target;
  });
}

// Writes the files of commit `sha` into `dir`, executable bits included where the file system holds them, and returns
// each file with its mode. Symbolic links, submodules and unsafe paths are refused before any file is written, so every
// entry of the tree is a file the checker reads.
export function exportRevision(repo, sha, dir, { bare = false } = {}) {
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', sha], { bare }).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, object] = line.slice(0, tab).split(' ');
    return { mode, type, object, file: line.slice(tab + 1) };
  });
  const other = entries.find((e) => e.type !== 'blob' || e.mode === '120000');
  if (other) throw new GitError(`${other.file} is a ${other.type === 'blob' ? 'symbolic link' : other.type}; only files are published`);
  const targets = exportTargets(dir, entries);
  const batch = git(repo, ['cat-file', '--batch'], { input: `${entries.map((e) => e.object).join('\n')}\n`, binary: true, bare });
  let at = 0;
  entries.forEach((e, i) => {
    const headerEnd = batch.indexOf(0x0a, at);
    const [object, type, size] = batch.toString('utf8', at, headerEnd).split(' ');
    if (object !== e.object || type !== 'blob') throw new GitError(`git returned ${object} ${type} for ${e.file}`);
    const start = headerEnd + 1;
    fs.mkdirSync(path.dirname(targets[i]), { recursive: true });
    fs.writeFileSync(targets[i], batch.subarray(start, start + Number(size)));
    if (e.mode === '100755') fs.chmodSync(targets[i], 0o755);
    at = start + Number(size) + 1;
  });
  return entries.map((e) => ({ file: e.file, mode: e.mode }));
}
