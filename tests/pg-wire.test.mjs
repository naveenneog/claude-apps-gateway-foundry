// T-141: admin-ui's PostgreSQL client (admin-ui/server/pg-wire.mjs) against an in-process server that speaks the v3
// protocol and checks SCRAM-SHA-256 with the same arithmetic as PostgreSQL (RFC 5802, RFC 7677). The TLS upgrade is
// replaced by the plain socket here; the real handshake is checked live (T-148).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import test from 'node:test';
import { connect } from '../admin-ui/server/pg-wire.mjs';

const PASSWORD = 'correct horse battery staple';
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
const sha = (b) => crypto.createHash('sha256').update(b).digest();

function frame(type, body = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');
const auth = (code, extra = Buffer.alloc(0)) => frame('R', Buffer.concat([int32(code), extra]));
const ready = () => frame('Z', Buffer.from('I'));

/** A server for one connection. opts: tls ('S'|'N'), auth ('scram'|'cleartext'|'md5'), badSignature, rows, error. */
function fakeServer(opts = {}) {
  const seen = { queries: [], terminated: false, startup: null };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let phase = 'ssl';
    let scram = {};
    const salt = crypto.randomBytes(16);
    const iterations = 4096;
    const salted = crypto.pbkdf2Sync(PASSWORD, salt, iterations, 32, 'sha256');
    let pending = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (phase === 'ssl' || phase === 'startup') {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const body = buf.subarray(4, len);
          buf = buf.subarray(len);
          if (phase === 'ssl') {
            assert.equal(body.readInt32BE(0), 80877103, 'the first message is SSLRequest');
            sock.write(opts.tls ?? 'S');
            phase = 'startup';
            continue;
          }
          const parts = body.subarray(4).toString('utf8').split('\0');
          seen.startup = Object.fromEntries(parts.reduce((a, v, i) => (i % 2 ? a : [...a, [v, parts[i + 1]]]), []).filter(([k]) => k));
          if (opts.auth === 'cleartext') sock.write(auth(3));
          else if (opts.auth === 'md5') sock.write(auth(5, Buffer.from([1, 2, 3, 4])));
          else sock.write(auth(10, Buffer.concat([cstr('SCRAM-SHA-256'), Buffer.from([0])])));
          phase = 'auth';
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        if (type === 'X') { seen.terminated = true; sock.end(); return; }
        if (type === 'p' && !scram.clientFirstBare) {
          const mech = body.subarray(0, body.indexOf(0)).toString();
          assert.equal(mech, 'SCRAM-SHA-256');
          const rest = body.subarray(body.indexOf(0) + 1);
          const msg = rest.subarray(4, 4 + rest.readInt32BE(0)).toString();
          assert.match(msg, /^n,,n=[^,]*,r=[A-Za-z0-9+/=]{18,}$/);
          scram.clientFirstBare = msg.slice(3);
          const clientNonce = /r=(.*)$/.exec(msg)[1];
          scram.nonce = clientNonce + crypto.randomBytes(18).toString('base64');
          scram.serverFirst = `r=${scram.nonce},s=${salt.toString('base64')},i=${iterations}`;
          sock.write(auth(11, Buffer.from(scram.serverFirst)));
          continue;
        }
        if (type === 'p') {
          const final = body.toString();
          const [, withoutProof, proof64] = /^(c=biws,r=[^,]+),p=(.+)$/.exec(final) ?? [];
          assert.ok(withoutProof, `client-final shape: ${final}`);
          assert.ok(withoutProof.endsWith(scram.nonce), 'the client echoes the server nonce');
          const authMessage = `${scram.clientFirstBare},${scram.serverFirst},${withoutProof}`;
          const storedKey = sha(hmac(salted, 'Client Key'));
          const clientKey = Buffer.from(proof64, 'base64').map((b, i) => b ^ hmac(storedKey, authMessage)[i]);
          if (!sha(Buffer.from(clientKey)).equals(storedKey)) {
            sock.write(frame('E', Buffer.concat([cstr('SFATAL'), cstr('C28P01'), cstr('Mpassword authentication failed'), Buffer.from([0])])));
            sock.end();
            return;
          }
          const serverSig = opts.badSignature ? crypto.randomBytes(32) : hmac(hmac(salted, 'Server Key'), authMessage);
          sock.write(Buffer.concat([auth(12, Buffer.from(`v=${serverSig.toString('base64')}`)), auth(0),
            frame('S', Buffer.concat([cstr('server_version'), cstr('16.0')])), frame('K', Buffer.alloc(8)), ready()]));
          continue;
        }
        pending.push({ type, body });
        if (type !== 'S') continue;
        const parse = pending.find((m) => m.type === 'P');
        const bind = pending.find((m) => m.type === 'B');
        pending = [];
        const text = parse.body.subarray(1, parse.body.indexOf(0, 1)).toString();
        let at = bind.body.indexOf(0) + 1; at = bind.body.indexOf(0, at) + 1;
        const formats = bind.body.readInt16BE(at); at += 2 + formats * 2;
        const count = bind.body.readInt16BE(at); at += 2;
        const params = [];
        for (let i = 0; i < count; i += 1) {
          const n = bind.body.readInt32BE(at); at += 4;
          params.push(n === -1 ? null : bind.body.subarray(at, at + n).toString()); if (n > 0) at += n;
        }
        seen.queries.push({ text, params });
        if (opts.error) {
          sock.write(Buffer.concat([frame('E', Buffer.concat([cstr('SERROR'), cstr('C42P01'), cstr('Mrelation "nope" does not exist'), Buffer.from([0])])), ready()]));
          continue;
        }
        const rows = opts.rows ?? [];
        const cols = rows.length ? Object.keys(rows[0]) : [];
        const desc = Buffer.concat([Buffer.from([0, cols.length]).subarray(0, 2), ...cols.map((c) => Buffer.concat([cstr(c), Buffer.alloc(18)]))]);
        const data = rows.map((r) => frame('D', Buffer.concat([Buffer.from([0, cols.length]).subarray(0, 2),
          ...cols.map((c) => (r[c] === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(r[c])), Buffer.from(r[c])])))])));
        sock.write(Buffer.concat([frame('1'), frame('2'), cols.length ? frame('T', desc) : frame('n'), ...data, frame('C', cstr(`SELECT ${rows.length}`)), ready()]));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

