// Rules that keep the planning ledger verifiable: every claim cites evidence, every
// assumption names the detector that would catch it, every packet is testable.

export const STATES = ['OPEN', 'RESEARCHED', 'ASSUMED', 'RESOLVED', 'MOOT'];

const URL = /https?:\/\/[^\s)>\]|]+/;
const URLS = new RegExp(URL.source, 'g');
// A path with at least one directory, then :line — so host:port and "e.g:1" are not citations.
const PATH_LINE = /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+(?:[\w.-]*\.[A-Za-z][A-Za-z0-9]{0,11}|Dockerfile|Makefile):\d+/;
const DATE = /\b20\d\d-[01]\d-[0-3]\d\b/;
const COMMAND = /`[^`]+`/;
const UNKNOWN_ID = /^U-\d+$/;
const PACKET_ID = /^P-\d+$/;
const RISK = /Risk:\s*\S/;
// The detector names a packet or test itself; one mentioned only in the Risk text does not count.
const DETECTOR = /Detector:(?:(?!Risk:).)*?(?:\bP-\d+\b|tests\/)/;
const GIVEN_WHEN_THEN = /\bGiven\b.+\bwhen\b.+\bthen\b/i;

const hasDate = (text) => DATE.test(text.replace(URLS, ' '));
const CODE_SPANS = /`[^`]*`/g;

// A URL inside a code span is a command or a literal, not a source; a path:line in one still is.
export const hasCitation = (text) => URL.test(text.replace(CODE_SPANS, ' ')) || PATH_LINE.test(text);
export const hasDatedCommand = (text) => COMMAND.test(text) && hasDate(text);

// Lines with fenced code blanked, so line numbers stay aligned with the source.
export function withoutFences(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1][0];
    if (marker && (!fence || marker === fence)) {
      fence = fence ? null : marker;
      return '';
    }
    return fence ? '' : line;
  });
}

// GitHub-flavoured table cells: split on unescaped pipes, then unescape.
export function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const isSeparator = (line) => splitRow(line).every((cell) => /^:?-+:?$/.test(cell));
// Lines that end a table: GitHub continues a table until a blank line or the start of another block.
const ENDS_TABLE = /^\s*$|^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;

// Start and end (exclusive) line indexes of each table: a pipe row, a separator row, then rows until
// a line in ENDS_TABLE.
function tableSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !isSeparator(lines[i + 1] ?? '')) continue;
    let end = i + 2;
    while (end < lines.length && !ENDS_TABLE.test(lines[end])) end++;
    spans.push({ start: i, end });
    i = end - 1;
  }
  return spans;
}

function headingAbove(lines, index) {
  for (let i = index - 1; i >= 0; i--) {
    const h = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (h) return h[1].trim();
  }
  return '';
}

// Every table outside fenced code, with its header, data rows and the nearest heading above it.
export function tables(markdown) {
  const lines = withoutFences(markdown);
  return tableSpans(lines).map(({ start, end }) => ({
    heading: headingAbove(lines, start),
    header: splitRow(lines[start]),
    rows: lines.slice(start + 2, end).map(splitRow),
  }));
}

// Lines outside fenced code that start with a pipe but belong to no table, such as rows cut off by a
// blank line or a table without its separator row.
export function strayRows(markdown) {
  const lines = withoutFences(markdown);
  const inTable = new Set(tableSpans(lines).flatMap(({ start, end }) => Array.from({ length: end - start }, (_, k) => start + k)));
  return lines.flatMap((line, i) => (/^\s*\|/.test(line) && !inTable.has(i) ? [`line ${i + 1}: "${line.trim().slice(0, 60)}"`] : []));
}

export const tableAfterHeading = (markdown, headingRe) => tables(markdown).find((t) => headingRe.test(t.heading)) ?? null;

export function column(table, nameRe) {
  const index = table.header.findIndex((name) => nameRe.test(name));
  if (index < 0) throw new Error(`no column matching ${nameRe} in ${JSON.stringify(table.header)}`);
  return index;
}

export function shapeViolations(table) {
  return table.rows.flatMap((cells, i) => (cells.length === table.header.length
    ? []
    : [`row ${i + 1} ("${cells[0]}"): ${cells.length} cells, header has ${table.header.length}`]));
}

