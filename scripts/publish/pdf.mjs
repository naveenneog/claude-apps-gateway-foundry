// Reads a PDF for the publication check (ADR-0006, T-75) with a minimal tokenizer of ISO 32000-1, 7.2 and 7.3: white
// space and comments, literal and hexadecimal strings, names with #hh escapes, numbers, keywords, arrays, dictionaries
// and `n g R` references. Objects are read in file order from the header on, and each stream's data is skipped by its
// declared /Length, direct or resolved from the integer object it names, which has to end at `endstream` and match the
// data. Strings and escaped names are decoded as a reader shows them. Every object header a lenient reader could find
// in the bytes, by a cross-reference offset or by scanning, has to be one the tokenizer read, so no object hides in a
// stream's data, a string, a comment or before the header. A construct the tokenizer does not know, an object or
// cross-reference stream, or an encrypted file stops the check with UnreadableFile instead of hiding a stream.
// https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
import zlib from 'node:zlib';
import { UnreadableFile } from './containers.mjs';

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
// Filters whose output is image data, which carries no text for the checks.
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);
// The escapes of a literal string (7.3.4, literal strings) other than octal codes and an escaped end of line.
const ESCAPES = new Map([['n', 0x0a], ['r', 0x0d], ['t', 0x09], ['b', 0x08], ['f', 0x0c], ['(', 0x28], [')', 0x29], ['\\', 0x5c]]
  .map(([c, value]) => [c.charCodeAt(0), value]));
// PDF white space, NUL included, and comments (7.2.2, 7.2.3). A comment runs to the end of its line, so white space and
// comments split a gap one way only and a long gap is matched in linear time.
const COMMENT = String.raw`%[^\r\n]*(?![^\r\n])`;
const GAP = String.raw`(?:[\0\t\n\f\r ]|${COMMENT})+`;
// An object header as the most lenient reader takes it (7.3.10). Its numbers are runs of digits, signs and points:
// MuPDF's lexer skips repeated leading minus signs and ends a number at a minus sign inside it (pdf-lex.c, lex_number),
// and pdf.js compares parsed numbers, so 2.0 or +2 names object 2 (xref.js, fetchUncompressed). Vertical tabs and
// no-break spaces can separate the parts, since pdf.js rebuilds a damaged file with a \s pattern (xref.js,
// indexObjects). A number is matched from the start of its run and from its first digit only, so a long run is read in
// linear time.
const LENIENT_GAP = String.raw`(?:[\0\t\n\v\f\r \xa0]|${COMMENT})+`;
const NUMBER = String.raw`(?<![+\-.\d])[+\-.]*\d[+\-.\d]*`;
const OBJECT_HEADER = new RegExp(`${NUMBER}${LENIENT_GAP}${NUMBER}${LENIENT_GAP}obj`, 'g');

// A PDF by its name, by its header at the first byte, or by a header in the first 1024 bytes of a file that holds an
// object header; text that only mentions a PDF header keeps its text checks.
export function isPdf(bytes, name = '') {
  if (/\.pdf$/i.test(name) || bytes.subarray(0, 5).toString('latin1') === '%PDF-') return true;
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return false;
  return new RegExp(OBJECT_HEADER.source).test(bytes.toString('latin1'));
}

// The text a reader shows for a string (7.9.2, text strings): UTF-16 or UTF-8 after a byte order mark, otherwise PDFDocEncoding,
// which matches Latin-1 in the characters the checks look for.
function stringText(bytes) {
  const utf16 = (bytes[0] === 0xfe && bytes[1] === 0xff) ? 'be' : (bytes[0] === 0xff && bytes[1] === 0xfe) ? 'le' : null;
  if (utf16) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return (utf16 === 'be' ? body.swap16() : body).toString('utf16le');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  return bytes.toString('latin1');
}

