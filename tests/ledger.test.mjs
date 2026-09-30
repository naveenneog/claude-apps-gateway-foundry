import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activePacket, column, danglingReferences, definedIds, dependencyGaps, donePackets, roadmapActive, editorialViolations, evidenceGaps, evidenceViolations,
  hasCitation, hasDatedCommand, roadmapViolations, splitRow, strayRows, tableAfterHeading, tables, unknownsViolations,
} from './ledger-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const comparisonAdr = () => {
  const name = fs.readdirSync(path.join(root, 'docs', 'adr')).find((f) => /^0002-.*\.md$/.test(f));
  assert.ok(name, 'docs/adr/0002-*.md (gateway comparison ADR) exists');
  return read(`docs/adr/${name}`);
};
const citedOrDatedCommand = (text) => hasCitation(text) || hasDatedCommand(text);
// Every decision record except the template, so a new ADR is checked without editing this list.
const decisionRecords = () => fs.readdirSync(path.join(root, 'docs', 'adr'))
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .map((f) => ({ rel: `docs/adr/${f}`, text: read(`docs/adr/${f}`) }));

// ── The detectors catch what they claim to catch: synthetic input, one broken condition per case ──

const UNKNOWNS_HEADER = '| ID | Packet | Unknown | State | Resolution | Source / risk |\n|---|---|---|---|---|---|\n';
const unknownProblems = (...rows) => unknownsViolations(UNKNOWNS_HEADER + rows.join('\n')).problems;

test('unknowns rule: each broken condition is reported on its own', () => {
  const cases = [
    ['| U-1 | P-2 | q | RESEARCHED | r | https://example.org/doc |', 'U-1: RESEARCHED'],
    ['| U-1 | P-2 | q | RESEARCHED | r | checked 2026-09-23 |', 'U-1: RESEARCHED'],
    ['| U-1 | P-2 | q | RESEARCHED | r | https://example.org/log/2026-01-15-x |', 'U-1: RESEARCHED'],
    ['| U-1 | P-2 | q | ASSUMED | r | Detector: P-4 smoke test |', 'U-1: ASSUMED'],
    ['| U-1 | P-2 | q | ASSUMED | r | Detector: none yet. Risk: if false, P-10 moves |', 'U-1: ASSUMED'],
    ['| U-1 | P-2 | q | RESOLVED | r | passed on 2026-09-23 |', 'U-1: RESOLVED'],
    ['| U-1 | P-2 | q | RESOLVED | r | `node --test` passed |', 'U-1: RESOLVED'],
    ['| U-1 | P-2 | q | OPEN | — | nobody owns it |', 'U-1: OPEN'],
    ['| U-1 | P-2 | q | OPEN | — | Blocks P-4 |', 'U-1: OPEN'],
    ['| U-1 | P-2 | q | MAYBE | — | — |', 'U-1: unknown state'],
    ['| U-1 | — | q | MOOT | — | — |', 'U-1: no packet'],
    ['| **U-1** | P-2 | q | MOOT | — | — |', 'not of the form U-n'],
    ['| U\u20111 | P-2 | q | MOOT | — | — |', 'not of the form U-n'],
    ['| U-1 | P-2 | q | MOOT | — |', '5 cells'],
  ];
  for (const [row, expected] of cases) {
    const problems = unknownProblems(row);
    assert.equal(problems.length, 1, `${row}\n→ ${JSON.stringify(problems)}`);
    assert.ok(problems[0].includes(expected), `${row}\n→ ${problems[0]}`);
  }
  assert.deepEqual(unknownProblems('| U-1 | P-2 | q | MOOT | — | — |', '| U-1 | P-2 | q | MOOT | — | — |'), ['U-1: duplicate id']);
});