export function evidenceViolations(table, columnRe, accepts = hasCitation) {
  const i = column(table, columnRe);
  const missing = table.rows
    .filter((cells) => !accepts(cells[i] ?? ''))
    .map((cells) => `row "${cells[0]}": no citation in the ${table.header[i]} column`);
  return { count: table.rows.length, problems: [...shapeViolations(table), ...missing] };
}

// What each state must carry in the Source / risk column. Returns the gap, or null when satisfied.
const STATE_RULES = {
  RESEARCHED: (s) => (hasCitation(s) && hasDate(s) ? null : 'without a citation and a check date outside the URL'),
  ASSUMED: (s) => (RISK.test(s) && DETECTOR.test(s) ? null : 'without "Risk:" and a "Detector:" that names a packet or test'),
  RESOLVED: (s) => ((hasCitation(s) || COMMAND.test(s)) && hasDate(s) ? null : 'without the proving command or test and a date'),
  OPEN: (s, packet) => ([...s.matchAll(/Blocks (P-\d+)\b/g)].some((m) => m[1] === packet) ? null : `without "Blocks ${packet}"`),
};

export function unknownsViolations(markdown) {
  const table = tables(markdown).find((t) => t.header[0] === 'ID' && t.header.includes('State'));
  if (!table) return { count: 0, problems: ['no unknowns table: header must start with "ID" and include "State"'] };
  const columns = [/^ID$/, /^Packet$/, /^State$/, /^Source/].map((re) => column(table, re));
  const problems = shapeViolations(table);
  const seen = new Set();
  for (const cells of table.rows) {
    const [id, packet, state, source] = columns.map((i) => cells[i] ?? '');
    if (!UNKNOWN_ID.test(id)) problems.push(`"${id}": id is not of the form U-n`);
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
    if (!STATES.includes(state)) problems.push(`${id}: unknown state "${state}"`);
    if (!PACKET_ID.test(packet)) problems.push(`${id}: no packet named`);
    const gap = STATE_RULES[state]?.(source, packet);
    if (gap) problems.push(`${id}: ${state} ${gap}`);
  }
  return { count: table.rows.length, problems };
}

// A packet is a checkbox item "- [ ] P-n"; its body is the following lines indented deeper than the bullet.
export function roadmapViolations(markdown) {
  const packets = [];
  const problems = [];
  let current = null;
  for (const line of withoutFences(markdown)) {
    const item = /^(\s*)[-*]\s+\[[ xX]\]\s*(.*)$/.exec(line);
    if (item) {
      const id = /^(P-\d+)\b/.exec(item[2])?.[1];
      current = id ? { id, indent: item[1].length, body: [] } : null;
      if (current) packets.push(current);
      else if (/P-\d/.test(item[2])) problems.push(`malformed packet line: "${line.trim().slice(0, 60)}"`);
    } else if (current && line.trim()) {
      if (/^\s*/.exec(line)[0].length > current.indent) current.body.push(line);
      else current = null;
    }
  }
  for (const p of packets) {
    if (!p.body.some((l) => GIVEN_WHEN_THEN.test(l))) problems.push(`${p.id}: no "Given … when … then …" acceptance line`);
  }
  const deps = Object.fromEntries(packets.map((p) => {
    const line = p.body.find((l) => /Depends on:/.test(l)) ?? '';
    const listed = line.replace(/^.*?Depends on:/, '').replace(/Unknowns:.*$/, '');
    return [p.id, listed.match(/\bP-\d+\b/g) ?? []];
  }));
  return { ids: packets.map((p) => p.id), problems, deps };
}

// A packet marked done needs every packet it depends on done (QA review of P-19 and P-21, round 2).
export function dependencyGaps(roadmap) {
  const { deps } = roadmapViolations(roadmap);
  const done = new Set(donePackets(roadmap));
  return [...done].flatMap((p) => (deps[p] ?? []).filter((d) => !done.has(d)).map((d) => `${p} is done but depends on ${d}, which is not`));
}

// The packets the roadmap marks with "← ACTIVE".
export function roadmapActive(roadmap) {
  return withoutFences(roadmap).flatMap((line) => (/←\s*ACTIVE/.test(line) ? [/\b(P-\d+)\b/.exec(line)?.[1] ?? line.trim()] : []));
}
export function activePacket(statusMarkdown) {
  const m = /^\s*\*{0,2}Active packet:?\*{0,2}\s*:?\s*(P-\d+)/im.exec(statusMarkdown);
  return m ? m[1] : null;
}