const plain = (socket) => socket; // stands in for the TLS upgrade

async function withServer(opts, fn) {
  const s = await fakeServer(opts);
  try { return await fn(s); } finally { s.server.close(); }
}

test('T-141 asks for TLS, completes SCRAM-SHA-256, runs a parameterised query and terminates', async () => {
  await withServer({ rows: [{ object_id: '11111111-1111-1111-1111-111111111111', department: 'Platform' }, { object_id: '2', department: null }] }, async ({ port, seen }) => {
    const db = await connect({ host: '127.0.0.1', port, user: 'gateway', password: PASSWORD, database: 'gateway', upgrade: plain });
    const r = await db.query('select * from t where a = $1 and b = $2', ['x', null]);
    assert.deepEqual(r.rows, [{ object_id: '11111111-1111-1111-1111-111111111111', department: 'Platform' }, { object_id: '2', department: null }]);
    assert.equal(r.command, 'SELECT 2');
    await db.close();
    assert.deepEqual(seen.queries, [{ text: 'select * from t where a = $1 and b = $2', params: ['x', null] }]);
    assert.equal(seen.startup.user, 'gateway');
    assert.equal(seen.startup.database, 'gateway');
    assert.equal(seen.terminated, true);
  });
});

test('T-141 a wrong password is refused by the server with its SQLSTATE', async () => {
  await withServer({}, async ({ port }) => {
    await assert.rejects(connect({ host: '127.0.0.1', port, user: 'gateway', password: 'wrong', database: 'gateway', upgrade: plain }),
      (e) => e.code === '28P01' && /password authentication failed/.test(e.message));
  });
});

test('T-141 refuses a server that declines TLS, asks for cleartext or MD5, or signs SCRAM wrongly, before any query', async () => {
  for (const [opts, pattern] of [
    [{ tls: 'N' }, /refused TLS/],
    [{ auth: 'cleartext' }, /SCRAM-SHA-256/],
    [{ auth: 'md5' }, /SCRAM-SHA-256/],
    [{ badSignature: true }, /server signature/],
  ]) {
    await withServer(opts, async ({ port, seen }) => {
      // A connection that wrongly succeeds is closed, so a regression fails here instead of holding the process open.
      const attempt = connect({ host: '127.0.0.1', port, user: 'gateway', password: PASSWORD, database: 'gateway', upgrade: plain })
        .then(async (db) => { await db.close(); return 'connected'; });
      await assert.rejects(attempt, pattern, JSON.stringify(opts));
      assert.deepEqual(seen.queries, [], `no query after ${JSON.stringify(opts)}`);
    });
  }
});

test('T-141 an ErrorResponse rejects the query with its SQLSTATE and message, and the connection stays usable', async () => {
  await withServer({ error: true }, async ({ port }) => {
    const db = await connect({ host: '127.0.0.1', port, user: 'gateway', password: PASSWORD, database: 'gateway', upgrade: plain });
    await assert.rejects(db.query('select * from nope'), (e) => e.code === '42P01' && /does not exist/.test(e.message));
    await assert.rejects(db.query('select * from nope'), (e) => e.code === '42P01');
    await db.close();
  });
});

test('T-141 the default upgrade is TLS with certificate and host name verification', async () => {
  const { tlsOptions } = await import('../admin-ui/server/pg-wire.mjs');
  const o = tlsOptions('psql-claude-gw-x.postgres.database.azure.com');
  assert.equal(o.servername, 'psql-claude-gw-x.postgres.database.azure.com');
  assert.notEqual(o.rejectUnauthorized, false);
});