test('unknowns rule accepts cited, dated and detector-backed rows, including escaped pipes', () => {
  assert.deepEqual(unknownProblems(
    '| U-1 | P-2 | q | RESEARCHED | r | https://example.org/doc (checked 2026-09-23) |',
    '| U-2 | P-2 | q | RESEARCHED | r | infra/policy.ps1:42, checked 2026-09-23 |',
    '| U-3 | P-2 | q | ASSUMED | r | Risk: low. Detector: P-4 smoke test |',
    '| U-4 | P-2 | q | ASSUMED | r | Detector: tests/x.test.mjs. Risk: low |',
    '| U-5 | P-3 | q | OPEN | — | Blocks P-3 |',
    '| U-6 | P-3 | q | RESOLVED | r | `node --test` passed 2026-09-23 |',
    '| U-7 | P-3 | `a \\| b` | MOOT | — | — |',
  ), []);
});

test('citation rule accepts URLs and path:line, rejects host:port, bare names and missing lines', () => {
  const cited = ['https://learn.microsoft.com/x', 'C:\\repo\\infra\\policy.xml:27-36', 'scripts/Sync-ClaudeAccess.ps1:42',
    'infra/main.bicepparam:3', 'build/Dockerfile:12', '`infra/main.bicep:20`'];
  const uncited = ['registry.npmjs.org:443', 'e.g:1', 'policy.xml:27', 'docs/ARCHITECTURE.md', 'see the policy file',
    '`curl.exe -s https://x.org/v1/messages`'];
  for (const text of cited) assert.ok(hasCitation(text), `cited: ${text}`);
  for (const text of uncited) assert.ok(!hasCitation(text), `not cited: ${text}`);
});

test('dated-command rule needs a backticked command and a date outside any URL', () => {
  assert.ok(hasDatedCommand('`az apim list`, 2026-09-23'));
  assert.ok(!hasDatedCommand('`az apim list`'));
  assert.ok(!hasDatedCommand('az apim list, 2026-09-23'));
  assert.ok(!hasDatedCommand('`curl.exe https://x.org/2026-09-23/`'));
});

test('table parser keeps the header, unescapes pipes, skips fenced tables and reports row shape', () => {
  assert.deepEqual(splitRow('| a | `x \\| y` | c |'), ['a', '`x | y`', 'c']);
  assert.equal(tables('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n').length, 0);
  assert.equal(tables('| no separator | row |\n| so not | a table |\n').length, 0);
  // GitHub continues a table until a blank line or a new block, so a row without a leading pipe is still a row.
  assert.deepEqual(tables('| a | b |\n|---|---|\n| 1 | 2 |\n3 | 4\n\nafter\n')[0].rows, [['1', '2'], ['3', '4']]);
  assert.deepEqual(tables('## H\n| a | b |\n|---|---|\n| 1 | 2 |\n## Next\n| c |\n|---|\n| 3 |\n').map((t) => [t.heading, t.rows.length]),
    [['H', 1], ['Next', 1]]);
  const md = '## Comparison\n| Dimension | A | B | Evidence |\n|---|---|---|---|\n'
    + '| Auth | `x \\| y` | b | see docs |\n| Cost | a | b | infra/main.bicep:20 |\n| Extra | a | b | infra/x.md:1 | more |\n';
  assert.equal(tableAfterHeading(md, /^Nope$/), null);
  const table = tableAfterHeading(md, /^Comparison$/);
  assert.deepEqual(table.header, ['Dimension', 'A', 'B', 'Evidence']);
  assert.deepEqual(table.rows[0], ['Auth', '`x | y`', 'b', 'see docs']);
  assert.deepEqual(evidenceViolations(table, /^Evidence$/).problems, [
    'row 3 ("Extra"): 5 cells, header has 4',
    'row "Auth": no citation in the Evidence column',
  ]);
});