// Editorialising and reader-directing phrases the docs owner asked to keep out of prose.
export const EDITORIAL = /\b(?:it is important|importantly|note that|make sure|you should|simply|obviously|crucially|key takeaway)\b/i;

export function editorialViolations(markdown) {
  return withoutFences(markdown)
    .flatMap((line, i) => (EDITORIAL.test(line) ? [`line ${i + 1}: "${line.trim().slice(0, 80)}"`] : []));
}

// IDs the ledger defines: packets in the roadmap, test cases and parity scenarios in the test plan,
// unknowns in the register.
export function definedIds({ roadmap, testPlan, unknowns }) {
  const ids = new Set(roadmapViolations(roadmap).ids);
  for (const heading of [/^Test cases$/, /^Parity scenarios/]) {
    for (const cells of tableAfterHeading(testPlan, heading)?.rows ?? []) ids.add(cells[0]);
  }
  const register = tables(unknowns).find((t) => t.header[0] === 'ID' && t.header.includes('State'));
  for (const cells of register?.rows ?? []) ids.add(cells[0]);
  return ids;
}

// References to packets, tests, parity scenarios or unknowns that no ledger document defines.
// Fenced code is included: comments in the draft config cite packets and tests as well.
export function danglingReferences(markdown, ids) {
  const found = [...markdown.matchAll(/\b(?:PS|P|T|U)-\d+\b/g)].map((m) => m[0]).filter((id) => !ids.has(id));
  return [...new Set(found)];
}

// Packets marked done ("- [x] P-n") outside fenced code.
export function donePackets(markdown) {
  return withoutFences(markdown).flatMap((line) => /^\s*[-*]\s+\[[xX]\]\s*(P-\d+)\b/.exec(line)?.[1] ?? []);
}

// A done packet needs a current PASS for every test case assigned to it (QA review, round 2). A case's
// current result is its row in the latest table under a "Results" heading that names it, by the date
// in the heading and then by document order. The PASS needs evidence, and, when the case defines a
// negative, evidence after "Negative:". Rows of one table that disagree about a case are a conflict, whatever follows.
export function evidenceGaps(roadmap, testPlan) {
  const cases = tableAfterHeading(testPlan, /^Test cases$/);
  const byPacket = {};
  const withNegative = new Set();
  if (cases) {
    const [id, packet, negative] = [/^ID$/, /^Packet$/, /^Negative\b/].map((re) => column(cases, re));
    for (const cells of cases.rows) {
      (byPacket[cells[packet]] ??= []).push(cells[id]);
      if (!/^(?:—|-)?$/.test((cells[negative] ?? '').trim())) withNegative.add(cells[id]);
    }
  }
  const resultTables = tables(testPlan)
    .map((table, order) => ({ table, order, date: /\b\d{4}-\d{2}-\d{2}\b/.exec(table.heading)?.[0] ?? '' }))
    .filter(({ table }) => /^Results\b/.test(table.heading))
    .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  const current = {};
  for (const { table } of resultTables) {
    const [id, result, evidence] = [/^ID$/, /^Result$/, /^Evidence$/].map((re) => column(table, re));
    const rows = {};
    for (const cells of table.rows) {
      for (const [caseId] of (cells[id] ?? '').matchAll(/\bT-\d+\b/g)) {
        const entry = { result: cells[result], evidence: (cells[evidence] ?? '').trim(), heading: table.heading };
        const earlier = rows[caseId];
        rows[caseId] = earlier ? { ...entry, conflict: earlier.conflict || earlier.result !== entry.result } : entry;
      }
    }
    Object.assign(current, rows);
  }
  const gap = (caseId) => {
    const r = current[caseId];
    if (!r) return 'has no result';
    if (r.conflict) return `has conflicting results under "${r.heading}"`;
    if (r.result !== 'PASS') return `is ${r.result} under "${r.heading}"`;
    if (/^(?:—|-)?$/.test(r.evidence)) return 'has a PASS without evidence';
    if (withNegative.has(caseId) && !/\bNegative:\s*\S/.test(r.evidence)) return 'has a PASS without evidence for its negative';
    return null;
  };
  return donePackets(roadmap).flatMap((p) => (byPacket[p] ?? [])
    .map((caseId) => [caseId, gap(caseId)])
    .filter(([, why]) => why)
    .map(([caseId, why]) => `${p} is done but ${caseId} ${why}`));
}