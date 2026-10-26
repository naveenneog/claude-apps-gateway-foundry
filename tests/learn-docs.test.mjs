// T-66 (docs/TEST-PLAN.md): the Microsoft Learn articles in docs/learn/ (ADR-0004). Each has Learn front matter,
// cites its claims, keeps to factual wording, and every script command it shows names an existing script with options
// that script accepts. The reference names every parameter of each script it documents, and toc.yml lists every
// article. The fixture tests at the end show that each detector reports what it guards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { editorialViolations, hasCitation } from './ledger-rules.mjs';
import { partsInOrder, scriptMessages } from './message-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEARN = path.join(root, 'docs', 'learn');
const TOPICS = new Set(['overview', 'quickstart', 'how-to', 'reference', 'troubleshooting', 'concept-article', 'tutorial']);
const COMMON = new Set(['verbose', 'debug', 'erroraction', 'warningaction', 'informationaction', 'errorvariable', 'warningvariable', 'outvariable', 'outbuffer', 'pipelinevariable']);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const articles = () => fs.readdirSync(LEARN).filter((f) => f.endsWith('.md')).map((f) => ({ rel: `docs/learn/${f}`, text: fs.readFileSync(path.join(LEARN, f), 'utf8') }));

function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return null;
  return Object.fromEntries(m[1].split('\n').filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim().replace(/^"(.*)"$/, '$1')]));
}

// The options a script accepts: a PowerShell param block's parameters, or a Node.js parseArgs options object's keys.
export function acceptedOptions(file, text) {
  if (file.endsWith('.ps1')) {
    const start = text.search(/^param\(/m);
    if (start < 0) return new Set();
    let depth = 0;
    let end = start;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '(') depth += 1;
      if (text[i] === ')' && --depth === 0) { end = i; break; }
    }
    return new Set([...text.slice(start, end).matchAll(/\]\s*\$(\w+)/g)].map((m) => `-${m[1].toLowerCase()}`));
  }
  const at = text.indexOf('options:', text.indexOf('parseArgs('));
  if (at < 0) return new Set();
  const open = text.indexOf('{', at);
  let depth = 0;
  let close = open;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) { close = i; break; }
  }
  const options = text.slice(open + 1, close);
  return new Set([...options.matchAll(/(?:^|[\s{,])'?([a-z][a-z-]*)'?\s*:\s*\{\s*type:/g)].map((m) => `--${m[1]}`));
}

// Every script file a command may name, by repository path and by file name.
function scriptIndex() {
  const index = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ps1|mjs)$/.test(e.name)) { index.set(rel, rel); if (!index.has(e.name)) index.set(e.name, rel); }
    }
  };
  for (const dir of ['scripts', 'infra/azure-test', 'infra/azure-private', 'tests', 'admin-ui']) walk(dir);
  return index;
}