test('evidence rule accepts a dated command only when asked to', () => {
  const table = tableAfterHeading('## F\n| Fact | Evidence |\n|---|---|\n| x | `az apim list`, 2026-09-23 |\n'
    + '| y | `curl.exe -s https://x.org/v1/messages` |\n', /^F$/);
  assert.deepEqual(evidenceViolations(table, /^Evidence$/, citedOrDatedCommand).problems, ['row "y": no citation in the Evidence column']);
  assert.deepEqual(evidenceViolations(table, /^Evidence$/).problems,
    ['row "x": no citation in the Evidence column', 'row "y": no citation in the Evidence column']);
  assert.throws(() => column(table, /^Source$/), /no column matching/);
});

test('roadmap rule rejects a missing Given/when/then, a malformed packet line and a run-on body', () => {
  const md = [
    '## Now',
    '- [ ] P-1  thing',
    '      Given a, when b, then c.',
    '- [ ] P-2  other',
    '      Depends on: P-1',
    '- [ ] **P-3**  bold id',
    '      Given a, when b, then c.',
    '- [ ] P-4  no criteria',
    '',
    'Given a later paragraph, when read, then it belongs to no packet.',
  ].join('\n');
  const { ids, problems } = roadmapViolations(md);
  assert.deepEqual(ids, ['P-1', 'P-2', 'P-4']);
  assert.deepEqual([...problems].sort(), [
    'P-2: no "Given … when … then …" acceptance line',
    'P-4: no "Given … when … then …" acceptance line',
    'malformed packet line: "- [ ] **P-3**  bold id"',
  ]);
});

test('editorial rule flags reader-directing prose before and after fenced code, not inside it', () => {
  const md = 'Plain fact.\nNote that this matters.\n```\nmake sure\n```\nYou should see this.\n';
  assert.deepEqual(editorialViolations(md), ['line 2: "Note that this matters."', 'line 6: "You should see this."']);
});

test('stray-row rule reports pipe rows that belong to no table, outside fenced code', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |\n```\n| fenced | row |\n```\n';
  assert.deepEqual(strayRows(md), ['line 5: "| 3 | 4 |"']);
});

test('reference rule reports IDs that no ledger document defines, inside fenced code too', () => {
  const ids = definedIds({
    roadmap: '## Now\n- [ ] P-1  a\n      Given a, when b, then c.\n',
    testPlan: '## Test cases\n| ID | Packet |\n|---|---|\n| T-01 | P-1 |\n\n## Parity scenarios (P-1)\n| ID | Measure |\n|---|---|\n| PS-1 | x |\n',
    unknowns: `${UNKNOWNS_HEADER}| U-1 | P-1 | q | MOOT | — | — |\n`,
  });
  assert.deepEqual([...ids].sort(), ['P-1', 'PS-1', 'T-01', 'U-1']);
  assert.deepEqual(danglingReferences('P-1, T-01, PS-1 and U-1 resolve; P-2 does not.\n```yaml\n# T-02\n```\n', ids), ['P-2', 'T-02']);
});

test('roadmap rule reads each packet\'s dependencies and ignores the unknowns on the same line', () => {
  const md = '## Now\n- [ ] P-1  a\n      Given a, when b, then c.\n      Depends on: —          Unknowns: U-1\n'
    + '- [ ] P-2  b\n      Given a, when b, then c.\n      Depends on: P-1, P-3   Unknowns: U-2, P-9\n';
  assert.deepEqual(roadmapViolations(md).deps, { 'P-1': [], 'P-2': ['P-1', 'P-3'] });
});

