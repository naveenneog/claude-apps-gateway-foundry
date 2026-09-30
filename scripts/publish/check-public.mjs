#!/usr/bin/env node
// Checks a tree before it is published as the public repository (ADR-0006, T-75). By pattern: user profile paths,
// public IPv4 addresses, Container Apps host names and e-mail addresses. By literal: each line of a deny file kept
// outside the repository, so the file publishes nothing. A value listed in scripts/publish/allow.json with a `why`
// passes; an entry without a usable `why`, or a public-ipv4 entry wider than /16, passes nothing.
// Text is read by its byte order mark, UTF-8 or UTF-16. Word files get every check on each XML part and on the text of
// each paragraph; PDF strings and PNG text chunks get every check; PDF streams and other binary files get the deny list,
// over their bytes and their inflated Flate streams. A part that is itself a ZIP, PDF or PNG is opened the same way, up
// to three containers deep. A file the readers cannot read completely, or whose parts inflate past --max-inflated-bytes
// (256 MiB by default), is an error (containers.mjs, pdf.mjs).
//   node scripts/publish/check-public.mjs [--root <dir>] [--deny-file <file>] [--max-inflated-bytes <n>]
// In a git work tree only tracked files are checked. Exit 0: no finding; 1: findings, one line each; 2: an error.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeBom, decodeXml, isPng, isZip, pngTexts, UnreadableFile, wordParagraphs, zipParts } from './containers.mjs';
import { isPdf, readPdf } from './pdf.mjs';

const ALLOW_FILE = path.join('scripts', 'publish', 'allow.json');
const WIDEST_ALLOWED_RANGE = 16;
const DEFAULT_MAX_INFLATED_BYTES = 256 * 1024 * 1024;
// A container inside a container is opened; one nested deeper than this is an error.
const MAX_DEPTH = 3;

// Address blocks that are not public: RFC 6890 special-purpose blocks, RFC 5737 documentation ranges and RFC 6598
// shared space, which Container Apps reserves for its ingress (ADR-0005).
const NOT_PUBLIC = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4'].map(parseCidr);

// Profiles of GitHub-hosted runners and shared folders; any other complete name is a person's profile.
const SHARED_PROFILES = new Set(['runner', 'runneradmin', 'runner~1', 'public', 'default', 'shared']);

// RFC 2606 example domains and reserved top-level domains, Microsoft's fictitious companies, GitHub no-reply addresses.
const EXAMPLE_MAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'contoso.com', 'fabrikam.com',
  'users.noreply.github.com'];
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);

// A path component: a profile name ends at a separator; words joined by spaces count as one name when a separator, a
// quote or the end of the line follows them, so a profile folder named "runner" plus a surname is that whole name, not
// the shared "runner".
const NAME = String.raw`[^\\/\s\`'"<>|:*?,;)\]]+`;
const PROFILE_NAME = String.raw`(?:((?:${NAME} +)+${NAME})(?=[\\/"'\`]|$)|(${NAME}))`;