// The rows of each table with Message and Source columns: the message in backticks, and the path:line its Source cites.
export function messageRows(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|/.test(lines[i])) continue;
    const header = lines[i].split('|').map((c) => c.trim());
    const [messageAt, sourceAt] = [header.indexOf('Message'), header.indexOf('Source')];
    if (messageAt < 0 || sourceAt < 0) continue;
    for (let j = i + 2; j < lines.length && /^\|/.test(lines[j]); j++) {
      const cells = lines[j].split('|').map((c) => c.trim());
      const source = /^([\w./-]+):(\d+)$/.exec(cells[sourceAt] ?? '');
      rows.push({ text: lines[j], messageCell: cells[messageAt] ?? '', sourceCell: cells[sourceAt] ?? '', message: /`([^`]+)`/.exec(cells[messageAt] ?? '')?.[1],
        file: source?.[1], line: source ? Number(source[2]) : null });
    }
  }
  return rows;
}

// In a table with Message and Source columns, each message's literal parts, the text between its <placeholders>, appear
// in order on one script line within one line of the line the Source cites; a PowerShell '' counts as one quote and `"
// as a quote. A message may stop before the script's message ends, but it adds no text the script does not print (QA
// review, round 3): a value the script interpolates is a <placeholder> in the message. Parts on two adjacent lines are
// two messages, not one (QA review, round 5).
export function messageSourceProblems(text, readLines) {
  const problems = [];
  for (const row of messageRows(text)) {
    if (!row.message || !row.file) { problems.push(`row "${row.messageCell.slice(0, 40)}" has no message or no path:line source`); continue; }
    const file = readLines(row.file);
    if (!file) { problems.push(`the Source ${row.sourceCell} names a missing file`); continue; }
    const window = file.slice(Math.max(0, row.line - 2), row.line + 1).map((l) => l.replace(/''/g, "'").replace(/`"/g, '"'));
    const inOrder = partsInOrder(row.message);
    if (!inOrder || !window.some((l) => inOrder.test(l))) problems.push(`"${row.message.slice(0, 50)}" is not printed at ${row.sourceCell}`);
  }
  return problems;
}

// A path:line citation into a script or a ledger document lands on at least one line with text, not only on blank lines
// or braces, which is what a citation left behind by an edit usually points at.
function codeCitationProblems(text, readLines) {
  const problems = [];
  for (const m of text.matchAll(/\b((?:scripts|tests|infra|docs)\/[\w./-]+\.(?:mjs|ps1|psm1|sh|md)):(\d+)(?:-(\d+))?/g)) {
    const file = readLines(m[1]);
    if (!file) continue;
    const cited = file.slice(Number(m[2]) - 1, Number(m[3] ?? m[2]));
    if (cited.length && cited.every((l) => /^\s*[{}()[\];,]*\s*$/.test(l))) problems.push(`${m[0]} lands only on blank lines or braces`);
  }
  return problems;
}
const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');

// The problems of one article; fileLines(rel) returns a repository file's line count, or null when it is missing.
export function articleProblems({ rel, text: raw }, { scripts, fileLines, headingsOf, readLines }) {
  // Git stores the articles with LF endings (.gitattributes) and CI reads them so; a CRLF working copy is read the same way.
  const text = raw.replace(/\r\n/g, '\n');
  const problems = [];
  const fm = frontMatter(text);
  if (!fm) problems.push('no front matter');
  else {
    for (const key of ['title', 'description', 'author', 'ms.date', 'ms.topic']) if (!fm[key]) problems.push(`front matter has no ${key}`);
    if (fm['ms.date'] && !/^\d{2}\/\d{2}\/\d{4}$/.test(fm['ms.date'])) problems.push(`ms.date ${fm['ms.date']} is not MM/DD/YYYY`);
    if (fm['ms.topic'] && !TOPICS.has(fm['ms.topic'])) problems.push(`ms.topic ${fm['ms.topic']} is not a Learn topic type`);
  }
  if (!hasCitation(text)) problems.push('no citation');
  // Every section states facts, so each cites a source; navigation sections are exempt.
  for (const section of text.replace(/```[\s\S]*?```/g, '').split(/^## /m).slice(1)) {
    const heading = section.slice(0, section.indexOf('\n')).trim();
    if (!/^(Related content|Next steps|Clean up resources)$/.test(heading) && !hasCitation(section)) problems.push(`section "${heading}" has no citation`);
  }
  problems.push(...editorialViolations(text));
  for (const m of text.matchAll(/\b((?:docs|tests|scripts|config|infra)\/[\w./-]+\.(?:md|mjs|ps1|psm1|yaml|json)):(\d+)(?:-(\d+))?/g)) {
    const lines = fileLines(m[1]);
    const first = Number(m[2]);
    const last = Number(m[3] ?? m[2]);
    if (lines === null) problems.push(`${m[0]} names a missing file`);
    else if (first < 1 || last < first) problems.push(`${m[0]} is not a line range: lines start at 1, and a range ends at or after its start`);
    else if (last > lines) problems.push(`${m[0]} is past the end of ${m[1]} (${lines} lines)`);
  }
  for (const m of text.matchAll(/\]\(((?!https?:)[^)#\s]+\.(?:md|yml))(?:#([\w-]+))?\)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    const headings = headingsOf(target);
    if (headings === null) problems.push(`link ${m[1]} names a missing file`);
    else if (m[2] && !headings.includes(m[2])) problems.push(`link ${m[1]}#${m[2]} names a missing heading`);
  }
  problems.push(...messageSourceProblems(text, readLines));
  problems.push(...codeCitationProblems(text, readLines));
  for (const block of text.matchAll(/```(?:powershell|bash|console|cmd|sh)\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const script = /(?:^|[\s"'\\/.])((?:(?:scripts|infra|tests|admin-ui)[\\/][\w.\\/-]+|[\w-]+)\.(?:ps1|mjs))(?=["'\s]|$)/.exec(line);
      if (!script) continue;
      const name = script[1].replace(/\\/g, '/');
      // A name with a directory must be that path; a bare name, as run from a copied folder, may be any script's.
      const file = scripts.get(name);
      if (!file) { problems.push(`command names a missing script: ${script[1]}`); continue; }
      const accepted = acceptedOptions(file, read(file));
      const rest = line.slice(script.index + script[0].length);
      for (const [, option] of rest.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)) {
        const key = file.endsWith('.ps1') ? option.toLowerCase() : option;
        if (!accepted.has(key) && !(file.endsWith('.ps1') && COMMON.has(key.slice(1)))) problems.push(`${script[1]} does not accept ${option}`);
      }
    }
  }
  return problems;
}

const context = () => {
  const scripts = scriptIndex();
  // A file that ends with a newline has one line fewer than it has newline-separated parts.
  const fileLines = (rel) => (fs.existsSync(path.join(root, rel)) ? read(rel).replace(/\n$/, '').split('\n').length : null);
  const headingsOf = (rel) => (fs.existsSync(path.join(root, rel)) ? [...read(rel).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])) : null);
  const readLines = (rel) => (fs.existsSync(path.join(root, rel)) ? read(rel).split('\n') : null);
  return { scripts, fileLines, headingsOf, readLines };
};

test('T-66 each Learn article has front matter, citations, factual wording, valid references and runnable commands', () => {
  const docs = articles();
  assert.ok(docs.length >= 6, `expected at least 6 articles in docs/learn, found ${docs.length}`);
  const ctx = context();
  assert.deepEqual(docs.flatMap((a) => articleProblems(a, ctx).map((p) => `${a.rel}: ${p}`)), []);
});

test('T-66 the script reference names every parameter of every script it documents', () => {
  const reference = read('docs/learn/reference-scripts.md');
  const scripts = scriptIndex();
  const sections = reference.split(/^### /m).slice(1).map((s) => ({ name: s.slice(0, s.indexOf('\n')).trim(), body: s }));
  assert.ok(sections.length >= 8, `expected at least 8 documented scripts, found ${sections.length}`);
  const missing = [];
  for (const { name, body } of sections) {
    const files = name === 'Mutation checks' ? ['tests/mutate-developer.ps1', 'tests/mutate-admin.ps1'] : [scripts.get(name)];
    for (const file of files) {
      assert.ok(file, `the reference documents ${name}, which is not a script in the repository`);
      for (const option of acceptedOptions(file, read(file))) if (!new RegExp(`\`${option}\``, 'i').test(body)) missing.push(`${name}: ${option}`);
    }
  }
  assert.deepEqual(missing, []);
});

