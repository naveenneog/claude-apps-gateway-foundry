// T-67: .github/workflows/mutation.yml runs every tests/mutate-*.ps1 on a Windows runner, the sharded scripts in shards
// 1/n to n/n, with the pinned Claude Code, read-only permissions, a time limit under the hosted runners' 6 hours
// (https://docs.github.com/en/actions/reference/limits) and each log kept as an artifact (P-26).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n');
const workflow = () => read('.github/workflows/mutation.yml');
const CLAUDE_PIN = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/;

// The matrix entries: one "- { suite: ..., script: ..., shard: '...' }" line each.
function matrixEntries(text) {
  return [...text.matchAll(/^\s*- \{ suite: ([\w-]+), script: (tests\/mutate-[\w-]+\.ps1), shard: '([^']*)' \}\s*$/gm)]
    .map((m) => ({ suite: m[1], script: m[2], shard: m[3] }));
}

test('T-67 the mutation workflow runs every tests/mutate-*.ps1 script', () => {
  const scripts = fs.readdirSync(path.join(repo, 'tests')).filter((f) => /^mutate-.+\.ps1$/.test(f)).map((f) => `tests/${f}`).sort();
  const entries = matrixEntries(workflow());
  assert.deepEqual([...new Set(entries.map((e) => e.script))].sort(), scripts);
});

test('T-67 a sharded script runs as shards 1/n to n/n, each once, and an unsharded one runs once', () => {
  const entries = matrixEntries(workflow());
  const byScript = Object.groupBy(entries, (e) => e.script);
  for (const [script, rows] of Object.entries(byScript)) {
    if (rows.length === 1 && rows[0].shard === '') continue;
    const n = rows.length;
    assert.deepEqual(rows.map((r) => r.shard).sort(), Array.from({ length: n }, (_, i) => `${i + 1}/${n}`).sort(), `${script}: shards ${rows.map((r) => r.shard).join(', ')}`);
    const source = read(script);
    assert.match(source, /\[string\]\$Shard\b/, `${script} has no -Shard parameter`);
  }
  assert.ok(Object.values(byScript).some((rows) => rows.length > 1), 'no script runs in shards');
});

test('T-67 the jobs run on Windows with the pinned Claude Code, read-only permissions and a time limit', () => {
  const text = workflow();
  assert.match(text, /^on:\n\s+workflow_dispatch:/m, 'the workflow is started by hand');
  assert.match(text, /^permissions:\n\s+contents: read\s*$/m, 'workflow permissions are read-only');
  assert.match(text, /runs-on: windows-latest/);
  assert.match(text, /CGW_REQUIRE_WINDOWS: '1'/);
  assert.match(text, /CGW_REQUIRE_CLAUDE: '1'/);
  const pinned = CLAUDE_PIN.exec(text)?.[1];
  assert.equal(pinned, CLAUDE_PIN.exec(read('.github/workflows/ironclad.yml'))?.[1], 'the mutation jobs install another Claude Code than the gate');
  const limits = [...text.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(limits.length >= 2 && limits.every((m) => m > 0 && m < 360), `timeout-minutes: ${limits.join(', ')}`);
  assert.doesNotMatch(text, /secrets\./, 'the mutation jobs need no secret');
});

test('T-67 every action is pinned to a full commit SHA, and each log is kept even when the job fails', () => {
  const text = workflow();
  const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3, `uses: ${uses.join(', ')}`);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} is not pinned to a commit SHA`);
  const upload = text.indexOf('actions/upload-artifact@');
  assert.ok(upload > 0, 'no log upload');
  assert.match(text.slice(Math.max(0, upload - 200), upload), /if: always\(\)/, 'the log upload is skipped when the job fails');
});
