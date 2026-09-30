// T-67: the mutation scripts that run in shards on GitHub (P-26) list their mutations with -List, and the shards of
// -Shard k/n name every mutation exactly once between them. -List runs no suite and copies nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
const skip = pwsh.status !== 0 && 'PowerShell 7 (pwsh) is not on PATH';

const list = (script, ...args) => {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'tests', script), '-List', ...args], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', names: (r.stdout ?? '').split(/\r?\n/).filter((l) => /^\d+ /.test(l)) };
};

for (const script of ['mutate-admin.ps1', 'mutate-developer.ps1']) {
  test(`T-67 ${script}: the shards of -Shard k/3 list every mutation of -List exactly once`, { skip }, () => {
    const all = list(script);
    assert.equal(all.status, 0, all.stderr);
    assert.ok(all.names.length > 10, `-List named ${all.names.length} mutations`);
    assert.equal(new Set(all.names).size, all.names.length, 'a mutation is listed twice');
    const shards = [1, 2, 3].map((k) => list(script, '-Shard', `${k}/3`));
    for (const s of shards) assert.equal(s.status, 0, s.stderr);
    const union = shards.flatMap((s) => s.names);
    assert.deepEqual([...union].sort(), [...all.names].sort(), 'the shards together differ from the full list');
    assert.equal(new Set(union).size, union.length, 'two shards list the same mutation');
    const sizes = shards.map((s) => s.names.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `uneven shards: ${sizes.join(', ')}`);
  });

  test(`T-67 ${script}: -Shard refuses a value that is not k/n with k from 1 to n`, { skip }, () => {
    for (const bad of ['0/3', '4/3', '3', 'a/b', '1/0']) {
      const r = list(script, '-Shard', bad);
      assert.notEqual(r.status, 0, `-Shard ${bad} was accepted`);
      assert.match(r.stderr + r.stdout, /-Shard/, `-Shard ${bad}: the message does not name -Shard`);
      assert.equal(r.names.length, 0, `-Shard ${bad} listed mutations`);
    }
  });
}
