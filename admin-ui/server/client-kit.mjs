// GET /api/client-kit (P-41, T-124): the client files new-client-policy.mjs writes, for this gateway's own address and a
// model of its admin file, as one zip or one named file. A zip written here, without a package, because the console has
// no npm dependencies (admin-ui/Dockerfile): deflated entries with the layout of the ZIP application note
// (https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT, sections 4.3.7, 4.3.12 and 4.3.16).
import path from 'node:path';
import zlib from 'node:zlib';
import { clientPolicyFiles, gatewayOrigin } from '../../scripts/admin/new-client-policy.mjs';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
// 1980-01-01 00:00 in DOS date and time, so the same files always give the same archive.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** files: relative path -> string or Buffer. Returns the zip as a Buffer. */
export function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    local.copy(entry, 8, 6, 30); // flags to name length, the same as the local header
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The entries of an archive zipFiles wrote, each checked against its CRC. For tests and support checks. */
export function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('invalid zip: no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('invalid zip: bad central directory entry');
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(zip.subarray(start, start + size));
    if (zlib.crc32(data) !== crc) throw new Error(`invalid zip: CRC mismatch for ${name}`);
    files[name] = data;
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

const refuse = (status, error) => ({ status, body: { error } });

/** kit: { origin(): the gateway's https origin or null, models(): the admin file's model ids }. */
export async function clientKitAnswer(searchParams, kit) {
  const model = searchParams.get('model') ?? '';
  const fastModel = searchParams.get('fastModel') || model;
  const models = await kit.models();
  for (const [name, id] of [['model', model], ['fastModel', fastModel]]) {
    if (!id) return refuse(400, `pass ${name}=<id>, a model id of the admin file: ${models.join(', ')}`);
    if (!MODEL.test(id) || !models.includes(id)) return refuse(400, `${name} ${JSON.stringify(id)} is not a model of the admin file: ${models.join(', ')}`);
  }
  const address = await kit.origin();
  if (!address) return refuse(503, 'The gateway address is not available from the Container App ingress, so the client files cannot name it.');
  let origin;
  try { origin = gatewayOrigin(address); } catch (error) { return refuse(503, `The gateway address cannot be used in client files: ${error.message}`); }
  const files = clientPolicyFiles({ origin, fastModel, model });
  const file = searchParams.get('file');
  if (file !== null) {
    if (!Object.hasOwn(files, file)) return refuse(404, `no client file ${JSON.stringify(file)}; the files are ${Object.keys(files).join(', ')}`);
    const content = files[file];
    return { status: 200, raw: Buffer.isBuffer(content) ? content : Buffer.from(content), headers: {
      'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.posix.basename(file)}"` } };
  }
  return { status: 200, raw: zipFiles(files), headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="client-policy.zip"' } };
}
