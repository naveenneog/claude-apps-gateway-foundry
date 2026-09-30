param([string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
# Mutation check for tests/ledger-rules.mjs, the Learn-article detectors in tests/learn-docs.test.mjs (T-66), and
# the ledger docs. Each mutation breaks one rule or one
# documented fact. A mutation counts as caught only when every test still loads and at least one fails.
# Files are restored byte-for-byte after each run.
# Run: pwsh -File tests/mutate-ledger.ps1
# Exit 1 when the unmutated suite fails, or when any mutation survives, does not apply, or stops the
# suite from loading.
$ErrorActionPreference = 'Stop'
Set-Location $Repo

# TAP summary lines are ASCII ("# tests 21"), so the counts parse under any console code page. Only
# tests/ledger.test.mjs and tests/learn-docs.test.mjs read the files these mutations change, so only they run.
function Invoke-Suite {
  $out = node --test --test-reporter=tap tests/ledger.test.mjs tests/learn-docs.test.mjs 2>&1 | Out-String
  $count = { param($name) $m = [regex]::Match($out, "(?m)^# $name (\d+)\s*$"); if ($m.Success) { [int]$m.Groups[1].Value } else { -1 } }
  [pscustomobject]@{ Exit = $LASTEXITCODE; Tests = & $count 'tests'; Fail = & $count 'fail' }
}

$baseline = Invoke-Suite
if ($baseline.Exit -ne 0 -or $baseline.Tests -lt 1 -or $baseline.Fail -ne 0) {
  throw "The unmutated suite must pass first: exit $($baseline.Exit), $($baseline.Tests) tests, $($baseline.Fail) failed."
}

function Test-Mutation([string]$File, [string]$Name, [scriptblock]$Mutate) {
  $full = Join-Path $Repo $File
  $bytes = [IO.File]::ReadAllBytes($full)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $mutated = & $Mutate $text
  if ($mutated -ceq $text) { return [pscustomobject]@{ target = $File; mutation = $Name; result = 'NOT APPLIED (the text must occur exactly once)' } }
  try {
    [IO.File]::WriteAllText($full, $mutated, [Text.UTF8Encoding]::new($false))
    $run = Invoke-Suite
    $result = if ($run.Tests -ne $baseline.Tests) { "BROKEN ($($run.Tests) of $($baseline.Tests) tests ran)" }
              elseif ($run.Fail -ge 1) { 'caught' }
              else { 'SURVIVED' }
    [pscustomobject]@{ target = $File; mutation = $Name; result = $result }
  } finally {
    [IO.File]::WriteAllBytes($full, $bytes)
  }
}

$R = 'tests/ledger-rules.mjs'
$LD = 'tests/learn-docs.test.mjs'
$MR = 'tests/message-rules.mjs'
$ADR = 'docs/adr/0002-pilot-claude-apps-gateway-alongside-apim.md'
# Literal replacements. Each entry is (file, name, exact single-line text, replacement).
$lit = @(
  @($MR, 'message parts not required in order', 'join(''[\\s\\S]*?'')', 'join(''|'')'),
  @($LD, 'PowerShell escaped quote not read as a quote in a source window', '.map((l) => l.replace(/''''/g, "''").replace(/`"/g, ''"''));', '.map((l) => l.replace(/''''/g, "''"));'),
  @($MR, 'PowerShell escaped quote not read as a quote in an inventory message', 'm[2].replace(/''''/g, "''").replace(/`"/g, ''"'')', 'm[2].replace(/''''/g, "''")'),
  @($LD, 'code citations on blank lines accepted', 'problems.push(...codeCitationProblems(text, readLines));', ''),
  @($LD, 'message inventory skips every message', 'm.longest.length >= 12 &&', 'm.longest.length >= 1200 &&'),
  @($LD, 'message source in a missing file accepted', 'if (!file) { problems.push(`the Source ${row.sourceCell} names a missing file`); continue; }', 'if (!file) { continue; }'),
  # Council round 4: line ranges, braces, message-part order, and coverage by rows.
  @($LD, 'citation range not checked', 'else if (first < 1 || last < first) problems.push(', 'else if (false) problems.push('),
  @($LD, 'a citation of braces counts as code', 'cited.every((l) => /^\s*[{}()[\];,]*\s*$/.test(l))', 'cited.every((l) => /^\s*$/.test(l))'),
  @($LD, 'message parts matched in any order', 'if (!inOrder || !window.some((l) => inOrder.test(l)))', 'if (!inOrder || !window.some((l) => row.message.split(/<[^>]*>/).map((s) => s.trim()).filter(Boolean).every((p) => l.includes(p))))'),
  @($LD, 'message parts read across adjacent lines', 'if (!inOrder || !window.some((l) => inOrder.test(l)))', 'if (!inOrder || !inOrder.test(window.join(''\n'')))'),
  @($LD, 'coverage accepts a row at any line', 'Math.abs(r.line - m.line) <= 1 &&', 'true &&'),
  @($LD, 'coverage accepts a row of another file', 'rows.some((r) => r.file === file && ((', 'rows.some((r) => (('),
  @($LD, 'coverage accepts another message''s row', ' && partsInOrder(r.message)?.test(m.text))', ')'),
  @($LD, 'coverage accepts a reason the row does not quote', '(wrapper !== undefined && r.message === wrapper && r.text.includes(`\`${m.text}\``))', '(wrapper !== undefined && r.message === wrapper)'),
  @($LD, 'coverage accepts any message quoted in a reason row', 'wrapper !== undefined && r.message === wrapper && r.text', 'r.message.includes(''<reason>'') && r.text'),
  @($MR, 'comment lines read as printed messages', '    if (/^\s*#/.test(line)) return;', ''),
  @($MR, 'block comments read as printed messages', '  const code = source.replace(/<#[\s\S]*?#>/g, (block) => block.replace(/[^\n]/g, '' ''));', '  const code = source;'),
  @($R, 'RESOLVED rule removed', "  RESOLVED: (s) => ((hasCitation(s) || COMMAND.test(s)) && hasDate(s) ? null : 'without the proving command or test and a date'),", ''),
  @($R, 'RESEARCHED: no date check', 'RESEARCHED: (s) => (hasCitation(s) && hasDate(s) ?', 'RESEARCHED: (s) => (hasCitation(s) ?'),
  @($R, 'RESEARCHED: no citation check', 'RESEARCHED: (s) => (hasCitation(s) && hasDate(s) ?', 'RESEARCHED: (s) => (hasDate(s) ?'),
  @($R, 'ASSUMED: no Risk check', 'ASSUMED: (s) => (RISK.test(s) && DETECTOR.test(s) ?', 'ASSUMED: (s) => (DETECTOR.test(s) ?'),
  @($R, 'fence never closes', 'fence = fence ? null : marker;', 'fence = marker;'),
  @($R, 'first data row dropped', 'rows: lines.slice(start + 2, end).map(splitRow),', 'rows: lines.slice(start + 3, end).map(splitRow),'),
  @($R, 'old Detector regex', 'const DETECTOR = /Detector:(?:(?!Risk:).)*?(?:\bP-\d+\b|tests\/)/;', 'const DETECTOR = /Detector:.*(P-\d+|tests\/)/;'),
  @($R, 'date read inside URLs', "const hasDate = (text) => DATE.test(text.replace(URLS, ' '));", 'const hasDate = (text) => DATE.test(text);'),
  @($R, 'old PATH_LINE regex', 'const PATH_LINE = /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+(?:[\w.-]*\.[A-Za-z][A-Za-z0-9]{0,11}|Dockerfile|Makefile):\d+/;', 'const PATH_LINE = /(?:[A-Za-z]:)?[\w.\\/-]+\.[A-Za-z]{1,5}:\d+/;'),
  @($R, 'split on escaped pipes', '.split(/(?<!\\)\|/)', ".split('|')"),
  @($R, 'no unknown-id check', 'if (!UNKNOWN_ID.test(id)) problems.push', 'if (false) problems.push'),
  @($R, 'packet body not bounded by indent', '.length > current.indent) current.body.push(line);', '.length >= 0) current.body.push(line);'),
  @($R, 'no malformed-packet check', 'else if (/P-\d/.test(item[2])) problems.push(', 'else if (false) problems.push('),
  @($R, 'OPEN may block any packet', 'OPEN: (s, packet) => ([...s.matchAll(/Blocks (P-\d+)\b/g)].some((m) => m[1] === packet) ?', 'OPEN: (s, packet) => (/Blocks P-\d+/.test(s) ?'),
  @($R, 'no row-shape check', '(cells.length === table.header.length', '(true'),
  @($R, 'missing column not reported', 'if (index < 0) throw new Error(', 'if (false) throw new Error('),
  @($R, 'any pipe block is a table', 'const isSeparator = (line) => splitRow(line).every((cell) => /^:?-+:?$/.test(cell));', 'const isSeparator = () => true;'),
  @($R, 'dated command needs no command', 'COMMAND.test(text) && hasDate(text)', 'hasDate(text)'),
  @($R, 'evidence accepts anything', 'accepts = hasCitation', 'accepts = () => true'),
  @($R, 'dangling references ignored', '.filter((id) => !ids.has(id))', '.filter(() => false)'),
  @($R, 'parity ids not defined', 'for (const heading of [/^Test cases$/, /^Parity scenarios/]) {', 'for (const heading of [/^Test cases$/]) {'),
  @($R, 'dependencies not read', 'return [p.id, listed.match(/\bP-\d+\b/g) ?? []];', 'return [p.id, []];'),
  @($R, 'unknowns read as dependencies', '.replace(/Unknowns:.*$/, '''')', ''),
  @($R, 'URLs in code spans cited', "URL.test(text.replace(CODE_SPANS, ' '))", 'URL.test(text)'),
  @($R, 'table ends only at a blank line', 'const ENDS_TABLE = /^\s*$|^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;', 'const ENDS_TABLE = /^\s*$/;'),
  @($R, 'rows need a leading pipe', 'while (end < lines.length && !ENDS_TABLE.test(lines[end])) end++;', 'while (end < lines.length && /^\s*\|/.test(lines[end])) end++;'),
  @($R, 'stray rows ignored', '!inTable.has(i) ?', 'false ?'),
  @($R, 'any result counts as a pass', "if (r.result !== 'PASS') return", 'if (false) return'),
  @($R, 'results read from any table', ".filter(({ table }) => /^Results\b/.test(table.heading))", '.filter(() => true)'),
  @($R, 'results ordered by position, not date', '.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);', '.sort((a, b) => a.order - b.order);'),
  @($R, 'first result wins', '    Object.assign(current, rows);', '    for (const [k, v] of Object.entries(rows)) current[k] ??= v;'),
  @($R, 'empty evidence counts', ".test(r.evidence)) return 'has a PASS without evidence';", ".test('x')) return 'has a PASS without evidence';"),
  @($R, 'negative evidence optional', 'if (withNegative.has(caseId) && !/\bNegative:\s*\S/.test(r.evidence))', 'if (false)'),
  @($R, 'negative column ignored', ".test((cells[negative] ?? '').trim())) withNegative.add(cells[id]);", ".test('')) withNegative.add(cells[id]);"),
  @($R, 'conflicts ignored', 'rows[caseId] = earlier ? { ...entry, conflict: earlier.conflict || earlier.result !== entry.result } : entry;', 'rows[caseId] = entry;'),
  @($R, 'conflict forgotten by a later row', 'conflict: earlier.conflict || earlier.result !== entry.result', 'conflict: earlier.result !== entry.result'),
  @('docs/GATEWAY-COMPARISON.md', 'comparison row loses its evidence', '| [apim:docs/MODELS.md:74-76](https://github.com/naveenneog/claude-code-foundry-gateway/blob/ea31a5fd242ee11fcb94c5ee2d2e6935d6ebcbdc/docs/MODELS.md?plain=1#L74-L76) ; [gateways](https://code.claude.com/docs/en/gateways) |', '| see the accelerator |'),
  @('docs/GATEWAY-COMPARISON.md', 'comparison editorialises', '## Summary', '## Summary

Note that route B is simply better.'),
  @('docs/GATEWAY-COMPARISON.md', 'comparison cites an unknown that does not exist', '| U-21: whether the VS Code extension', '| U-99: whether the VS Code extension'),
  @('docs/ROADMAP.md', 'packet done without its evidence', '- [ ] P-3  Gateway boots on Azure Container Apps', '- [x] P-3  Gateway boots on Azure Container Apps')
)
# Regular-expression replacements, first match only. Each entry is (file, name, pattern, replacement).
$rx = @(
  @('docs/learn/troubleshoot.md', 'the Discovery row deleted', '\| `Discovery at <url> returned HTTP <status>\.` \|[^\n]*\n', ''),
  @('docs/learn/troubleshoot.md', 'the row of the local sign-in deadline deleted', '\| `The sign-in code expired before it was confirmed \(expired_token\)\.` \| The script stopped polling[^\n]*\n', ''),
  @($R, 'tables read fenced code', 'const lines = withoutFences\(markdown\);(\r?\n\s*)return tableSpans', 'const lines = markdown.split(/\r?\n/);${1}return tableSpans'),
  @($ADR, 'ADR row loses its evidence', '\| C:\\[^|]*policy\.xml:82-124 ; https://code\.claude\.com/docs/en/claude-apps-gateway-config#http-tuning \|', '| see the policy file |'),
  @($ADR, 'blank line splits the comparison table', '(\r?\n)(\| Revocation \|)', '${1}${1}${2}'),
  @('docs/ARCHITECTURE.md', 'ARCHITECTURE command loses its date', '\| `az apim list`, `az apim show` and `az apim api list`, 2026-09-23 \|', '| `az apim list` |'),
  @('docs/UNKNOWNS.md', 'RESEARCHED U-2 loses its date', '\(checked 2026-09-23\) \|(\r?\n)\| U-3', '(checked recently) |${1}| U-3'),
  @('docs/UNKNOWNS.md', 'ASSUMED U-11 loses its detector', 'Detector: P-10 runs T-06 on the azure environment\.', 'Detector: none yet.'),
  @('docs/UNKNOWNS.md', 'bold unknown id', '\| U-23 \|', '| **U-23** |'),
  @('docs/ROADMAP.md', 'packet loses Given', 'Given a Claude Code on the Windows host that holds a gateway session token', 'With a Claude Code on the Windows host that holds a gateway session token'),
  @('docs/TEST-PLAN.md', 'case names a missing packet', '\| T-09 \| P-5 \|', '| T-09 | P-99 |'),
  @('docs/TEST-PLAN.md', 'duplicate case id', '\| T-09 \| P-5 \|', '| T-08 | P-5 |'),
  @('docs/TEST-PLAN.md', 'case loses its negative check', '\| `foundry-claudepv2` removed → the client receives the 404 \|', '| — |'),
  @('docs/STATUS.md', 'active packet not in roadmap', '\*\*Active packet:\*\* P-\d+', '**Active packet:** P-99'),
  @('docs/ARCHITECTURE.md', 'editorial phrase', 'Five routes appear in this plan\.', 'Note that five routes appear in this plan.'),
  @('docs/ROADMAP.md', 'migration no longer waits for bypass closure', 'Depends on: P-11, P-12 ', 'Depends on: P-11 '),
  @('docs/ARCHITECTURE.md', 'dangling test reference', '\(T-18\) \|', '(T-99) |'),
  @('docs/TEST-PLAN.md', 'parity scenario removed', '\| PS-11 \|[^\r\n]*(\r?\n)?', ''),
  @('docs/adr/0003-azure-test-deployment-with-restricted-ingress.md', 'ADR-0003 editorial phrase', 'It is the only option that runs', 'Importantly, it is the only option that runs'),
  @('docs/adr/0003-azure-test-deployment-with-restricted-ingress.md', 'ADR-0003 dangling unknown', '\(U-39\)\. The tester holds no directory role\.', '(U-99). The tester holds no directory role.')
)
foreach ($m in $lit + $rx) {
  if ($m.Count -ne 4) { throw "Mutation entry '$($m[1])' has $($m.Count) elements; expected 4." }
}

$hashes = { Get-ChildItem -Recurse -File tests, docs | Get-FileHash | ForEach-Object { "$($_.Path)=$($_.Hash)" } }
$before = & $hashes
$rows = @()
# A literal entry mutates the one site its text names: text that occurs twice or not at all is NOT APPLIED.
foreach ($m in $lit) { $f, $n, $a, $b = $m; $rows += Test-Mutation $f $n { param($t) $at = $t.IndexOf($a, [StringComparison]::Ordinal); if ($at -lt 0 -or $t.IndexOf($a, $at + 1, [StringComparison]::Ordinal) -ge 0) { $t } else { $t.Substring(0, $at) + $b + $t.Substring($at + $a.Length) } }.GetNewClosure() }
foreach ($m in $rx) { $f, $n, $a, $b = $m; $rows += Test-Mutation $f $n { param($t) ([regex]$a).Replace($t, $b, 1) }.GetNewClosure() }
$rows | Format-Table -AutoSize | Out-String -Width 220

$final = Invoke-Suite
$restored = -not (Compare-Object $before (& $hashes))
$expected = $lit.Count + $rx.Count
$caught = @($rows | Where-Object result -eq 'caught').Count
"$caught of $expected mutations caught; unmutated suite after restore: exit $($final.Exit), $($final.Tests) tests; files byte-identical: $restored"
if ($rows.Count -ne $expected -or $caught -ne $expected -or $final.Exit -ne 0 -or -not $restored) { exit 1 }