const PATTERNS = {
  windowsProfile: new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:(?:\\{1,2}|/)users(?:\\{1,2}|/)${PROFILE_NAME}`, 'gi'),
  posixProfile: new RegExp(String.raw`(?<![\w.:~-])/(?:Users|home)/${PROFILE_NAME}`, 'g'),
  ipv4: /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?(?!\w|\.\d)/g,
  acaHost: /(?<![a-z0-9])((?:[a-z0-9]+-)+[0-9a-f]{8})\.([a-z0-9]+)\.azurecontainerapps\.io\b/gi,
  email: /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?![\w-])/g,
};

function parseCidr(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  return { base: octets.reduce((a, o) => ((a << 8) | o) >>> 0, 0), prefix };
}

// Prefixes here are at least 4 (NOT_PUBLIC) and at least WIDEST_ALLOWED_RANGE (allow entries), never 0.
const network = (base, prefix) => (base & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0;

// True when `outer` holds every address of `inner`.
const contains = (outer, inner) => outer.prefix <= inner.prefix
  && network(outer.base, outer.prefix) === network(inner.base, outer.prefix);

const isPublic = (address) => !NOT_PUBLIC.some((block) => contains(block, address));

function isExampleMailDomain(domain) {
  return RESERVED_TLDS.has(domain.split('.').pop()) || EXAMPLE_MAIL_DOMAINS.some((e) => domain === e || domain.endsWith(`.${e}`));
}

// Why an allow entry cannot be used, or null.
function allowProblem(entry) {
  if (typeof entry?.rule !== 'string' || typeof entry?.value !== 'string') return 'no rule or value';
  if (typeof entry.why !== 'string' || entry.why.trim() === '') return 'no why';
  if (entry.rule !== 'public-ipv4') return null;
  const range = parseCidr(entry.value);
  if (!range) return 'not an IPv4 address or range';
  return range.prefix < WIDEST_ALLOWED_RANGE ? `wider than /${WIDEST_ALLOWED_RANGE}` : null;
}

function loadAllow(root) {
  const file = path.join(root, ALLOW_FILE);
  const allow = { entries: [], ignored: [] };
  if (!fs.existsSync(file)) return allow;
  for (const entry of JSON.parse(fs.readFileSync(file, 'utf8')).allow ?? []) {
    const problem = allowProblem(entry);
    if (problem) allow.ignored.push({ entry, problem });
    else allow.entries.push(entry);
  }
  return allow;
}

function isAllowed(allow, rule, key) {
  return allow.entries.some((e) => {
    if (e.rule !== rule) return false;
    if (rule === 'public-ipv4') return contains(parseCidr(e.value), parseCidr(key));
    const value = e.value.toLowerCase();
    return value === key.toLowerCase() || (rule === 'email' && value === key.split('@').pop().toLowerCase());
  });
}

function profileFindings(line, pattern, found) {
  for (const m of line.matchAll(pattern)) {
    const name = m[1] ?? m[2];
    if (SHARED_PROFILES.has(name.toLowerCase()) || /^[$%{]/.test(name)) continue;
    found.push(['user-profile-path', m[0], name]);
  }
}

// An address is judged as written, so a numeric URL path or a /0 cannot hide a public host; with a valid prefix the value
// is a range, which an allow entry has to hold whole. Four dotted numbers after the word "version", as in
// AssemblyVersion("4.0.0.0") or "contentVersion": "1.0.0.0", are a version.
function addressFindings(line, found) {
  for (const m of line.matchAll(PATTERNS.ipv4)) {
    const address = parseCidr(m[1]);
    if (!address || !isPublic(address)) continue;
    if (/version\W{0,4}$/i.test(line.slice(Math.max(0, m.index - 16), m.index))) continue;
    const range = m[2] !== undefined && parseCidr(`${m[1]}/${m[2]}`);
    found.push(['public-ipv4', m[0], range ? `${m[1]}/${m[2]}` : m[1]]);
  }
}

function mailFindings(line, found) {
  for (const m of line.matchAll(PATTERNS.email)) {
    const domain = m[2].toLowerCase();
    if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(domain.split('.').pop())) continue; // pkg@2.1.272 is a package version
    const after = line.slice(m.index + m[0].length);
    if (m[1] === 'git' && /^:[^\s:]/.test(after)) continue; // git@host:owner/repo is an SSH remote
    if (!isExampleMailDomain(domain)) found.push(['email', m[0], m[0]]);
  }
}

// The findings in one line of text, as [rule, value, key]: the value is what the line holds, the key what an allow
// entry names; deny-listed words have no key, since no entry allows them.
function lineFindings(line, deny) {
  const found = [];
  profileFindings(line, PATTERNS.windowsProfile, found);
  profileFindings(line, PATTERNS.posixProfile, found);
  addressFindings(line, found);
  for (const m of line.matchAll(PATTERNS.acaHost)) {
    const domain = `${m[1]}.${m[2]}`.toLowerCase();
    found.push(['aca-host', domain, domain]);
  }
  mailFindings(line, found);
  const lower = line.toLowerCase();
  for (const word of deny) if (lower.includes(word)) found.push(['deny-literal', word, null]);
  return found;
}

function listFiles(root) {
  if (fs.existsSync(path.join(root, '.git'))) {
    const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(`git ls-files failed in ${root}: ${git.stderr.trim()}`);
    return git.stdout.split('\0').filter(Boolean);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && entry.name !== '.git') walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk('');
  return files.sort();
}

// Collects findings, once per place, rule and value. In a Word part the place is the part: a value found on an XML line
// and again in its paragraph counts once.
class Findings {
  constructor(deny, allow) {
    Object.assign(this, { deny, allow, list: [], seen: new Set() });
  }

  add(where, place, rule, value, binary = false) {
    const key = `${place}\0${rule}\0${value}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ where, rule, value, binary });
  }

  // `part` names a Word part whose findings count once per part; otherwise each line is its own place.
  text(scope, text, { where = (i) => `${scope}:${i + 1}`, part = false } = {}) {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [rule, value, key] of lineFindings(line, this.deny)) {
        if (key === null || !isAllowed(this.allow, rule, key)) this.add(where(i), part ? scope : where(i), rule, value);
      }
    });
  }

  bytes(file, bytes) {
    const raw = bytes.toString('latin1').toLowerCase();
    for (const word of this.deny) if (raw.includes(word)) this.add(file, file, 'deny-literal', word, true);
  }
}