// The messages the developer scripts print when something fails come from tests/message-rules.mjs, which T-54's
// START-HERE check shares.

// A message another message of the same file prints as its <reason>: the file, the reason, and the message that wraps
// it. The wrapper's row covers the reason when it quotes it; any other message needs its own row (Architect review,
// round 5). Read-GatewaySession throws the reason and catches it into the wrapper (ClaudeGateway.psm1, Read-GatewaySession).
export const WRAPPED_REASONS = [
  { file: 'scripts/developer/ClaudeGateway.psm1', reason: 'it holds no JSON object', wrapper: 'The saved session <file> cannot be read by this Windows user (<reason>). Signing in again replaces it.' },
];

// Every message a developer script prints on failure has a troubleshooting row (UX review, round 3): a row whose Source
// cites the message's file within one line of it, and whose message's literal parts appear in the script's message in
// order, so prose, a row that cites another line, or another message's row does not count (Coder and QA review,
// round 4). A reason in WRAPPED_REASONS is covered by its wrapper's row when the row quotes it. A message whose literal
// parts are all shorter than 12 characters, such as a script's own name before a message it passes on, has no text of
// its own.
export function uncoveredMessages(doc, sources, wrapped = WRAPPED_REASONS) {
  const rows = messageRows(doc).filter((r) => r.message && r.file);
  const missing = [];
  for (const { file, text } of sources) {
    for (const m of scriptMessages(text)) {
      const wrapper = wrapped.find((w) => w.file === file && w.reason === m.text)?.wrapper;
      const covered = rows.some((r) => r.file === file && ((Math.abs(r.line - m.line) <= 1 && partsInOrder(r.message)?.test(m.text))
        || (wrapper !== undefined && r.message === wrapper && r.text.includes(`\`${m.text}\``))));
      if (m.longest.length >= 12 && !covered) missing.push(`${file}:${m.line} ${m.longest.slice(0, 70)}`);
    }
  }
  return missing;
}

