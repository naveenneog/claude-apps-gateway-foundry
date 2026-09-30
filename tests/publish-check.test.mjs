// T-75: scripts/publish/check-public.mjs, the check a tree passes before it is published (ADR-0006).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'publish', 'check-public.mjs');

// Planted values are joined at run time, so this file holds none of them whole and passes the check itself.
const planted = (...parts) => parts.join('');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-publish-'));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

function check(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function denyFile(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-deny-')), 'deny.txt');
  fs.writeFileSync(file, content);
  return file;
}

const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text) => utf16le(text).swap16();
const allowFile = (entries) => JSON.stringify({ allow: entries });

// A minimal ZIP writer: each entry is [name, content, method], method 'store', 'deflate' or a raw method number.
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, method] of entries) {
    const raw = Buffer.from(content);
    const code = method === 'store' ? 0 : method === 'deflate' ? 8 : method;
    const data = code === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(code, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(code, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// A PDF whose objects each hold one stream; `headerLines` ASCII comment lines push the first binary byte past 8000.
// A stream may carry `extra` dictionary entries and a `length` other than its data's.
function pdf(streams, headerLines = 0) {
  const parts = [Buffer.from(`%PDF-1.7\n${`%${'x'.repeat(100)}\n`.repeat(headerLines)}`)];
  streams.forEach(({ data, filter, extra = '', length = data.length }, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${length}${filter ? ` /Filter ${filter}` : ''}${extra} >>\nstream\n`));
    parts.push(data, Buffer.from('\nendstream\nendobj\n'));
  });
  parts.push(Buffer.from('%%EOF\n'));
  return Buffer.concat(parts);
}

// A PDF of objects without streams, each given by its body; `prefix` comes before the header, `trailer` before %%EOF.
function pdfOf(bodies, { prefix = '', trailer = '' } = {}) {
  const objects = bodies.map((body, i) => `${i + 1} 0 obj\n${body}\nendobj\n`).join('');
  return Buffer.concat([Buffer.from(prefix), Buffer.from(`%PDF-1.7\n${objects}${trailer}%%EOF\n`, 'latin1')]);
}

// A one-pixel PNG with the given [type, data] chunks after its header chunk; `after` follows the IEND chunk.
function png(chunks, after = Buffer.alloc(0)) {
  const chunk = ([type, data]) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length - 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = ['IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])];
  const image = ['IDAT', zlib.deflateSync(Buffer.from([0, 0]))];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...[header, ...chunks, image, ['IEND', '']].map(chunk), after]);
}

const hexOf = (text) => Buffer.from(text, 'latin1').toString('hex');

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

// A zlib stream whose first block is stored, holding `stored` byte for byte, and whose last block is compressed.
function zlibStoredThenCompressed(stored, compressed) {
  const s = Buffer.from(stored);
  const header = Buffer.alloc(5);
  header.writeUInt16LE(s.length, 1);
  header.writeUInt16LE(~s.length & 0xffff, 3);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(adler32(Buffer.concat([s, Buffer.from(compressed)])));
  return Buffer.concat([Buffer.from([0x78, 0x01]), header, s, zlib.deflateRawSync(Buffer.from(compressed)), check]);
}

test('the tracked files of this repository pass', () => {
  const r = check(ROOT);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\b0 findings\b/);
});

test('a planted value fails the check, naming the file, the line and the rule', () => {
  const cases = [
    ['a Windows user profile', planted('line one\nclone into C:\\Us', 'ers\\alice\\repo\n'), 2, 'user-profile-path'],
    ['a JSON-escaped Windows user profile', planted('{"dir": "c:\\\\us', 'ers\\\\alice\\\\x"}\n'), 1, 'user-profile-path'],
    ['a profile name with a space', planted('"C:\\Us', 'ers\\Shared Kumar\\Work"\n'), 1, 'user-profile-path'],
    ['a profile name with a space, ending a quoted path', planted('cd "C:\\Us', 'ers\\Shared Kumar"\n'), 1, 'user-profile-path'],
    ['a profile name with a space, ending the line', planted('home is C:\\Us', 'ers\\Shared Kumar\n'), 1, 'user-profile-path'],
    ['a profile name with two spaces', planted('"C:\\Us', 'ers\\runner  alice\\repo"\n'), 1, 'user-profile-path'],
    ['a macOS profile name with a space, ending a quoted path', planted('cd "/Us', 'ers/Shared Kumar"\n'), 1, 'user-profile-path'],
    ['a shared profile name that goes on', planted('"C:\\Us', 'ers\\runner alice\\repo"\n'), 1, 'user-profile-path'],
    ['a macOS user profile', planted('x\ny\nsee /Us', 'ers/bob/code\n'), 3, 'user-profile-path'],
    ['a macOS user profile in a file URI', planted('open file:///Us', 'ers/alice/Work\n'), 1, 'user-profile-path'],
    ['a Linux home folder', planted('cd /ho', 'me/carol/src\n'), 1, 'user-profile-path'],
    ['a public address', planted('reached from 52.1.', '2.3 today\n'), 1, 'public-ipv4'],
    ['a public range', planted('allow 8.8.', '8.0/24 only\n'), 1, 'public-ipv4'],
    ['a public URL host with a numeric path', planted('GET https://52.1.', '2.3/33\n'), 1, 'public-ipv4'],
    ['a public URL host with the path /0', planted('GET https://52.1.', '2.3/0\n'), 1, 'public-ipv4'],
    ['a Container Apps host', planted('open https://app.happyfield-1a2b3c4d.', 'westus2.azurecontainerapps.io/login\n'), 1, 'aca-host'],
    ['a Container Apps environment domain', planted('the domain happyfield-1a2b3c4d.', 'westus2.azurecontainerapps.io\n'), 1, 'aca-host'],
    ['an e-mail address', planted('mail alice', '@northwind.io for access\n'), 1, 'email'],
    ['an e-mail address at a punycode domain', planted('mail alice', '@northwind.xn--p1ai\n'), 1, 'email'],
    ['an e-mail address whose domain extends an example domain', planted('mail alice', '@example.com.xn--p1ai\n'), 1, 'email'],
    ['an address of a git user followed by prose', planted('Contact git', '@northwind.io: repository support.\n'), 1, 'email'],
    ['a public address in text that mentions a PDF header', planted('// Recognizes %PDF-1.7 files\nconst address = "52.1.', '2.3"; // a) by name, b) by header\n'), 2, 'public-ipv4'],
  ];
  for (const [what, body, line, rule] of cases) {
    const r = check(tree({ 'docs/planted.md': body }));
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, new RegExp(`docs/planted\\.md:${line}: ${rule}\\b`), what);
  }
});

test('deny-listed text fails in text, binary and UTF-16 files, whatever its letter case and the deny file encoding', () => {
  const dir = tree({
    'docs/a.md': 'first\nwritten by ZebraCorn\n',
    'media/b.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), Buffer.from('xx zebracorn xx')]),
    'policy/le.reg': utf16le('Windows Registry Editor Version 5.00\r\n"Owner"="ZEBRACORN"\r\n'),
    'policy/be.reg': utf16be('Windows Registry Editor Version 5.00\r\n"Owner"="zebracorn"\r\n'),
    'docs/clean.md': 'nothing here\n',
  });
  const denies = [
    ['UTF-8 with a byte order mark', denyFile('\uFEFFzebracorn\n# words kept out of the public copy\n')],
    ['UTF-16 with a byte order mark', denyFile(utf16le('zebracorn\r\n# words kept out of the public copy\r\n'))],
  ];
  for (const [what, deny] of denies) {
    const r = check(dir, '--deny-file', deny);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /docs\/a\.md:2: deny-literal\b/, what);
    assert.match(r.out, /media\/b\.png: deny-literal\b.*binary/, what);
    assert.match(r.out, /policy\/le\.reg:2: deny-literal\b/, what);
    assert.match(r.out, /policy\/be\.reg:2: deny-literal\b/, what);
    assert.doesNotMatch(r.out, /clean\.md/, what);
    assert.match(r.out, /\b4 findings\b/, what);
  }
});

test('a UTF-16 file is recognised by its byte order mark, not by NUL bytes', () => {
  const body = `${'\u4e2d'.repeat(4100)}\n${planted('host 52.1.', '2.3')}\n`;
  const r = check(tree({ 'docs/wide.txt': utf16le(body), 'docs/wide-be.txt': utf16be(body) }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs\/wide\.txt:2: public-ipv4\b/);
  assert.match(r.out, /docs\/wide-be\.txt:2: public-ipv4\b/);
});

test('the parts of a Word file are checked, its text as a reader sees it', () => {
  const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const paragraph = (...runs) => `<w:p>${runs.map(run).join('')}</w:p>`;
  const xml = [
    paragraph('mail alice', planted('&#64;north', 'wind.io')),
    paragraph('clone into C:\\Us', planted('ers\\alice', '\\Work')),
    paragraph('written by Zebra', 'Corn'),
    paragraph(planted('host 52&#46;1&#x2e;', '2&#46;3')),
    paragraph('mail bob', planted('@north', 'wind.io')),
    paragraph('placeholder C:\\Us', 'ers\\&lt;user&gt;\\x'),
  ].join('');
  const docx = zip([['[Content_Types].xml', '<Types/>', 'store'], ['word/document.xml', xml, 'deflate'], ['word/media/a.png', 'png', 'store']]);
  const r = check(tree({ 'export/guide.docx': docx }), '--deny-file', denyFile('zebracorn\n'));
  assert.equal(r.code, 1, r.out);
  for (const rule of ['email', 'user-profile-path', 'deny-literal', 'public-ipv4']) {
    assert.match(r.out, new RegExp(`export/guide\\.docx!word/document\\.xml(?::\\d+| paragraph \\d+): ${rule}\\b`), rule);
  }
  assert.equal((r.out.match(/: email: /g) ?? []).length, 2, 'both split addresses');
  assert.doesNotMatch(r.out, /&lt;user|<user>/, 'an XML-escaped placeholder is no profile');
  assert.match(r.out, /\b5 findings\b/);
});

test('a ZIP container the checker cannot read completely is an error, not a pass', () => {
  const good = zip([['word/document.xml', '<w:t>x</w:t>', 'deflate']]);
  const end = good.length - 22;
  const zip64 = Buffer.from(good);
  zip64.writeUInt16LE(0xffff, end + 8);
  zip64.writeUInt16LE(0xffff, end + 10);
  const damaged = Buffer.from(good);
  damaged.writeUInt32LE(0x12345678, good.readUInt32LE(end + 16));
  const zeroCounts = Buffer.from(good);
  zeroCounts.writeUInt16LE(0, end + 8);
  zeroCounts.writeUInt16LE(0, end + 10);
  const two = zip([['word/a.xml', '<w:t>clean</w:t>', 'deflate'], ['word/b.xml', '<w:t>zebracorn</w:t>', 'deflate']]);
  const understated = Buffer.from(two);
  understated.writeUInt16LE(1, two.length - 22 + 8);
  understated.writeUInt16LE(1, two.length - 22 + 10);
  const cases = [
    ['no end record', good.subarray(0, end)],
    ['compression method 12', zip([['word/document.xml', '<w:t>x</w:t>', 12]])],
    ['ZIP64 entry counts', zip64],
    ['a damaged directory entry', damaged],
    ['entry counts of zero over a directory that holds an entry', zeroCounts],
    ['an entry count below the entries the directory holds', understated],
  ];
  for (const [what, bytes] of cases) {
    const r = check(tree({ 'export/guide.docx': bytes }));
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /export\/guide\.docx cannot be read completely/, what);
  }
});

test('a PDF stream is inflated from its start, and a declared Flate stream that does not inflate is an error', () => {
  const deny = denyFile('zebracorn\n');
  const inner = pdf([{ data: zlibStoredThenCompressed('abc endstream def ', 'written by zebracorn'), filter: '/FlateDecode' }]);
  const late = pdf([{ data: zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET')), filter: '/FlateDecode' }], 82);
  for (const bytes of [inner, late]) assert.equal(bytes.includes(Buffer.from('zebracorn')), false, 'only inflation reveals the word');
  const r = check(tree({ 'export/inner.pdf': inner, 'export/late.pdf': late }), '--deny-file', deny);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /export\/inner\.pdf stream at byte \d+: deny-literal\b/);
  assert.match(r.out, /export\/late\.pdf stream at byte \d+: deny-literal\b/);
  const flate = zlib.deflateSync(Buffer.from('BT (fine) Tj ET'));
  const truncated = check(tree({ 'export/c.pdf': pdf([{ data: flate.subarray(0, flate.length - 3), filter: '/FlateDecode' }]) }), '--deny-file', deny);
  assert.equal(truncated.code, 2, truncated.out);
  assert.match(truncated.out, /export\/c\.pdf cannot be read completely: .*does not inflate/);
  const jpeg = check(tree({ 'export/d.pdf': pdf([{ data: Buffer.from('not Flate data'), filter: '/DCTDecode' }]) }), '--deny-file', deny);
  assert.equal(jpeg.code, 0, jpeg.out);
});

test('a PDF filter is read as PDF names are written, and a stream whose filters the checker cannot decode is an error', () => {
  const deny = denyFile('zebracorn\n');
  const text = zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET'));
  const escaped = check(tree({ 'export/escaped.pdf': pdf([{ data: text, filter: '/FlateDe#63ode' }]) }), '--deny-file', deny);
  assert.equal(escaped.code, 1, escaped.out);
  assert.match(escaped.out, /export\/escaped\.pdf stream at byte \d+: deny-literal\b/);
  for (const [what, filter] of [['LZW', '/LZWDecode'], ['a filter chain', '[/ASCII85Decode /FlateDecode]'], ['an indirect filter', '5 0 R']]) {
    const r = check(tree({ 'export/other.pdf': pdf([{ data: text, filter }]) }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /export\/other\.pdf cannot be read completely: .*filter/, what);
  }
  for (const [what, parms] of [['a TIFF predictor', '<< /Predictor 2 /Columns 20 >>'], ['a PNG predictor', '<< /Predictor 12 /Columns 20 >>'], ['indirect parameters', '5 0 R']]) {
    const r = check(tree({ 'export/other.pdf': pdf([{ data: text, filter: '/FlateDecode', extra: ` /DecodeParms ${parms}` }]) }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /export\/other\.pdf cannot be read completely: .*(predictor|DecodeParms)/, what);
  }
  const plain = check(tree({ 'export/plain.pdf': pdf([{ data: text, filter: '/FlateDecode', extra: ' /DecodeParms << /Predictor 1 >>' }]) }), '--deny-file', deny);
  assert.equal(plain.code, 1, `predictor 1 is no prediction: ${plain.out}`);
});

test('a PDF stream is found whatever its dictionary holds, and a declared length that does not end the stream is an error', () => {
  const deny = denyFile('zebracorn\n');
  const text = zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET'));
  const clean = zlib.deflateSync(Buffer.from('BT (fine) Tj ET'));
  const found = [
    ['a dictionary longer than 8 KiB', pdf([{ data: text, filter: '/FlateDecode', extra: ` /Pad (${'x'.repeat(9000)})` }])],
    ['a comment between /Filter and its value', pdf([{ data: text, filter: '% the filter\n/FlateDecode' }])],
    ['a nested dictionary with its own filter', pdf([{ data: text, filter: '/FlateDecode', extra: ' /Note << /Filter /DCTDecode >>' }])],
    ['bytes before the header of a binary file', Buffer.concat([Buffer.from([0, 1, 2, 3]), pdf([{ data: text, filter: '/FlateDecode' }])])],
  ];
  for (const [what, bytes] of found) {
    const r = check(tree({ 'export/a.pdf': bytes }), '--deny-file', deny);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /export\/a\.pdf stream at byte \d+: deny-literal\b/, what);
  }
  // A prefix that opens a string no longer swallows the document: tokens start at the header, and the stray ")" that
  // closed the string after the document is a construct the tokenizer refuses.
  const enclosed = check(tree({ 'export/a.pdf': Buffer.concat([Buffer.from([0, 0x28]), pdf([{ data: text, filter: '/FlateDecode' }]), Buffer.from(')')]) }), '--deny-file', deny);
  assert.equal(enclosed.code, 2, enclosed.out);
  assert.match(enclosed.out, /export\/a\.pdf cannot be read completely: an unexpected \)/);
  const lying = check(tree({ 'export/a.pdf': pdf([{ data: clean, filter: '/FlateDecode', length: 9999999 }, { data: text, filter: '/FlateDecode' }]) }), '--deny-file', deny);
  assert.equal(lying.code, 2, lying.out);
  assert.match(lying.out, /export\/a\.pdf cannot be read completely: .*Length/);
});

test('a PDF /Length is checked against the data: one that spans another object is an error, an indirect one is resolved', () => {
  const deny = denyFile('zebracorn\n');
  const clean = zlib.deflateSync(Buffer.from('BT (clean) Tj ET'));
  const secret = zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET'));
  const middle = `\nendstream\nendobj\n2 0 obj\n<< /Length ${secret.length} /Filter /FlateDecode >>\nstream\n`;
  const spanning = String(clean.length + middle.length + secret.length).padStart(8, ' ');
  const overlapping = Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${spanning} /Filter /FlateDecode >>\nstream\n`), clean, Buffer.from(middle), secret,
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
  const spans = check(tree({ 'export/a.pdf': overlapping }), '--deny-file', deny);
  assert.equal(spans.code, 2, spans.out);
  assert.match(spans.out, /export\/a\.pdf cannot be read completely: .*Length/);
  // An image stream is skipped, not inflated, so only the rule on object headers stops its length from hiding the next
  // object, whatever separates endstream from endobj.
  for (const [what, separator] of [['a new line', '\n'], ['a comment', ' % end of image\n'], ['a NUL byte', '\0']]) {
    const between = `\nendstream${separator}endobj\n2 0 obj\n<< /Length ${secret.length} /Filter /FlateDecode >>\nstream\n`;
    const length = String(clean.length + between.length + secret.length).padStart(8, ' ');
    const image = Buffer.concat([
      Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${length} /Filter /DCTDecode >>\nstream\n`), clean, Buffer.from(between), secret,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ]);
    const r = check(tree({ 'export/a.pdf': image }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /export\/a\.pdf cannot be read completely: the object header at byte \d+ is not one the checker read/, what);
  }
  // Data after the end of the Flate data is read by no inflater, so it is an error rather than bytes nobody checked.
  const trailing = check(tree({ 'export/a.pdf': pdf([{ data: Buffer.concat([clean, secret]), filter: '/FlateDecode' }]) }), '--deny-file', deny);
  assert.equal(trailing.code, 2, trailing.out);
  assert.match(trailing.out, /export\/a\.pdf cannot be read completely: .*Flate data ends/);

  const data = zlibStoredThenCompressed('abc endstream def ', 'written by zebracorn');
  const indirect = (ref, objects) => Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${ref} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from(`\nendstream\nendobj\n${objects}%%EOF\n`),
  ]);
  const resolved = check(tree({ 'export/a.pdf': indirect('6 0 R', `6 0 obj\n${data.length}\nendobj\n`) }), '--deny-file', deny);
  assert.equal(resolved.code, 1, resolved.out);
  assert.match(resolved.out, /export\/a\.pdf stream at byte \d+: deny-literal\b/);
  // Both values end the stream at endstream, so a checker that took either definition would read the stream and pass it.
  for (const [what, ref, objects] of [['a missing object', '7 0 R', ''], ['two objects of the number', '6 0 R', `6 0 obj\n${data.length}\nendobj\n6 0 obj\n${data.length + 1}\nendobj\n`]]) {
    const r = check(tree({ 'export/a.pdf': indirect(ref, objects) }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /cannot be read completely: .*Length/, what);
  }
});

test('an object header the checker did not read is an error, wherever it lies and however it is written', () => {
  const deny = denyFile('zebracorn\n');
  const text = zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET'));
  const object = (n) => Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${text.length} /Filter /FlateDecode >>\nstream\n`), text, Buffer.from('\nendstream\nendobj\n')]);
  const cases = [
    ['in a string', pdfOf(['<< /Note (1 0 obj) >>'])],
    ['in a string, split by what reads as a comment', pdfOf(['<< /Note (9 0 %c\nobj) >>'])],
    ['in a comment', pdfOf(['<< >>'], { trailer: '% 9 0 obj\n' })],
    ['with signed numbers', pdfOf(['<< >>'], { trailer: '% +9 -0 obj\n' })],
    ['with repeated signs, as MuPDF reads them', pdfOf(['<< >>'], { trailer: '% 9 --0 obj\n' })],
    ['with a minus sign inside a number, as MuPDF reads it', pdfOf(['<< >>'], { trailer: '% 9 0-5 obj\n' })],
    ['with NUL bytes between its parts', pdfOf(['<< >>'], { trailer: '% 9\u00000\u0000obj\n' })],
    ['with vertical tabs between its parts', pdfOf(['<< >>'], { trailer: '% 9\u000b0\u000bobj\n' })],
    ['with no-break spaces between its parts', pdfOf(['<< >>'], { trailer: '% 9\u00a00\u00a0obj\n' })],
    ['in an object before the header', Buffer.concat([object(9), pdfOf(['<< >>'])])],
  ];
  for (const [what, bytes] of cases) {
    assert.equal(bytes.includes(Buffer.from('zebracorn')), false, what);
    const r = check(tree({ 'export/a.pdf': bytes }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /export\/a\.pdf cannot be read completely: the object header at byte \d+ is not one the checker read/, what);
  }
  const read = check(tree({ 'export/a.pdf': Buffer.concat([pdfOf(['<< >>']).subarray(0, -6), object(9), Buffer.from('%%EOF\n')]) }), '--deny-file', deny);
  assert.equal(read.code, 1, `the same object after the header is read: ${read.out}`);
});

test('long runs of digits, spaces and comments in a PDF are read in linear time', () => {
  const n = 1 << 21;
  const dir = tree({
    'export/digits.pdf': `%PDF-1.7\n${'7'.repeat(n)}\n%%EOF\n`,
    'export/numbers-then-comment.pdf': `%PDF-1.7\n1 2 %${' '.repeat(n)}x\n%%EOF\n`,
    'export/object-then-comment.pdf': `%PDF-1.7\n1 0 obj %${' '.repeat(n)}x\n<< >>\nendobj\n%%EOF\n`,
  });
  const started = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.error, undefined, `the check ran for ${Date.now() - started} ms and was stopped`);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('a PDF is known by its name, or by a header in its first 1024 bytes and an object header, whatever its encoding', () => {
  const deny = denyFile('zebracorn\n');
  // ASCII only, so valid UTF-8 text, with the header after a new line: a reader opens it as a PDF.
  const ascii = `\n%PDF-1.7\n1 0 obj\n<< /Length 20 /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n${'!'.repeat(20)}\nendstream\nendobj\n%%EOF\n`;
  const r = check(tree({ 'docs/guide.txt': ascii }), '--deny-file', deny);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /docs\/guide\.txt cannot be read completely: the stream at byte \d+ uses the filter ASCII85Decode FlateDecode/);
  const late = Buffer.concat([Buffer.from(`${'x'.repeat(1100)}\n`), pdf([{ data: zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET')), filter: '/FlateDecode' }])]);
  const named = check(tree({ 'export/late.pdf': late }), '--deny-file', deny);
  assert.equal(named.code, 1, `a file named .pdf is read as one wherever its header is: ${named.out}`);
  assert.match(named.out, /export\/late\.pdf stream at byte \d+: deny-literal\b/);
});

test('PDF strings and escaped names are read as a reader shows them', () => {
  const deny = denyFile('zebracorn\n');
  const utf16 = (text) => `FEFF${Buffer.from(text, 'utf16le').swap16().toString('hex')}`;
  const cases = [
    ['an octal escape', '<< /Author (written by zebr\\141corn) >>', 'string'],
    ['an escaped end of line', '<< /Author (written by zebra\\\ncorn) >>', 'string'],
    ['hexadecimal digits with white space', `<< /Author <${hexOf('written by zebra')} ${hexOf('corn')}> >>`, 'string'],
    ['UTF-16 after a byte order mark', `<< /Title <${utf16('zebracorn')}> >>`, 'string'],
    ['an escaped name', '<< /zebr#61corn (x) >>', 'name'],
  ];
  for (const [what, body, kind] of cases) {
    const bytes = pdfOf([body]);
    assert.equal(bytes.toString('latin1').toLowerCase().includes('zebracorn'), false, `${what}: only decoding reveals the word`);
    const r = check(tree({ 'export/a.pdf': bytes }), '--deny-file', deny);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, new RegExp(`export/a\\.pdf ${kind} at byte \\d+: deny-literal: zebracorn`), what);
  }
  const trailer = check(tree({ 'export/a.pdf': pdfOf(['<< >>'], { trailer: `trailer\n<< /Size 2 /Info <${hexOf('zebracorn')}> >>\n` }) }), '--deny-file', deny);
  assert.equal(trailer.code, 1, `a trailer's string: ${trailer.out}`);
  const mail = check(tree({ 'export/a.pdf': pdfOf([`<< /URI <${hexOf(planted('mailto:alice', '@northwind.io'))}> >>`]) }));
  assert.equal(mail.code, 1, mail.out);
  assert.match(mail.out, /export\/a\.pdf string at byte \d+: email\b/, 'the patterns apply to decoded strings');
  const bad = check(tree({ 'export/a.pdf': pdfOf(['<< /Author <7a6g> >>']) }), '--deny-file', deny);
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /export\/a\.pdf cannot be read completely: the PDF hexadecimal string at byte \d+ holds a character/);
});

test('object streams, cross-reference streams and encrypted PDFs are errors', () => {
  const deny = denyFile('zebracorn\n');
  const objects = zlib.deflateSync(Buffer.from(`1 0 <${hexOf('zebracorn')}>`));
  const cases = [
    ['an object stream', pdf([{ data: objects, filter: '/FlateDecode', extra: ' /Type /ObjStm /N 1 /First 4' }]), /is an object stream/],
    ['an object stream whose type is an escaped name', pdf([{ data: objects, filter: '/FlateDecode', extra: ' /Type /Obj#53tm /N 1 /First 4' }]), /is an object stream/],
    ['a cross-reference stream', pdf([{ data: zlib.deflateSync(Buffer.alloc(8)), filter: '/FlateDecode', extra: ' /Type /XRef /W [1 2 1] /Size 2' }]), /is a cross-reference stream/],
    ['a stream type given indirectly', pdf([{ data: objects, filter: '/FlateDecode', extra: ' /Type 5 0 R' }]), /gives its \/Type indirectly/],
    ['an encrypted file', pdfOf(['<< /Author (x) >>'], { trailer: 'trailer\n<< /Size 2 /Encrypt 5 0 R >>\n' }), /the PDF is encrypted/],
  ];
  for (const [what, bytes, reason] of cases) {
    const r = check(tree({ 'export/a.pdf': bytes }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /export\/a\.pdf cannot be read completely: /, what);
    assert.match(r.out, reason, what);
  }
});

test('the text chunks of a PNG are read, compressed or not, and a PNG the checker cannot read completely is an error', () => {
  const deny = denyFile('zebracorn\n');
  const word = Buffer.from('written by zebracorn');
  const compressed = [
    ['zTXt', png([['zTXt', Buffer.concat([Buffer.from('Comment\0\0'), zlib.deflateSync(word)])]])],
    ['iTXt', png([['iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\u0001\0en\0\0', 'latin1'), zlib.deflateSync(word)])]])],
  ];
  for (const [type, bytes] of compressed) {
    assert.equal(bytes.includes(Buffer.from('zebracorn')), false, `${type}: only inflation reveals the word`);
    const r = check(tree({ 'media/a.png': bytes }), '--deny-file', deny);
    assert.equal(r.code, 1, `${type}: ${r.out}`);
    assert.match(r.out, new RegExp(`media/a\\.png ${type} chunk at byte \\d+: deny-literal\\b`), type);
  }
  const plain = check(tree({ 'media/a.png': png([['tEXt', planted('Source\0C:\\Us', 'ers\\alice\\shot.png')], ['iTXt', planted('Author\0\0\0\0\0mail alice', '@northwind.io')]]) }));
  assert.equal(plain.code, 1, plain.out);
  assert.match(plain.out, /media\/a\.png tEXt chunk at byte \d+: user-profile-path\b/);
  assert.match(plain.out, /media\/a\.png iTXt chunk at byte \d+: email\b/);
  assert.equal(check(tree({ 'media/a.png': png([['pHYs', Buffer.alloc(9)], ['tIME', Buffer.alloc(7)]]) })).code, 0, 'plain chunks pass');
  const unreadable = [
    ['a chunk the checker does not know', png([['prVt', zlib.deflateSync(word)]]), /the PNG chunk prVt at byte \d+ is not one the checker reads/],
    ['data after IEND', png([], zlib.deflateSync(word)), /the PNG holds \d+ bytes after its IEND chunk/],
    ['a chunk cut short', png([]).subarray(0, 40), /the PNG chunk at byte 33 is cut short/],
    ['data after the compressed text', png([['zTXt', Buffer.concat([Buffer.from('Comment\0\0'), zlib.deflateSync(Buffer.from('fine')), zlib.deflateSync(word)])]]), /holds data after its compressed text/],
  ];
  for (const [what, bytes, reason] of unreadable) {
    const r = check(tree({ 'media/a.png': bytes }), '--deny-file', deny);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, /media\/a\.png cannot be read completely: /, what);
    assert.match(r.out, reason, what);
  }
});

test('a deny-listed word in a part of a container is reported with the part that holds it', () => {
  const deny = denyFile('zebracorn\n');
  const cases = [
    ['a deflated ZIP member', 'export/pack.zip', zip([['notes/a.txt', 'written by zebracorn', 'deflate']]), /^export\/pack\.zip!notes\/a\.txt: deny-literal: zebracorn\b/m],
    ['a PDF Flate stream', 'export/a.pdf', pdf([{ data: zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET')), filter: '/FlateDecode' }]), /^export\/a\.pdf stream at byte \d+: deny-literal: zebracorn\b/m],
  ];
  for (const [what, name, bytes, where] of cases) {
    const r = check(tree({ [name]: bytes }), '--deny-file', deny);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, where, what);
  }
});

test('a ZIP, PDF or PNG inside a container is opened the same way, up to three containers deep', () => {
  const deny = denyFile('zebracorn\n');
  const secret = zip([['secret.txt', 'written by zebracorn', 'deflate']]);
  const cases = [
    ['a ZIP in a Word file', 'export/guide.docx', zip([['word/document.xml', '<w:t>x</w:t>', 'deflate'], ['word/embeddings/pack.zip', secret, 'store']]), /export\/guide\.docx!word\/embeddings\/pack\.zip!secret\.txt: deny-literal\b/],
    ['a PDF in a ZIP', 'export/pack.zip', zip([['a.pdf', pdf([{ data: zlib.deflateSync(Buffer.from('BT (zebracorn) Tj ET')), filter: '/FlateDecode' }]), 'deflate']]), /export\/pack\.zip!a\.pdf stream at byte \d+: deny-literal\b/],
    ['a ZIP in a PDF stream', 'export/a.pdf', pdf([{ data: zlib.deflateSync(secret), filter: '/FlateDecode' }]), /export\/a\.pdf stream at byte \d+!secret\.txt: deny-literal\b/],
    ['a PNG in a ZIP', 'export/guide.docx', zip([['word/media/a.png', png([['zTXt', Buffer.concat([Buffer.from('Comment\0\0'), zlib.deflateSync(Buffer.from('zebracorn'))])]]), 'store']]), /export\/guide\.docx!word\/media\/a\.png zTXt chunk at byte \d+: deny-literal\b/],
    // A container is known by its bytes, so a name that reads as an XML part does not make it text.
    ['a ZIP named as an XML part', 'export/pack.zip', zip([['embedded.xml', secret, 'store']]), /export\/pack\.zip!embedded\.xml!secret\.txt: deny-literal\b/],
    ['a ZIP named as a relationships part', 'export/guide.docx', zip([['word/_rels/document.xml.rels', secret, 'store']]), /export\/guide\.docx!word\/_rels\/document\.xml\.rels!secret\.txt: deny-literal\b/],
  ];
  for (const [what, name, bytes, where] of cases) {
    assert.equal(bytes.includes(Buffer.from('zebracorn')), false, `${what}: only opening the inner container reveals the word`);
    const r = check(tree({ [name]: bytes }), '--deny-file', deny);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, where, what);
  }
  const nest = (inner, levels) => (levels === 0 ? inner : nest(zip([[`level${levels}.zip`, inner, 'store']]), levels - 1));
  const three = check(tree({ 'export/a.zip': nest(secret, 3) }), '--deny-file', deny);
  assert.equal(three.code, 1, `three containers deep: ${three.out}`);
  assert.match(three.out, /^export\/a\.zip!level1\.zip!level2\.zip!level3\.zip!secret\.txt: deny-literal: zebracorn\b/m);
  const four = check(tree({ 'export/a.zip': nest(secret, 4) }), '--deny-file', deny);
  assert.equal(four.code, 2, `four containers deep: ${four.out}`);
  assert.match(four.out, /export\/a\.zip cannot be read completely: .*level1\.zip!level2\.zip!level3\.zip!level4\.zip is a container nested more than 3 deep/);
});

test('a container that inflates past --max-inflated-bytes is an error, not a pass', () => {
  const zeros = Buffer.alloc(2 * 1024 * 1024);
  const files = {
    'export/big.docx': zip([['word/document.xml', zeros, 'deflate']]),
    'export/big.pdf': pdf([{ data: zlib.deflateSync(zeros), filter: '/FlateDecode' }]),
  };
  assert.equal(check(tree(files)).code, 0, 'the default limit reads both');
  for (const [name, bytes] of Object.entries(files)) {
    const r = check(tree({ [name]: bytes }), '--max-inflated-bytes', String(1024 * 1024));
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, new RegExp(`${name.replace(/[./]/g, '\\$&')} cannot be read completely: .*1048576 bytes`), name);
  }
});

test('private, shared, reserved and documentation values, placeholders, remotes and version numbers pass', () => {
  const body = [
    'private 10.40.1.231, 172.16.5.4, 192.168.1.1; shared 100.100.0.0/17 and 100.64.0.1; loopback 127.0.0.1',
    'link-local 169.254.169.254; any 0.0.0.0/0; multicast 224.0.0.0/3; broadcast 255.255.255.255',
    'documentation 192.0.2.10, 198.51.100.7 and 203.0.113.0/26; 2.7.41491.1243 and 1.2.3.4.5 are no addresses',
    'versions [assembly: AssemblyVersion("4.0.0.0")] and "contentVersion": "1.0.0.0"',
    'runners C:\\Users\\runneradmin\\AppData, C:\\Users\\RUNNER~1\\.claude, /home/runner/work and /Users/runner/x',
    'placeholders C:\\Users\\<user>\\x, %USERPROFILE%, /home/${USER}/src, /Users/$USER/x and /Users/Shared/x',
    'mail dev@contoso.com, a@example.org, b@corp.example.net, 1+x@users.noreply.github.com; package @scope/pkg@2.1.272',
    'remote git@github.com:owner/repo.git; host https://ca-claude-gw.<environment>.eastus2.azurecontainerapps.io',
  ].join('\n');
  const r = check(tree({ 'docs/clean.md': body }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\b1 file checked, 0 findings\b/);
});

test('an allow entry with a why passes its value; an entry without a usable why, or too wide, passes nothing', () => {
  const body = planted('fixture 20.1.2.3, C:\\Users\\dev\\x, https://app.happyfield-1a2b3c4d.', 'westus2.azurecontainerapps.io and 203.0.0.0/16\n');
  const entries = (why) => allowFile([
    { rule: 'public-ipv4', value: '20.1.2.3', why: 'a fixture of a public address' },
    { rule: 'public-ipv4', value: '203.0.0.0/16', why: 'a fixture of a range around the documentation range' },
    { rule: 'user-profile-path', value: 'dev', why: 'the example profile of the articles' },
    { rule: 'aca-host', value: 'happyfield-1a2b3c4d.westus2', why },
  ]);
  for (const why of ['', '   ', 42, undefined]) {
    const r = check(tree({ 'docs/a.md': body, 'scripts/publish/allow.json': entries(why) }));
    assert.equal(r.code, 1, `why ${JSON.stringify(why)}: ${r.out}`);
    assert.match(r.out, /docs\/a\.md:1: aca-host\b/);
    assert.doesNotMatch(r.out, /public-ipv4|user-profile-path/);
    assert.match(r.out, /allow entry ignored, no why: aca-host/);
  }
  assert.equal(check(tree({ 'docs/a.md': body, 'scripts/publish/allow.json': entries('the example deployment') })).code, 0);
  const wide = check(tree({
    'docs/a.md': planted('from 52.1.', '2.3\n'),
    'scripts/publish/allow.json': allowFile([{ rule: 'public-ipv4', value: planted('52.0.', '0.0/8'), why: 'every address of a /8' }]),
  }));
  assert.equal(wide.code, 1, wide.out);
  assert.match(wide.out, /allow entry ignored, wider than \/16: public-ipv4 52\.0\.0\.0\/8/);
});

test('an allow entry passes the addresses and ranges inside it, not a wider range around it', () => {
  const allow = allowFile([{ rule: 'public-ipv4', value: planted('20.1.', '0.0/24'), why: 'a fixture' }]);
  const inside = check(tree({ 'docs/a.md': planted('host 20.1.', '0.7 and range 20.1.', '0.0/25\n'), 'scripts/publish/allow.json': allow }));
  assert.equal(inside.code, 0, inside.out);
  const wider = check(tree({ 'docs/a.md': planted('wide 20.1.', '0.0/16\n'), 'scripts/publish/allow.json': allow }));
  assert.equal(wider.code, 1, wider.out);
  assert.match(wider.out, /docs\/a\.md:1: public-ipv4\b/);
});

test('in a git repository only tracked files are checked', () => {
  const dir = tree({ 'tracked.md': 'clean\n', 'untracked.md': planted('from 52.1.', '2.3\n') });
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', 'tracked.md').status, 0);
  const r = check(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\b1 file checked, 0 findings\b/);
  assert.equal(git('add', 'untracked.md').status, 0);
  assert.equal(check(dir).code, 1);
});

test('a missing root, a missing deny file or an unknown option is a usage error', () => {
  assert.equal(check(path.join(os.tmpdir(), 'cgw-publish-missing-root')).code, 2);
  const dir = tree({ 'a.md': 'x\n' });
  assert.equal(check(dir, '--deny-file', path.join(os.tmpdir(), 'cgw-publish-missing-deny.txt')).code, 2);
  assert.equal(check(dir, '--dny-file', 'x').code, 2);
});