function checkFile(scope, bytes, findings, limit, depth = 0) {
  const isContainer = (content, name) => isZip(content) || isPng(content) || isPdf(content, name);
  // A part that is itself a container is opened the same way, and an error names it; other parts get the deny list,
  // and a finding names the part.
  const part = (name, content) => {
    if (!isContainer(content, name)) return findings.bytes(name, content);
    if (depth === MAX_DEPTH) throw Object.assign(new UnreadableFile(`${name} is a container nested more than ${MAX_DEPTH} deep`), { nested: true });
    try {
      checkFile(name, content, findings, limit, depth + 1);
    } catch (err) {
      if (!(err instanceof UnreadableFile) || err.nested) throw err;
      throw Object.assign(new UnreadableFile(`${name}: ${err.message}`), { nested: true });
    }
  };
  const texts = (list) => {
    for (const { name, text } of list) findings.text(`${scope} ${name}`, text, { where: () => `${scope} ${name}` });
  };
  if (isZip(bytes)) {
    findings.bytes(scope, bytes);
    for (const { name, bytes: content } of zipParts(bytes, limit)) {
      const inner = `${scope}!${name}`;
      // A container is known by its bytes; only a part that is none is read as XML by its name.
      if (!/\.(?:xml|rels)$/i.test(name) || isContainer(content, inner)) {
        part(inner, content);
        continue;
      }
      const xml = decodeBom(content) ?? content.toString('utf8');
      const word = /^word\/.*\.xml$/i.test(name);
      findings.text(inner, decodeXml(xml), { part: word });
      if (word) {
        findings.text(inner, wordParagraphs(xml).map(decodeXml).join('\n'), { where: (i) => `${inner} paragraph ${i + 1}`, part: true });
      }
    }
    return;
  }
  if (isPng(bytes)) {
    findings.bytes(scope, bytes);
    texts(pngTexts(bytes, limit));
    return;
  }
  // A PDF adds its streams and strings to the checks; it does not replace them, since text can mention a PDF header.
  if (isPdf(bytes, scope)) {
    const { streams, strings } = readPdf(bytes, limit);
    for (const stream of streams) part(`${scope} ${stream.name}`, stream.bytes);
    texts(strings);
  }
  const text = decodeBom(bytes);
  if (text !== null) findings.text(scope, text);
  else if (bytes.subarray(0, 8000).includes(0)) findings.bytes(scope, bytes); // git's binary test
  else findings.text(scope, bytes.toString('utf8'));
}

function checkTree(root, deny, limit) {
  const findings = new Findings(deny, loadAllow(root));
  const files = listFiles(root);
  for (const file of files) {
    const full = path.join(root, ...file.split('/'));
    if (!fs.existsSync(full)) continue;
    try {
      checkFile(file, fs.readFileSync(full), findings, limit);
    } catch (err) {
      if (err instanceof UnreadableFile) throw new Error(`${file} cannot be read completely: ${err.message}`);
      throw err;
    }
  }
  return { files: files.length, findings: findings.list, ignoredAllows: findings.allow.ignored };
}

function readDeny(file) {
  if (!file) return [];
  const bytes = fs.readFileSync(file);
  return (decodeBom(bytes) ?? bytes.toString('utf8')).split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());
}

function main(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: { root: { type: 'string' }, 'deny-file': { type: 'string' }, 'max-inflated-bytes': { type: 'string' } },
  });
  const root = path.resolve(options.root ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`--root ${root} is not a directory`);
  const limit = options['max-inflated-bytes'] === undefined ? DEFAULT_MAX_INFLATED_BYTES : Number(options['max-inflated-bytes']);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--max-inflated-bytes takes a positive whole number');
  let deny;
  try {
    deny = readDeny(options['deny-file']);
  } catch (err) {
    throw new Error(`cannot read the deny file: ${err.message}`);
  }
  const result = checkTree(root, deny, limit);
  for (const { entry, problem } of result.ignoredAllows) {
    console.log(`warning: allow entry ignored, ${problem}: ${entry?.rule} ${entry?.value}`);
  }
  for (const f of result.findings) console.log(`${f.where}: ${f.rule}: ${f.value}${f.binary ? ' (binary file)' : ''}`);
  const n = result.findings.length;
  console.log(`${result.files} file${result.files === 1 ? '' : 's'} checked, ${n} finding${n === 1 ? '' : 's'}`);
  return n === 0 ? 0 : 1;
}

// Every error, a bad option or an unreadable file included, exits 2, so a caller can tell it from a finding.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`check-public: ${err.message}`);
    process.exitCode = 2;
  }
}