class Tokenizer {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
    this.texts = new Map(); // byte offset → { kind, text } of a string or an escaped name read there
  }

  skipWhite() {
    const b = this.bytes;
    while (this.at < b.length) {
      if (WHITE.has(b[this.at])) this.at += 1;
      else if (b[this.at] === 0x25) while (this.at < b.length && b[this.at] !== 0x0a && b[this.at] !== 0x0d) this.at += 1;
      else break;
    }
  }

  word(from) {
    let end = from;
    while (end < this.bytes.length && !WHITE.has(this.bytes[end]) && !DELIMITERS.has(this.bytes[end])) end += 1;
    return end;
  }

  // A literal string's bytes (7.3.4, literal strings): escapes decoded, an escaped end of line dropped, balanced parentheses kept.
  literal(start) {
    const b = this.bytes;
    const out = [];
    let depth = 0;
    for (let i = start; i < b.length; i += 1) {
      if (b[i] === 0x5c) {
        i += 1;
        const e = b[i];
        if (ESCAPES.has(e)) out.push(ESCAPES.get(e));
        else if (e >= 0x30 && e <= 0x37) {
          let code = e - 0x30;
          for (let n = 0; n < 2 && b[i + 1] >= 0x30 && b[i + 1] <= 0x37; n += 1) code = code * 8 + b[(i += 1)] - 0x30;
          out.push(code & 0xff);
        } else if (e === 0x0d) {
          if (b[i + 1] === 0x0a) i += 1;
        } else if (e !== 0x0a && e !== undefined) out.push(e);
        continue;
      }
      if (b[i] === 0x28) depth += 1;
      else if (b[i] === 0x29) depth -= 1;
      if (depth === 0) {
        this.at = i + 1;
        return Buffer.from(out);
      }
      if (i > start) out.push(b[i]);
    }
    throw new UnreadableFile(`the PDF string at byte ${start} does not end`);
  }

  // A hexadecimal string's bytes (7.3.4, hexadecimal strings): white space ignored, a missing last digit read as 0.
  hex(start) {
    const end = this.bytes.indexOf(0x3e, start);
    if (end < 0) throw new UnreadableFile(`the PDF string at byte ${start} does not end`);
    const digits = this.bytes.toString('latin1', start + 1, end).replace(/[\0\t\n\f\r ]/g, '');
    if (!/^[0-9a-f]*$/i.test(digits)) throw new UnreadableFile(`the PDF hexadecimal string at byte ${start} holds a character that is no hexadecimal digit`);
    this.at = end + 1;
    return Buffer.from(digits.length % 2 ? `${digits}0` : digits, 'hex');
  }

  // The next token, or null at the end of the file.
  next() {
    this.skipWhite();
    const b = this.bytes;
    if (this.at >= b.length) return null;
    const start = this.at;
    const c = b[start];
    if (c === 0x2f) {
      this.at = this.word(start + 1);
      const raw = b.toString('latin1', start + 1, this.at);
      const value = raw.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (value !== raw) this.texts.set(start, { kind: 'name', text: value });
      return { kind: 'name', value };
    }
    if (c === 0x28 || (c === 0x3c && b[start + 1] !== 0x3c)) {
      this.texts.set(start, { kind: 'string', text: stringText(c === 0x28 ? this.literal(start) : this.hex(start)) });
      return { kind: 'string' };
    }
    if (c === 0x3c && b[start + 1] === 0x3c) { this.at = start + 2; return { kind: '<<' }; }
    if (c === 0x3e && b[start + 1] === 0x3e) { this.at = start + 2; return { kind: '>>' }; }
    if (c === 0x5b || c === 0x5d) { this.at = start + 1; return { kind: c === 0x5b ? '[' : ']' }; }
    if (DELIMITERS.has(c)) throw new UnreadableFile(`an unexpected ${String.fromCharCode(c)} at byte ${start} of the PDF`);
    this.at = this.word(start);
    const value = b.toString('latin1', start, this.at);
    return { kind: /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : 'keyword', value };
  }

  // One object: a dictionary becomes a Map of its own keys, an array a list, `n g R` a { ref } value.
  object(first = this.next()) {
    if (!first) throw new UnreadableFile('a PDF object is cut short');
    if (first.kind === '<<') {
      const dictionary = new Map();
      for (let key = this.next(); ; key = this.next()) {
        if (key?.kind === '>>') return dictionary;
        if (key?.kind !== 'name') throw new UnreadableFile(`a PDF dictionary before byte ${this.at} has a key that is no name`);
        dictionary.set(key.value, this.object());
      }
    }
    if (first.kind === '[') {
      const list = [];
      for (let item = this.next(); ; item = this.next()) {
        if (!item) throw new UnreadableFile('a PDF array does not end');
        if (item.kind === ']') return list;
        list.push(this.object(item));
      }
    }
    if (first.kind === 'number') {
      const back = this.at;
      const generation = this.next();
      const r = generation?.kind === 'number' ? this.next() : null;
      if (r?.kind === 'keyword' && r.value === 'R') return { ref: `${first.value} ${generation.value}` };
      this.at = back;
    }
    if (first.kind === '>>' || first.kind === ']') throw new UnreadableFile(`an unexpected ${first.kind} before byte ${this.at} of the PDF`);
    return first;
  }
}