test('evidence rule: a done packet needs a current PASS, with evidence, for every case assigned to it', () => {
  const roadmap = '## Now\n- [x] P-1  a\n      Given a, when b, then c.\n- [x] P-2  b\n      Given a, when b, then c.\n'
    + '- [ ] P-3  c\n      Given a, when b, then c.\n```\n- [x] P-3  fenced\n```\n';
  const cases = '## Test cases\n| ID | Packet | Negative |\n|---|---|---|\n| T-01 | P-1 | — |\n| T-02 | P-2 | bad input → 400 |\n| T-03 | P-2 | — |\n| T-04 | P-3 | — |\n\n';
  const results = (heading, rows) => `## Results — ${heading}\n| ID | Result | Evidence |\n|---|---|---|\n${rows}\n\n`;
  const plan = (...tablesMd) => `${cases}${tablesMd.join('')}## Other notes\n| ID | Result |\n|---|---|\n| T-02 | PASS |\n`;
  const ok = '| T-01 | PASS | x |\n| T-02, T-03 | PASS | y. Negative: 400 |';
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', ok))), []);
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', '| T-01 | PASS | x |\n| T-02 | BLOCKED | y |\n| T-03 | PASS | z |'))),
    ['P-2 is done but T-02 is BLOCKED under "Results — env, 2026-09-23"']);
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', '| T-01 | PASS | x |'))),
    ['P-2 is done but T-02 has no result', 'P-2 is done but T-03 has no result'], 'a PASS outside a Results table does not count');
  // The QA reproductions (round 2): an old PASS outranked a current BLOCKED, and an empty PASS counted.
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-24', '| T-01 | PASS | x |\n| T-02 | BLOCKED | y |\n| T-03 | PASS | z |'),
    results('env, 2026-09-23', ok))), ['P-2 is done but T-02 is BLOCKED under "Results — env, 2026-09-24"'], 'the latest date wins, wherever the table sits');
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', ok), results('env, 2026-09-23', '| T-02 | BLOCKED | y |'))),
    ['P-2 is done but T-02 is BLOCKED under "Results — env, 2026-09-23"'], 'on the same date, the later table wins');
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', '| T-01 | PASS | — |\n| T-02, T-03 | PASS |  |'))),
    ['P-1 is done but T-01 has a PASS without evidence', 'P-2 is done but T-02 has a PASS without evidence', 'P-2 is done but T-03 has a PASS without evidence']);
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', '| T-01 | PASS | x |\n| T-02, T-03 | PASS | y |'))),
    ['P-2 is done but T-02 has a PASS without evidence for its negative'], 'T-03 has no negative to record');
  assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', `${ok}\n| T-03 | BLOCKED | z |`))),
    ['P-2 is done but T-03 has conflicting results under "Results — env, 2026-09-23"']);
  // The QA reproduction (round 3): a third, agreeing row used to erase the conflict.
  for (const rows of [['BLOCKED', 'PASS', 'PASS'], ['PASS', 'BLOCKED', 'PASS'], ['PASS', 'PASS', 'BLOCKED'], ['PASS', 'FAIL', 'FAIL', 'PASS']]) {
    const md = rows.map((r) => `| T-03 | ${r} | z |`).join('\n');
    assert.deepEqual(evidenceGaps(roadmap, plan(results('env, 2026-09-23', `| T-01 | PASS | x |\n| T-02 | PASS | y. Negative: 400 |\n${md}`))),
      ['P-2 is done but T-03 has conflicting results under "Results — env, 2026-09-23"'], rows.join(' → '));
  }
  assert.deepEqual(donePackets(roadmap), ['P-1', 'P-2'], 'fenced checkboxes are not packets');
});
// ── The real ledger satisfies them; each check has a floor so it cannot pass on an empty table ──

test('UNKNOWNS: every row is owned, well-formed, and closed rows carry their evidence', () => {
  const { count, problems } = unknownsViolations(read('docs/UNKNOWNS.md'));
  assert.ok(count >= 20, `expected at least 20 logged unknowns, found ${count}`);
  assert.deepEqual(problems, []);
});

test('ADR-0002: every comparison row cites evidence', () => {
  const table = tableAfterHeading(comparisonAdr(), /^Comparison$/);
  assert.ok(table && table.rows.length >= 25, `expected at least 25 comparison rows, found ${table?.rows.length ?? 0}`);
  assert.deepEqual(evidenceViolations(table, /^Evidence$/).problems, []);
});

