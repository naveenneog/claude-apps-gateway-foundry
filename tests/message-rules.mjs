// How the tests read the messages the developer scripts print, shared by T-66 (tests/learn-docs.test.mjs) and T-54's
// START-HERE check (tests/admin-policy.test.mjs), so both compare a quoted message with what a script prints, not with
// any text in the file (QA review, round 5).

// A regular expression for a message's literal parts, the text between its <placeholders>, in order; null without parts.
export function partsInOrder(message) {
  const parts = message.split(/<[^>]*>/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? new RegExp(parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?')) : null;
}

// The messages a PowerShell script prints when something fails: throw, Write-Diagnostic and stderr lines, one per match,
// with the line it is on. Comments are not read: a line that starts with # and a <# #> block print nothing. A PowerShell
// '' is one quote and `" a quote; a leading "<script>: " prefix and the interpolated parts are not the message's text.
const MESSAGE = /(?:throw|Write-Diagnostic|\[Console\]::Error\.WriteLine\()\s*\(?\s*(["'])((?:`"|\1\1|(?!\1).)+)\1/g;
export function scriptMessages(source) {
  const found = [];
  const code = source.replace(/<#[\s\S]*?#>/g, (block) => block.replace(/[^\n]/g, ' '));
  code.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(MESSAGE)) {
      const text = m[2].replace(/''/g, "'").replace(/`"/g, '"').replace(/^[\w-]+: /, '');
      const parts = text.split(/\$(?:\([^)]*\)+|\{[^}]*\}|[\w:]+)/).map((s) => s.trim());
      found.push({ line: i + 1, text, longest: parts.sort((a, b) => b.length - a.length)[0] ?? '' });
    }
  });
  return found;
}