// The stream's filter names: [] without /Filter; an indirect or malformed /Filter makes the file unreadable.
function filtersOf(dictionary, start) {
  const filter = dictionary.get('Filter');
  if (filter === undefined) return [];
  const list = Array.isArray(filter) ? filter : [filter];
  if (!list.every((f) => f?.kind === 'name')) throw new UnreadableFile(`the stream at byte ${start} names its filter indirectly or not as a name`);
  return list.map((f) => f.value);
}

// Inflating is the whole decoding only without a predictor (ISO 32000-1, 7.4.4, predictor functions): a /DecodeParms that names a
// predictor other than 1, or that is not a dictionary, makes the file unreadable.
function checkDecodeParms(dictionary, start) {
  const parms = dictionary.get('DecodeParms');
  if (parms === undefined) return;
  for (const p of Array.isArray(parms) ? parms : [parms]) {
    if (p?.kind === 'keyword' && p.value === 'null') continue;
    if (!(p instanceof Map)) throw new UnreadableFile(`the stream at byte ${start} names its /DecodeParms indirectly or not as a dictionary`);
    const predictor = p.get('Predictor');
    if (predictor !== undefined && !(predictor.kind === 'number' && Number(predictor.value) === 1)) {
      throw new UnreadableFile(`the stream at byte ${start} uses a predictor, which the checker does not decode`);
    }
  }
}