test('GATEWAY-COMPARISON: every row of a table with an Evidence column cites a URL or path:line', () => {
  const sourced = tables(read('docs/GATEWAY-COMPARISON.md')).filter((t) => t.header.some((h) => /^Evidence$/.test(h)));
  const rows = sourced.reduce((n, t) => n + t.rows.length, 0);
  assert.ok(sourced.length >= 3 && rows >= 40, `expected at least 3 sourced tables and 40 rows, found ${sourced.length} and ${rows}`);
  const problems = sourced.flatMap((t) => evidenceViolations(t, /^Evidence$/).problems.map((p) => `${t.heading}: ${p}`));
  assert.deepEqual(problems, []);
});

test('ARCHITECTURE: every fact, component, behaviour and constraint row cites evidence', () => {
  const sourced = tables(read('docs/ARCHITECTURE.md')).filter((t) => t.header.some((h) => /^(Evidence|Source)$/.test(h)));
  const rows = sourced.reduce((n, t) => n + t.rows.length, 0);
  assert.ok(sourced.length >= 4 && rows >= 30, `expected at least 4 sourced tables and 30 rows, found ${sourced.length} and ${rows}`);
  const problems = sourced.flatMap((t) => evidenceViolations(t, /^(Evidence|Source)$/, citedOrDatedCommand)
    .problems.map((p) => `${t.heading}: ${p}`));
  assert.deepEqual(problems, []);
});

test('no ledger table loses rows to a blank line or a missing separator', () => {
  const docs = ['README.md', 'docs/CHARTER.md', 'docs/ROADMAP.md', 'docs/STATUS.md', 'docs/UNKNOWNS.md',
    'docs/ARCHITECTURE.md', 'docs/TEST-PLAN.md', 'docs/GATEWAY-COMPARISON.md'];
  const stray = docs.flatMap((rel) => strayRows(read(rel)).map((p) => `${rel} ${p}`));
  const records = decisionRecords();
  assert.ok(records.length >= 3, `expected at least 3 decision records, found ${records.length}`);
  stray.push(...records.flatMap(({ rel, text }) => strayRows(text).map((p) => `${rel} ${p}`)));
  assert.deepEqual(stray, []);
});