test('T-66 the troubleshooting article covers every message the developer scripts print on failure', () => {
  const sources = fs.readdirSync(path.join(root, 'scripts', 'developer')).filter((f) => /\.(ps1|psm1)$/.test(f))
    .map((f) => ({ file: `scripts/developer/${f}`, text: read(`scripts/developer/${f}`) }));
  assert.deepEqual(uncoveredMessages(read('docs/learn/troubleshoot.md'), sources), []);
  const table = (message, source) => `| Message | Cause | Source |\n|---|---|---|\n| \`${message}\` | A cause | ${source} |\n`;
  const script = [{ file: 'x.ps1', text: 'throw "A message the article has."\nthrow "A message the article lacks."' }];
  assert.deepEqual(uncoveredMessages(table('A message the article has.', 'x.ps1:1'), script), ['x.ps1:2 A message the article lacks.'], 'a message without a row is reported');
  // Only a row covers a message: not the message in prose, a row without a path:line Source, a row that cites another
  // file or a line two away, or another message's row at that line (Coder and QA review, round 4).
  const one = [{ file: 'x.ps1', text: '\n\nthrow "The saved session $file cannot be read."' }];
  for (const [doc, why] of [
    ['The script prints `The saved session <file> cannot be read.` when it fails, x.ps1:3.\n', 'prose'],
    [table('The saved session <file> cannot be read.', 'the helper'), 'a Source without path:line'],
    [table('The saved session <file> cannot be read.', 'y.ps1:3'), 'another file'],
    [table('The saved session <file> cannot be read.', 'x.ps1:1'), 'a line two away'],
    [table('Another message entirely.', 'x.ps1:3'), "another message's row"],
    [table('cannot be read. <file> The saved session', 'x.ps1:3'), 'the parts in another order'],
  ]) assert.deepEqual(uncoveredMessages(doc, one), ['x.ps1:3 The saved session'], why);
  assert.deepEqual(uncoveredMessages(table('The saved session <file> cannot be read.', 'x.ps1:2'), one), [], 'a row within one line covers it');
  // A reason in the wrapped list is covered by its wrapper's row when the row quotes it; another message of the file,
  // quoted in that row, is not (Architect review, round 5).
  const reason = [{ file: 'x.ps1', text: "throw 'it holds no JSON object'\nthrow 'an unrelated failure happened'\n\n\nthrow \"The session cannot be read ($($_.Exception.Message)).\"" }];
  const wrapped = [{ file: 'x.ps1', reason: 'it holds no JSON object', wrapper: 'The session cannot be read (<reason>).' }];
  const wrapper = (message, cause) => `| Message | Cause | Source |\n|---|---|---|\n| \`${message}\` | ${cause} | x.ps1:5 |\n`;
  const unrelated = 'x.ps1:2 an unrelated failure happened';
  assert.deepEqual(uncoveredMessages(wrapper('The session cannot be read (<reason>).', 'A reason such as `it holds no JSON object`'), reason, wrapped), [unrelated]);
  assert.deepEqual(uncoveredMessages(wrapper('The session cannot be read (<reason>).', 'Reasons such as `it holds no JSON object` or `an unrelated failure happened`'), reason, wrapped),
    [unrelated], 'a message that is not a wrapped reason needs its own row, even when the wrapper row quotes it');
  assert.deepEqual(uncoveredMessages(wrapper('The session cannot be read (<reason>).', 'A damaged file'), reason, wrapped), ['x.ps1:1 it holds no JSON object', unrelated], 'a row that does not quote the reason');
  assert.deepEqual(uncoveredMessages(wrapper('The session cannot be read (<reason>).', 'A reason such as `it holds no JSON object`'), reason, []),
    ['x.ps1:1 it holds no JSON object', unrelated], 'a reason outside the wrapped list');
  assert.deepEqual(uncoveredMessages(wrapper('The session cannot be read (<reason>).', 'A reason such as `it holds no JSON object`'), reason,
    [{ ...wrapped[0], wrapper: 'Another message (<reason>).' }]), ['x.ps1:1 it holds no JSON object', unrelated], 'a row of another message than the wrapper');
  // The detector finds a message in each of its three forms, and reads a message that starts with an interpolation.
  const found = scriptMessages([
    'throw "The profile $Dir is for $Old. Add -ReplaceGateway."',
    "if ($x) { throw 'The gateway''s answer has no valid expires_in.' }",
    '[Console]::Error.WriteLine("Get-X: $($_.Exception.Message) It is deleted without revocation.")',
    'Write-Diagnostic "$switch is set, so the token is not printed."',
  ].join('\n')).map((m) => m.longest);
  assert.deepEqual(found, ['. Add -ReplaceGateway.', "The gateway's answer has no valid expires_in.", 'It is deleted without revocation.', 'is set, so the token is not printed.']);
  // A comment prints nothing, so a message kept only in a comment is not one the script prints (QA review, round 5).
  assert.deepEqual(scriptMessages('# throw "An old message in a comment."\n<#\nthrow "An old message in a block comment."\n#>\nthrow "The message the script prints."').map((m) => [m.line, m.text]),
    [[5, 'The message the script prints.']]);
});

