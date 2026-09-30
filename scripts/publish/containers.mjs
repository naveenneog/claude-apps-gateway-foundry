// Readers for the files the publication check opens (ADR-0006, T-75): text by its byte order mark, the parts of a ZIP
// container such as a Word file, the text of Word paragraphs and XML character references, and the text chunks of a
// PNG; pdf.mjs reads PDFs. A reader that cannot read a whole file throws UnreadableFile rather than return part of it.
import zlib from 'node:zlib';

export class UnreadableFile extends Error {}

// Text by its byte order mark, UTF-8 or UTF-16 in either byte order; null when the bytes carry no mark.
export function decodeBom(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) ? 'le' : (bytes[0] === 0xfe && bytes[1] === 0xff) ? 'be' : null;
  if (!utf16) return null;
  const body = Buffer.from(bytes.subarray(2));
  if (body.length % 2 !== 0) throw new UnreadableFile('UTF-16 text with an odd number of bytes');
  return (utf16 === 'be' ? body.swap16() : body).toString('utf16le');
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

export const isZip = (bytes) => bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL;

function zipEnd(bytes) {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (bytes.readUInt32LE(i) === ZIP_END) return i;
  }
  throw new UnreadableFile('no ZIP end-of-central-directory record');
}

// Every part of a ZIP container, read through its central directory and inflated, each up to `limit` bytes. ZIP64,
// multi-disk, encrypted and methods other than stored and deflated are refused, and the entries read must fill the
// directory exactly, so no part goes unread.
export function zipParts(bytes, limit) {
  const end = zipEnd(bytes);
  const [disk, dirDisk, onDisk, total] = [4, 6, 8, 10].map((o) => bytes.readUInt16LE(end + o));
  const [size, offset] = [12, 16].map((o) => bytes.readUInt32LE(end + o));
  if ([onDisk, total].includes(0xffff) || [size, offset].includes(0xffffffff)) throw new UnreadableFile('ZIP64 archives are not read');
  if (disk !== 0 || dirDisk !== 0 || onDisk !== total) throw new UnreadableFile('multi-disk ZIP archives are not read');
  if (offset + size > end) throw new UnreadableFile('the ZIP central directory lies outside the file');
  const parts = [];
  let at = offset;
  for (let i = 1; i <= total; i += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== ZIP_CENTRAL) throw new UnreadableFile(`ZIP directory entry ${i} is damaged`);
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const [compressed, uncompressed] = [20, 24].map((o) => bytes.readUInt32LE(at + o));
    const [nameLength, extraLength, commentLength] = [28, 30, 32].map((o) => bytes.readUInt16LE(at + o));
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    if ([compressed, uncompressed, local].includes(0xffffffff)) throw new UnreadableFile(`${name} has ZIP64 sizes, which are not read`);
    if (flags & 0x1) throw new UnreadableFile(`${name} is encrypted`);
    if (method !== 0 && method !== 8) throw new UnreadableFile(`${name} uses compression method ${method}`);
    if (uncompressed > limit) throw new UnreadableFile(`${name} inflates to more than ${limit} bytes`);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== ZIP_LOCAL) throw new UnreadableFile(`the local header of ${name} is damaged`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) throw new UnreadableFile(`${name} runs past the end of the file`);
    const data = bytes.subarray(start, start + compressed);
    let content;
    try {
      content = method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: limit });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new UnreadableFile(`${name} inflates to more than ${limit} bytes`);
      throw new UnreadableFile(`${name} does not inflate (${err.code})`);
    }
    if (content.length !== uncompressed) throw new UnreadableFile(`${name} holds ${content.length} bytes, not ${uncompressed}`);
    parts.push({ name, bytes: content });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== offset + size) throw new UnreadableFile(`the ZIP central directory holds more than its ${total} entries`);
  return parts;
}

const XML_NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// Replaces named, decimal and hexadecimal XML character references with the characters they stand for.
export function decodeXml(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (whole, dec, hex, named) => {
    if (named) return XML_NAMED[named.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// The text of each Word paragraph with its runs joined, as a reader sees it; runs can split a value anywhere.
export function wordParagraphs(xml) {
  return xml.split(/<\/w:p>/).map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Chunks that hold image data or plain values (PNG, third edition, 11.2 and 11.3); the text chunks are read below.
const PLAIN_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'sBIT', 'sRGB', 'bKGD', 'hIST',
  'pHYs', 'sPLT', 'tIME']);

export const isPng = (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);

// Compressed text of a PNG chunk: zlib data that has to end where the chunk ends.
function inflateChunk(data, type, at, limit) {
  let inflated;
  try {
    inflated = zlib.inflateSync(data, { maxOutputLength: limit, info: true });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new UnreadableFile(`the PNG chunk ${type} at byte ${at} inflates to more than ${limit} bytes`);
    throw new UnreadableFile(`the PNG chunk ${type} at byte ${at} does not inflate (${err.code})`);
  }
  if (inflated.engine.bytesWritten !== data.length) throw new UnreadableFile(`the PNG chunk ${type} at byte ${at} holds data after its compressed text`);
  return inflated.buffer;
}

// The text a PNG carries in tEXt, zTXt and iTXt chunks, inflated where compressed (PNG, third edition, 11.3.3). Any
// other chunk than the plain ones, a chunk cut short or data after IEND makes the file unreadable, since those bytes
// could hold compressed text.
export function pngTexts(bytes, limit) {
  const texts = [];
  for (let at = 8; ;) {
    if (at + 12 > bytes.length) throw new UnreadableFile(`the PNG chunk at byte ${at} is cut short`);
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > bytes.length) throw new UnreadableFile(`the PNG chunk ${type} at byte ${at} runs past the end of the file`);
    const data = bytes.subarray(at + 8, at + 8 + length);
    const name = `${type} chunk at byte ${at}`;
    const keyword = data.indexOf(0);
    if (type === 'tEXt') {
      texts.push({ name, text: data.toString('latin1') });
    } else if (type === 'zTXt') {
      if (keyword < 0 || data[keyword + 1] !== 0) throw new UnreadableFile(`the PNG chunk ${name} is damaged`);
      texts.push({ name, text: `${data.toString('latin1', 0, keyword)}\n${inflateChunk(data.subarray(keyword + 2), type, at, limit).toString('latin1')}` });
    } else if (type === 'iTXt') {
      const [compressed, method] = [data[keyword + 1], data[keyword + 2]];
      const language = data.indexOf(0, keyword + 3);
      const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
      if (keyword < 0 || translated < 0 || compressed > 1 || (compressed === 1 && method !== 0)) throw new UnreadableFile(`the PNG chunk ${name} is damaged`);
      const body = data.subarray(translated + 1);
      const text = compressed ? inflateChunk(body, type, at, limit) : body;
      texts.push({ name, text: `${data.toString('utf8', 0, translated).replace(/\0/g, '\n')}\n${text.toString('utf8')}` });
    } else if (!PLAIN_PNG_CHUNKS.has(type)) {
      throw new UnreadableFile(`the PNG chunk ${type} at byte ${at} is not one the checker reads`);
    }
    at += 12 + length;
    if (type === 'IEND') {
      if (at !== bytes.length) throw new UnreadableFile(`the PNG holds ${bytes.length - at} bytes after its IEND chunk`);
      return texts;
    }
  }
}