test('ROADMAP: packets are unique, well-formed, and each states Given/when/then', () => {
  const { ids, problems } = roadmapViolations(read('docs/ROADMAP.md'));
  assert.ok(ids.length >= 12, `expected at least 12 packets, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, `duplicate packet ids in ${ids}`);
  assert.deepEqual(problems, []);
});

test('STATUS names an active packet that exists in the roadmap', () => {
  const active = activePacket(read('docs/STATUS.md'));
  assert.ok(active, 'docs/STATUS.md names an active packet as P-n');
  assert.ok(roadmapViolations(read('docs/ROADMAP.md')).ids.includes(active), `${active} is in docs/ROADMAP.md`);
});

test('TEST-PLAN: cases are unique and each has a roadmap packet, an expected result, a negative check and a source', () => {
  const table = tableAfterHeading(read('docs/TEST-PLAN.md'), /^Test cases$/);
  assert.ok(table && table.rows.length >= 20, `expected at least 20 test cases, found ${table?.rows.length ?? 0}`);
  const packets = new Set(roadmapViolations(read('docs/ROADMAP.md')).ids);
  const [id, packet, expected, negative] = [/^ID$/, /^Packet$/, /^Expected/, /^Negative/].map((re) => column(table, re));
  const ids = table.rows.map((cells) => cells[id]);
  assert.equal(new Set(ids).size, ids.length, `duplicate test ids in ${ids}`);
  for (const cells of table.rows) {
    assert.ok(packets.has(cells[packet]), `${cells[id]}: packet ${cells[packet]} is in the roadmap`);
    assert.ok(cells[expected] && cells[expected] !== '—', `${cells[id]}: states an expected result`);
    assert.ok(cells[negative] && cells[negative] !== '—', `${cells[id]}: states a negative check`);
  }
  assert.deepEqual(evidenceViolations(table, /^Source$/).problems, []);
});

test('authored docs keep to factual wording', () => {
  const authored = ['README.md', 'docs/CHARTER.md', 'docs/ROADMAP.md', 'docs/STATUS.md', 'docs/UNKNOWNS.md',
    'docs/ARCHITECTURE.md', 'docs/TEST-PLAN.md', 'docs/GATEWAY-COMPARISON.md'];
  const findings = authored.flatMap((rel) => editorialViolations(read(rel)).map((p) => `${rel} ${p}`));
  findings.push(...decisionRecords().flatMap(({ rel, text }) => editorialViolations(text).map((p) => `${rel} ${p}`)));
  assert.deepEqual(findings, []);
});

test('every P-, T-, PS- and U- reference in the ledger resolves to a defined item', () => {
  const ids = definedIds({ roadmap: read('docs/ROADMAP.md'), testPlan: read('docs/TEST-PLAN.md'), unknowns: read('docs/UNKNOWNS.md') });
  assert.ok(ids.size >= 80, `expected at least 80 defined ids, found ${ids.size}`);
  const docs = ['README.md', 'CHANGELOG.md', 'docs/CHARTER.md', 'docs/ROADMAP.md', 'docs/STATUS.md', 'docs/UNKNOWNS.md',
    'docs/ARCHITECTURE.md', 'docs/TEST-PLAN.md', 'docs/GATEWAY-COMPARISON.md'];
  docs.push(...fs.readdirSync(path.join(root, 'docs', 'learn')).filter((f) => f.endsWith('.md')).map((f) => `docs/learn/${f}`));
  const dangling = docs.flatMap((rel) => danglingReferences(read(rel), ids).map((id) => `${rel}: ${id}`));
  dangling.push(...decisionRecords().flatMap(({ rel, text }) => danglingReferences(text, ids).map((id) => `${rel}: ${id}`)));
  assert.deepEqual(dangling, []);
});

test('ROADMAP keeps the security ordering: migration after bypass closure, Azure after fail-closed spend', () => {
  const { deps } = roadmapViolations(read('docs/ROADMAP.md'));
  assert.ok(deps['P-13']?.includes('P-12'), `P-13 depends on P-12, found ${deps['P-13']}`);
  assert.ok(deps['P-10']?.includes('P-8'), `P-10 depends on P-8, found ${deps['P-10']}`);
  for (const route of ['P-15', 'P-17']) assert.ok(deps['P-16']?.includes(route), `P-16 depends on ${route}, found ${deps['P-16']}`);
});

test('ROADMAP marks a packet done only when every case assigned to it has a PASS result', () => {
  const done = donePackets(read('docs/ROADMAP.md'));
  assert.ok(done.includes('P-0') && done.includes('P-1'), `P-0 and P-1 are done, found ${done}`);
  assert.deepEqual(evidenceGaps(read('docs/ROADMAP.md'), read('docs/TEST-PLAN.md')), []);
});

test('ROADMAP: a packet marked done has every packet it depends on done', () => {
  assert.deepEqual(dependencyGaps(read('docs/ROADMAP.md')), []);
  const fixture = ['- [x] P-1  One', '      Given a, when b, then c.', '      Depends on: P-2', '- [ ] P-2  Two', '      Given a, when b, then c.', '      Depends on: —'].join('\n');
  assert.deepEqual(dependencyGaps(fixture), ['P-1 is done but depends on P-2, which is not']);
  assert.deepEqual(dependencyGaps(fixture.replace('- [ ] P-2', '- [x] P-2')), []);
});

test('ROADMAP marks exactly one active packet, the one STATUS names', () => {
  assert.deepEqual(roadmapActive(read('docs/ROADMAP.md')), [activePacket(read('docs/STATUS.md'))]);
  assert.deepEqual(roadmapActive('- [ ] P-3  Three   ← ACTIVE\n- [ ] P-4  Four   ← ACTIVE\n'), ['P-3', 'P-4']);
  assert.deepEqual(roadmapActive('- [ ] P-3  Three\n'), []);
});