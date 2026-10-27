// A small PostgreSQL client for admin-ui (ADR-0015), on node:net and node:tls with no package, as the rest of
// this repository. It asks for TLS first and verifies the certificate and host name; it authenticates with
// SCRAM-SHA-256 only (RFC 5802, RFC 7677) and verifies the server's signature; every value is a bound parameter of the
// extended query protocol, returned as text. Protocol: https://www.postgresql.org/docs/16/protocol-flow.html
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const SSL_REQUEST = 80877103;
const PROTOCOL_3 = 196608;

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');
const frame = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type, 'latin1'), int32(body.length + 4), body]); };
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/** TLS options for a server name: Node's trust store, host name checked (U-126). */
export function tlsOptions(host) {
  return { servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

// An ErrorResponse's fields: S severity, C SQLSTATE, M message (https://www.postgresql.org/docs/16/protocol-error-fields.html).
function serverError(body) {
  const fields = {};
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const end = body.indexOf(0, at + 1);
    fields[String.fromCharCode(body[at])] = body.subarray(at + 1, end).toString('utf8');
    at = end + 1;
  }
  return fail(`PostgreSQL: ${fields.M ?? 'error'}`, { code: fields.C, severity: fields.S });
}

/** Reads whole messages from a socket: next(n) for a raw byte count, message() for a typed message. */
function reader(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let ended = null;
  const wake = () => { const w = waiting; waiting = null; w?.(); };
  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); wake(); });
  socket.on('error', (e) => { ended = e; wake(); });
  socket.on('close', () => { ended ??= fail('PostgreSQL: the connection closed'); wake(); });
  const until = async (n) => {
    while (buf.length < n) {
      if (ended) throw ended;
      await new Promise((r) => { waiting = r; });
    }
  };
  return {
    async bytes(n) { await until(n); const out = buf.subarray(0, n); buf = buf.subarray(n); return out; },
    async message() {
      await until(5);
      const len = buf.readInt32BE(1);
      await until(len + 1);
      const type = String.fromCharCode(buf[0]);
      const body = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);
      return { type, body };
    },
    detach() { socket.removeAllListeners('data'); },
  };
}

function open(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(fail(`PostgreSQL: no connection to ${host}:${port} within ${timeoutMs} ms`)); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(timer); reject(fail(`PostgreSQL: cannot connect to ${host}:${port}: ${e.message}`)); });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, ...tlsOptions(host) });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', (e) => reject(fail(`PostgreSQL: TLS with ${host} failed: ${e.message}`)));
  });
}