// The integer objects a /Length can refer to, as `n g` → value; a number with two different values is ambiguous.
function integerObjects(text) {
  const found = new Map();
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w.])(\d+)${GAP}(\d+)${GAP}obj${GAP}(\d+)${GAP}endobj\b`, 'g'))) {
    const key = `${m[1]} ${m[2]}`;
    found.set(key, found.has(key) && found.get(key) !== Number(m[3]) ? NaN : Number(m[3]));
  }
  return found;
}

// The declared /Length of the stream at `start`: direct, or the integer object it refers to.
function declaredLength(dictionary, integers, start) {
  const length = dictionary.get('Length');
  if (length?.kind === 'number' && /^\d+$/.test(length.value)) return Number(length.value);
  if (length?.ref) {
    const value = integers.get(length.ref);
    if (Number.isSafeInteger(value)) return value;
    throw new UnreadableFile(`the stream at byte ${start} names its /Length in object ${length.ref}, which ${value === undefined ? 'the file does not hold' : 'the file defines twice'}`);
  }
  throw new UnreadableFile(`the stream at byte ${start} has no /Length`);
}

// Object streams hold objects a reader finds through a cross-reference stream, and neither is read here (7.5.7, 7.5.8).
function checkStreamType(dictionary, start) {
  const type = dictionary.get('Type');
  if (type === undefined) return;
  if (type.kind !== 'name') throw new UnreadableFile(`the stream at byte ${start} gives its /Type indirectly or not as a name`);
  if (type.value === 'ObjStm' || type.value === 'XRef') {
    throw new UnreadableFile(`the stream at byte ${start} is ${type.value === 'ObjStm' ? 'an object' : 'a cross-reference'} stream, which the checker does not read`);
  }
}

// Reads a stream's data after its keyword, sets the tokenizer after its endstream, and adds the inflated data of a
// Flate stream to `streams`. The declared /Length has to end at endstream and match the bytes zlib reads; any
// disagreement makes the file unreadable.
function readStream(tokens, dictionary, integers, streams, limit) {
  const b = tokens.bytes;
  let start = tokens.at;
  if (b[start] === 0x0d && b[start + 1] === 0x0a) start += 2;
  else if (b[start] === 0x0a) start += 1;
  else throw new UnreadableFile(`the stream keyword before byte ${start} is not followed by an end of line`);
  checkStreamType(dictionary, start);
  const length = declaredLength(dictionary, integers, start);
  const end = start + length;
  const tail = /^(?:\r\n|\r|\n)?endstream/.exec(b.toString('latin1', end, end + 12));
  if (!tail) throw new UnreadableFile(`the stream at byte ${start} declares /Length ${length}, which does not end at endstream`);
  const filters = filtersOf(dictionary, start);
  if (filters[0] === 'FlateDecode' && filters.slice(1).every((f) => IMAGE_FILTERS.has(f))) {
    checkDecodeParms(dictionary, start);
    let inflated;
    try {
      inflated = zlib.inflateSync(b.subarray(start, end), { maxOutputLength: limit, info: true });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new UnreadableFile(`the stream at byte ${start} inflates to more than ${limit} bytes`);
      throw new UnreadableFile(`the Flate stream at byte ${start} does not inflate (${err.code})`);
    }
    if (!/^\s*$/.test(b.toString('latin1', start + inflated.engine.bytesWritten, end))) {
      throw new UnreadableFile(`the stream at byte ${start} declares /Length ${length}, but its Flate data ends ${inflated.engine.bytesWritten} bytes in`);
    }
    streams.push({ name: `stream at byte ${start}`, bytes: inflated.buffer });
  } else if (!filters.every((f) => IMAGE_FILTERS.has(f))) {
    throw new UnreadableFile(`the stream at byte ${start} uses the filter ${filters.join(' ')}, which the checker does not decode`);
  }
  tokens.at = end + tail[0].length;
}

// The Flate streams of a PDF, each inflated up to `limit` bytes, and the text of its strings and escaped names. A stream
// with no filter is in the file's bytes, which the checker reads as they are; one with image filters only carries no
// text; any other filter, a /Length that does not match the stream, a Flate stream that does not inflate, an object
// header the tokenizer did not read, an object or cross-reference stream, or encryption makes the file unreadable.
export function readPdf(bytes, limit) {
  const tokens = new Tokenizer(bytes);
  // Tokens start at a header in the first 1024 bytes, where readers look for one, or else at the first byte.
  tokens.at = Math.max(0, bytes.subarray(0, 1024).indexOf('%PDF-'));
  const text = bytes.toString('latin1');
  const integers = integerObjects(text);
  const streams = [];
  const headers = new Set(); // byte offsets of the `obj` keywords of the objects read
  for (let t = tokens.next(); t; t = tokens.next()) {
    if (t.kind !== 'number') {
      if (t.kind === '<<') {
        // A trailer dictionary; other top-level tokens are cross-reference entries and keywords.
        if (tokens.object(t).has('Encrypt')) throw new UnreadableFile('the PDF is encrypted, and its strings and streams are not read');
      } else if (t.kind === '>>' || t.kind === ']') throw new UnreadableFile(`an unexpected ${t.kind} before byte ${tokens.at} of the PDF`);
      continue;
    }
    const back = tokens.at;
    const generation = tokens.next();
    const obj = generation?.kind === 'number' ? tokens.next() : null;
    if (obj?.kind !== 'keyword' || obj.value !== 'obj') {
      tokens.at = back;
      continue;
    }
    headers.add(tokens.at - 3);
    const value = tokens.object();
    const after = tokens.next();
    if (after?.kind === 'keyword' && after.value === 'stream') {
      if (!(value instanceof Map)) throw new UnreadableFile(`a stream before byte ${tokens.at} has no dictionary`);
      readStream(tokens, value, integers, streams, limit);
      const endobj = tokens.next();
      if (endobj?.kind !== 'keyword' || endobj.value !== 'endobj') throw new UnreadableFile(`a stream before byte ${tokens.at} is not followed by endobj`);
    } else if (after?.kind !== 'keyword' || after.value !== 'endobj') {
      throw new UnreadableFile(`an object before byte ${tokens.at} of the PDF does not end with endobj`);
    }
  }
  for (const m of text.matchAll(OBJECT_HEADER)) {
    if (!headers.has(m.index + m[0].length - 3)) {
      throw new UnreadableFile(`the object header at byte ${m.index} is not one the checker read: it lies in a stream's data, a string or a comment, or before the PDF header`);
    }
  }
  const strings = [...tokens.texts].map(([at, { kind, text }]) => ({ name: `${kind} at byte ${at}`, text }));
  return { streams, strings };
}