test('T-66 toc.yml lists every article, and every entry names an existing article', () => {
  const toc = read('docs/learn/toc.yml');
  const hrefs = [...toc.matchAll(/href:\s*(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.filter((h) => !fs.existsSync(path.join(LEARN, h))), []);
  assert.deepEqual(articles().map((a) => path.posix.basename(a.rel)).filter((f) => !hrefs.includes(f)), []);
});

test('T-111 the load-test article states its measurements, a sizing table the calculator reproduces, and its limits', async () => {
  const { size, DEFAULT_PROFILE, MEASURED } = await import('../scripts/perf/capacity.mjs');
  const rel = 'docs/learn/how-to-load-test-and-size.md';
  assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing`);
  const text = read(rel).replace(/\r\n/g, '\n');
  assert.match(text, /2\.1\.308/, 'the article names the gateway version it measured');
  const table = text.split('\n## ').find((s) => s.startsWith('Sizing for 500 to 25,000 developers'));
  assert.ok(table, 'no "Sizing for 500 to 25,000 developers" section');
  const lines = table.split('\n').filter((l) => l.startsWith('|'));
  const header = lines[0].split('|').map((c) => c.trim());
  const col = (name) => { const i = header.findIndex((h) => h.startsWith(name)); assert.ok(i > 0, `no ${name} column`); return i; };
  const [dev, reps, conns] = [col('Developers'), col('Replicas'), col('PostgreSQL connections')];
  const rows = lines.slice(2).map((l) => l.split('|').map((c) => c.trim()));
  const n = (s) => Number(s.replace(/,/g, '').split(' ')[0]);
  assert.deepEqual(rows.map((r) => n(r[dev])), [500, 1000, 2000, 10000, 25000]);
  for (const r of rows) {
    const want = size(n(r[dev]), { ...DEFAULT_PROFILE, ...MEASURED });
    assert.equal(n(r[reps]), want.replicas.total, `${r[dev]} developers: replicas`);
    assert.equal(n(r[conns]), want.postgres.connections, `${r[dev]} developers: PostgreSQL connections`);
  }
  const limits = text.split('\n## ').find((s) => s.startsWith('Limits of this test'));
  assert.ok(limits, 'no "Limits of this test" section');
  for (const gap of [/Foundry/, /TLS/, /ingress/i, /WSL/]) assert.match(limits, gap);
  assert.match(read('docs/learn/concept-plan-for-scale.md'), /how-to-load-test-and-size\.md/, 'concept-plan-for-scale links the measurements');
});

// T-112: the novice-reader fixes (docs/TEST-PLAN.md). Expectations come from the sources the docs describe, the admin
// console's navigation and the Graph permissions Deploy-AdminUi.ps1 grants, so a change there fails here.
const section = (text, heading) => text.replace(/\r\n/g, '\n').split('\n## ').find((s) => s.startsWith(heading));

test('T-112 a glossary defines the terms a new reader meets, each with a reference', () => {
  const rel = 'docs/learn/glossary.md';
  assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing`);
  const text = read(rel).replace(/\r\n/g, '\n');
  const rows = text.split('\n').filter((l) => l.startsWith('| ') && !/^\|\s*Term\s*\|/.test(l));
  const terms = rows.map((l) => l.split('|')[1].trim());
  for (const term of ['Admin console', 'App role', 'Azure RBAC', '`rbac_group` scope', 'CIDR range', 'Ingress', 'Revision',
    'Admin file', 'State file', 'Business unit', 'Chargeback', 'Microsoft Foundry', 'Spend cap']) {
    assert.ok(terms.some((t) => t.startsWith(term)), `the glossary does not define ${term}`);
  }
  assert.deepEqual(rows.filter((l) => !/https:\/\/|\]\([\w./#-]+\)/.test(l)).map((l) => l.split('|')[1].trim()), [], 'rows without a reference');
});

test('T-112 the admin console article names the console and every page in its navigation', () => {
  const html = read('admin-ui/web/index.html');
  const brand = /class="brand-name">([^<]+)</.exec(html)[1];
  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));
  const pages = [...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.ok(pages.length >= 8, `navigation parse found ${pages.length} pages`);
  const rel = 'docs/learn/how-to-use-admin-console.md';
  assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing`);
  const text = read(rel);
  assert.ok(text.includes(brand), `the article does not name the console "${brand}"`);
  assert.deepEqual(pages.filter((p) => !text.includes(`| ${p} |`)), [], 'pages missing from the article\'s page table');
  assert.doesNotMatch(read('admin-ui/README.md'), /\*\*Configuration\*\*|Configuration page/, 'admin-ui README calls Access & models "Configuration"');
});

test('T-112 troubleshooting explains the admin console and ingress messages', () => {
  const part = section(read('docs/learn/troubleshoot.md'), 'Gateway and admin console');
  assert.ok(part, 'no "Gateway and admin console" section in troubleshoot.md');
  for (const message of ['RBAC: access denied', 'AdminUi.Admin', 'Authorization_RequestDenied']) assert.ok(part.includes(message), `no row for ${message}`);
  assert.match(part, /not related to Azure role/i, 'the RBAC row says the message is about IP restrictions, not Azure roles');
});

test('T-112 the overview says where each reader starts', () => {
  const part = section(read('docs/learn/overview.md'), 'Where to start');
  assert.ok(part, 'no "Where to start" section in overview.md');
  for (const link of ['how-to-install-stage-by-stage.md', 'quickstart-developer.md', 'tutorial-deploy-network-restricted.md', 'how-to-use-admin-console.md']) {
    assert.ok(part.includes(`(${link}`), `"Where to start" does not link ${link}`);
  }
  assert.match(read('README.md'), /docs\/learn\/overview\.md#where-to-start/, 'README.md points to "Where to start"');
});

test('T-112 the install article grants every Graph permission Deploy-AdminUi.ps1 grants, and marks the placeholder range', () => {
  const script = read('admin-ui/infra/Deploy-AdminUi.ps1').split(/\r?\n/);
  const ids = script.filter((l) => !l.includes('GrantUserWrite')).flatMap((l) => [...l.matchAll(/Id = '([0-9a-f-]{36})'/g)].map((m) => m[1]));
  assert.equal(ids.length, 4, 'Deploy-AdminUi.ps1 parse');
  const install = read('docs/learn/how-to-install-stage-by-stage.md');
  const loop = install.split(/\r?\n/).find((l) => /foreach \(\$roleId in/.test(l)) ?? '';
  assert.deepEqual(ids.filter((id) => !loop.includes(id)), [], 'Graph permission IDs missing from the manual grant loop');
  // Graph takes the assignment on the resource's service principal, as Deploy-AdminUi.ps1 posts it.
  assert.ok(script.some((l) => l.includes('servicePrincipals/$graphSpId/appRoleAssignedTo')), 'Deploy-AdminUi.ps1 parse: grant URL');
  assert.ok(install.includes('servicePrincipals/$graphSpId/appRoleAssignedTo'), 'the manual grant posts to the identity, not to Microsoft Graph\'s service principal');
  for (const rel of ['docs/learn/how-to-install-stage-by-stage.md', 'README.md', 'admin-ui/README.md']) {
    assert.match(read(rel), /203\.0\.113\.0\/26[^\n]*documentation|documentation[^\n]*203\.0\.113\.0\/26/, `${rel} does not say 203.0.113.0/26 is a documentation range`);
  }
});

test('T-112 the script reference documents Deploy-AdminUi.ps1, whose parameter rows T-66 then checks', () => {
  const ref = section(read('docs/learn/reference-scripts.md'), 'Admin console script') ?? '';
  assert.match(ref, /### Deploy-AdminUi\.ps1/, 'reference-scripts.md has no "Admin console script" section for Deploy-AdminUi.ps1');
  assert.ok((ref.match(/^\| `-[A-Za-z]+` \|/gm) ?? []).length >= 10, 'the section has a parameter table');
});

test('T-66 detectors: each defect in a fixture article is reported', () => {
  const ctx = context();
  const good = '---\ntitle: T\ndescription: D\nauthor: a\nms.date: 09/28/2026\nms.topic: how-to\n---\n\n# T\n\nSee https://example.com/doc.\n';
  assert.deepEqual(articleProblems({ rel: 'docs/learn/x.md', text: good }, ctx), []);
  const yamlLines = read('config/gateway.azure-test.yaml').replace(/\n$/, '').split('\n').length;
  assert.deepEqual(articleProblems({ rel: 'docs/learn/x.md', text: `${good}\nSee config/gateway.azure-test.yaml:${yamlLines}.\n` }, ctx), [], 'the last line can be cited');
  // A message row that quotes the script's message passes; one that adds text the script does not print fails
  // (QA review, round 3), and so does a citation of a blank line in a script.
  const helper = read('scripts/developer/Get-ClaudeGatewayToken.ps1').split('\n');
  const noSession = helper.findIndex((l) => l.includes('No saved session for')) + 1;
  const blank = helper.findIndex((l, i) => i > 0 && !l.trim()) + 1;
  const brace = helper.findIndex((l) => /^\s*\}\s*$/.test(l)) + 1;
  const row = (message) => `${good}\n| Message | Source |\n|---|---|\n| \`${message}\` | scripts/developer/Get-ClaudeGatewayToken.ps1:${noSession} |\n`;
  assert.deepEqual(articleProblems({ rel: 'docs/learn/x.md', text: row('No saved session for <gateway>.') }, ctx), [], 'the message the script prints');
  const cases = [
    [row('No saved session for <gateway>. Completely invented recovery.'), /is not printed at/],
    [row('Completely invented message, for <gateway>.'), /is not printed at/],
    [`${good}\n| Message | Source |\n|---|---|\n| \`A message about something\` | scripts/developer/Missing-Script.ps1:3 |\n`, /the Source scripts\/developer\/Missing-Script\.ps1:3 names a missing file/],
    [`${good}\nSee scripts/developer/Get-ClaudeGatewayToken.ps1:${blank}.\n`, /lands only on blank lines or braces/],
    [`${good}\nSee scripts/developer/Get-ClaudeGatewayToken.ps1:${brace}.\n`, /lands only on blank lines or braces/],
    // A range starts at line 1 or later and ends at or after its start (QA review, round 4).
    [`${good}\nSee scripts/developer/Get-ClaudeGatewayToken.ps1:0.\n`, /:0 is not a line range/],
    [`${good}\nSee scripts/developer/Get-ClaudeGatewayToken.ps1:20-10.\n`, /:20-10 is not a line range/],
    [`${good}\nSee scripts/developer/Get-ClaudeGatewayToken.ps1:${helper.length + 1}-1.\n`, /is not a line range/],
    [`${good}\nSee scripts/developer/Get-ClaudeGatewayToken.ps1:1-${helper.length + 1}.\n`, /past the end/],
    [`${good}\nSee docs/TEST-PLAN.md:${read('docs/TEST-PLAN.md').split('\n').findIndex((l, i) => i > 0 && !l.trim()) + 1}.\n`, /TEST-PLAN\.md:\d+ lands only on blank lines/],
    ['# T\n\nSee https://example.com/doc.\n', /no front matter/],
    [`${good}\nSee config/gateway.azure-test.yaml:${yamlLines + 1}.\n`, /past the end/],
    [`${good}\n\`\`\`powershell\nnode scripts/set-developer.mjs --list\n\`\`\`\n`, /missing script: scripts\/set-developer\.mjs/],
    [good.replace('ms.topic: how-to', 'ms.topic: blog'), /not a Learn topic type/],
    [good.replace('ms.date: 09/28/2026', 'ms.date: 2026-09-28'), /not MM\/DD\/YYYY/],
    [good.replace('author: a\n', ''), /no author/],
    [good.replace('See https://example.com/doc.', 'No source here.'), /no citation/],
    [`${good}\n## Claims\n\nA fact without a source.\n`, /section "Claims" has no citation/],
    [`${good}\n| Message | Source |\n|---|---|\n| \`No saved session for <gateway>.\` | scripts/developer/Get-ClaudeGatewayToken.ps1:1 |\n`, /is not printed at/],
    [`${good}\nNote that this matters.\n`, /Note that/],
    [`${good}\nSee config/gateway.azure-test.yaml:9999.\n`, /past the end/],
    [`${good}\nSee docs/missing-file.md:1.\n`, /missing file/],
    [`${good}\n[x](missing.md)\n`, /link missing\.md names a missing file/],
    [`${good}\n[x](overview.md#no-such-heading)\n`, /missing heading/],
    [`${good}\n\`\`\`powershell\nnode scripts/admin/no-such-script.mjs --x\n\`\`\`\n`, /missing script/],
    [`${good}\n\`\`\`powershell\nnode scripts/admin/set-developer.mjs --user dev\n\`\`\`\n`, /does not accept --user/],
    [`${good}\n\`\`\`powershell\npowershell -NoProfile -File .\\Connect-ClaudeGateway.ps1 -GatewayUrl https://g -Browser\n\`\`\`\n`, /does not accept -Browser/],
    // An article saved with CRLF line endings is checked as the LF copy git stores and CI reads (P-34 council round 1).
    [`${good}\n\`\`\`powershell\nnode scripts/admin/no-such-script.mjs --x\n\`\`\`\n`.replace(/\n/g, '\r\n'), /missing script/],
    // admin-ui's own scripts are commands an article may show too (P-34 council round 1).
    [`${good}\n\`\`\`powershell\npwsh -File admin-ui/infra/Deploy-AdminUi.ps1 -ResourceGroup rg -Bogus x\n\`\`\`\n`, /Deploy-AdminUi\.ps1 does not accept -Bogus/],
  ];
  for (const [text, expected] of cases) {
    const found = articleProblems({ rel: 'docs/learn/x.md', text }, ctx);
    assert.ok(found.some((p) => expected.test(p)), `expected ${expected} in ${JSON.stringify(found)}`);
  }
  assert.deepEqual(articleProblems({ rel: 'docs/learn/x.md', text: `${good}\n\`\`\`powershell\npwsh -File admin-ui/infra/Deploy-AdminUi.ps1 -ResourceGroup rg -AcrName cr\n\`\`\`\n` }, ctx), [],
    'a command naming admin-ui/infra/Deploy-AdminUi.ps1 with options it accepts passes');
});

test('T-66 detectors: a message matches its Source line only with its parts in the order the script prints them', () => {
  const readLines = (rel) => (rel === 'x.ps1' ? ['throw "alpha $value omega"'] : null);
  const row = (message) => `| Message | Source |\n|---|---|\n| \`${message}\` | x.ps1:1 |\n`;
  assert.deepEqual(messageSourceProblems(row('alpha <value> omega'), readLines), []);
  assert.match(messageSourceProblems(row('omega <value> alpha'), readLines).join(), /"omega <value> alpha" is not printed at x\.ps1:1/);
  // Parts on two adjacent lines are two messages, not one (QA review, round 5).
  const twoLines = (rel) => (rel === 'x.ps1' ? ['throw "alpha one"', 'throw "two omega"'] : null);
  assert.match(messageSourceProblems(row('alpha <value> omega'), twoLines).join(), /"alpha <value> omega" is not printed at x\.ps1:1/);
});