async function scram(read, write, password, mechanisms) {
  if (!mechanisms.includes('SCRAM-SHA-256')) throw fail(`PostgreSQL: the server offers ${mechanisms.join(', ') || 'no SASL mechanism'}, not SCRAM-SHA-256`);
  const clientNonce = crypto.randomBytes(18).toString('base64');
  const clientFirstBare = `n=,r=${clientNonce}`;
  const first = Buffer.from(`n,,${clientFirstBare}`);
  write(frame('p', cstr('SCRAM-SHA-256'), int32(first.length), first));
  const cont = await read.message();
  if (cont.type === 'E') throw serverError(cont.body);
  if (cont.type !== 'R' || cont.body.readInt32BE(0) !== 11) throw fail('PostgreSQL: expected SASLContinue');
  const serverFirst = cont.body.subarray(4).toString();
  const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
  if (!attrs.r?.startsWith(clientNonce) || !attrs.s || !(Number(attrs.i) >= 4096)) throw fail('PostgreSQL: unusable SCRAM server-first message');
  const salted = crypto.pbkdf2Sync(password, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const withoutProof = `c=biws,r=${attrs.r}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
  const signature = hmac(sha(clientKey), authMessage);
  const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i])).toString('base64');
  write(frame('p', Buffer.from(`${withoutProof},p=${proof}`)));
  const final = await read.message();
  if (final.type === 'E') throw serverError(final.body);
  if (final.type !== 'R' || final.body.readInt32BE(0) !== 12) throw fail('PostgreSQL: expected SASLFinal');
  const expected = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
  const got = /v=([^,]+)/.exec(final.body.subarray(4).toString())?.[1] ?? '';
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    throw fail('PostgreSQL: the server signature does not match; the server does not know the password');
  }
}

/**
 * Connects and authenticates. upgrade(socket, host) replaces the TLS handshake in tests only. Resolves to
 * { query(text, params) -> { rows, command }, close() }.
 */
export async function connect({ host, port = 5432, user, password, database, timeoutMs = 10_000, upgrade = upgradeTls }) {
  const raw = await open(host, port, timeoutMs);
  let socket = raw;
  try {
    raw.write(Buffer.concat([int32(8), int32(SSL_REQUEST)]));
    const pre = reader(raw);
    const answer = (await pre.bytes(1)).toString();
    pre.detach();
    if (answer !== 'S') throw fail(`PostgreSQL: ${host} refused TLS`);
    socket = await upgrade(raw, host);
    const read = reader(socket);
    const write = (b) => socket.write(b);
    const startup = Buffer.concat([int32(PROTOCOL_3), cstr('user'), cstr(user), cstr('database'), cstr(database), cstr('application_name'), cstr('admin-ui'), Buffer.from([0])]);
    write(Buffer.concat([int32(startup.length + 4), startup]));
    for (;;) {
      const m = await read.message();
      if (m.type === 'E') throw serverError(m.body);
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue;
        if (code !== 10) throw fail(`PostgreSQL: the server asked for authentication method ${code}; only SCRAM-SHA-256 is used`);
        await scram(read, write, password, m.body.subarray(4).toString().split('\0').filter(Boolean));
        continue;
      }
      if (m.type === 'Z') break;
    }
    return session(socket, read, write);
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

function session(socket, read, write) {
  let chain = Promise.resolve();
  async function run(text, params) {
    const values = params.map((v) => (v === null || v === undefined ? int32(-1) : (() => { const b = Buffer.from(String(v), 'utf8'); return Buffer.concat([int32(b.length), b]); })()));
    write(Buffer.concat([
      frame('P', cstr(''), cstr(text), int16(0)),
      frame('B', cstr(''), cstr(''), int16(0), int16(params.length), ...values, int16(0)),
      frame('D', Buffer.from('P'), cstr('')),
      frame('E', cstr(''), int32(0)),
      frame('S'),
    ]));
    let columns = [];
    const rows = [];
    let command = null;
    let error = null;
    for (;;) {
      const m = await read.message();
      if (m.type === 'T') {
        const n = m.body.readInt16BE(0);
        let at = 2;
        columns = [];
        for (let i = 0; i < n; i += 1) { const end = m.body.indexOf(0, at); columns.push(m.body.subarray(at, end).toString('utf8')); at = end + 1 + 18; }
      } else if (m.type === 'D') {
        const n = m.body.readInt16BE(0);
        let at = 2;
        const row = {};
        for (let i = 0; i < n; i += 1) {
          const len = m.body.readInt32BE(at); at += 4;
          row[columns[i]] = len === -1 ? null : m.body.subarray(at, at + len).toString('utf8');
          if (len > 0) at += len;
        }
        rows.push(row);
      } else if (m.type === 'C') command = m.body.subarray(0, m.body.length - 1).toString();
      else if (m.type === 'E') error = serverError(m.body);
      else if (m.type === 'Z') break;
    }
    if (error) throw error;
    return { rows, command };
  }
  return {
    query(text, params = []) {
      const next = chain.then(() => run(text, params));
      chain = next.catch(() => {});
      return next;
    },
    async close() {
      await chain;
      const closed = new Promise((resolve) => { socket.once('close', resolve); setTimeout(resolve, 2000).unref(); });
      write(frame('X'));
      socket.end();
      await closed;
    },
  };
}
