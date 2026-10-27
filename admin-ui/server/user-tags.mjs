// Business-unit tags (ADR-0015): department, cost center, company, office and division for each user, kept in the
// gateway's managed PostgreSQL by Entra object ID, instead of Entra attributes written with User.ReadWrite.All.
// admin-ui reads the database credential from the gateway app with the Container Apps Contributor role it already
// holds; nothing is copied.
import { connect as pgConnect } from './pg-wire.mjs';

export const TAGS = Object.freeze([
  { key: 'department', column: 'department', label: 'Department' },
  { key: 'costCenter', column: 'cost_center', label: 'Cost center' },
  { key: 'companyName', column: 'company', label: 'Company' },
  { key: 'officeLocation', column: 'office', label: 'Office' },
  { key: 'division', column: 'division', label: 'Division' },
]);
const BY_KEY = new Map(TAGS.map((t) => [t.key, t]));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE = /^[^\x00-\x1f\x7f]{1,64}$/;
const MAX_IMPORT_ROWS = 5000;
const UNAVAILABLE = 'Business-unit tags are kept in the gateway\'s managed PostgreSQL. This gateway uses the database inside its own app, which the console cannot reach; install or move to the managed database option to tag users.';
const SCHEMA = [
  'CREATE SCHEMA IF NOT EXISTS admin_console',
  'CREATE TABLE IF NOT EXISTS admin_console.user_tags (object_id uuid PRIMARY KEY, department text, cost_center text, company text, office text, division text, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text)',
];
// CSV header names accepted for each column, compared without case, spaces or underscores.
const HEADERS = {
  user: ['user', 'upn', 'email', 'mail', 'userprincipalname', 'objectid', 'id'],
  department: ['department'], costCenter: ['costcenter'], companyName: ['company', 'companyname'],
  officeLocation: ['office', 'officelocation'], division: ['division'],
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const isGuid = (v) => GUID.test(String(v ?? ''));
const tidy = (v) => (v === null ? null : String(v).trim());

/** Problems with a change set: known keys only, each value 1 to 64 characters without control characters, or null. */
export function tagErrors(changes) {
  const keys = Object.keys(changes ?? {});
  if (!keys.length) return ['send at least one of department, costCenter, companyName, officeLocation, division'];
  const errors = [];
  for (const key of keys) {
    if (!BY_KEY.has(key)) { errors.push(`${key} is not a business-unit tag`); continue; }
    const v = changes[key];
    if (v === null) continue;
    if (typeof v !== 'string' || !VALUE.test(v.trim())) errors.push(`${key} must be 1 to 64 characters without control characters, or null to clear it`);
  }
  return errors;
}

const fromRow = (row) => Object.fromEntries(TAGS.map((t) => [t.key, row?.[t.column] ?? null]));

/**
 * The gateway's database credential, from the gateway app: GATEWAY_PG_HOST, GATEWAY_PG_USER (default gateway) and the
 * pg-password secret. A host of 127.0.0.1 is the in-app sidecar database, which admin-ui cannot reach.
 */
export async function gatewayDatabase({ arm, resourceId }) {
  const app = (await arm('GET', `${resourceId}?api-version=2024-03-01`)).json;
  const containers = app?.properties?.template?.containers ?? [];
  const env = (containers.find((c) => (c.env ?? []).some((e) => e.name === 'GATEWAY_PG_HOST')) ?? containers[0])?.env ?? [];
  const value = (name) => env.find((e) => e.name === name)?.value ?? null;
  const host = value('GATEWAY_PG_HOST');
  if (!host || host === '127.0.0.1' || host === 'localhost') return { unavailable: true, reason: UNAVAILABLE };
  const secretName = env.find((e) => e.name === 'GATEWAY_PG_PASSWORD')?.secretRef ?? 'pg-password';
  const secrets = (await arm('POST', `${resourceId}/listSecrets?api-version=2024-03-01`)).json?.value ?? [];
  const password = secrets.find((s) => s.name === secretName)?.value;
  if (!password) throw fail(502, `the gateway app has no ${secretName} secret value; business-unit tags cannot connect`);
  return { host, user: value('GATEWAY_PG_USER') ?? 'gateway', password, database: 'gateway' };
}

/** RFC 4180 records: quoted fields with "" escapes, CRLF or LF, a leading byte-order mark ignored. */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function columnsOf(header) {
  const norm = (h) => String(h).toLowerCase().replace(/[\s_]/g, '');
  const at = {};
  header.forEach((h, i) => {
    const key = Object.entries(HEADERS).find(([, names]) => names.includes(norm(h)))?.[0];
    if (!key) throw fail(400, `unknown CSV column "${h}"; use user, department, costCenter, company, office, division`);
    at[key] = i;
  });
  if (!('user' in at)) throw fail(400, 'the CSV needs a user column (UPN, email or object ID)');
  return at;
}

/**
 * credential: async () => {host, user, password, database} or {unavailable, reason}. connect: pg-wire's connect.
 */
export function createTagStore({ credential, connect = pgConnect }) {
  let schemaReady = false;
  async function withDb(fn) {
    const cred = await credential();
    if (cred?.unavailable) throw fail(503, cred.reason);
    const db = await connect(cred);
    try {
      if (!schemaReady) { for (const sql of SCHEMA) await db.query(sql); schemaReady = true; }
      return await fn(db);
    } finally {
      await db.close();
    }
  }
  async function write(db, objectId, changes, by) {
    const cols = TAGS.filter((t) => t.key in changes);
    const values = cols.map((t) => tidy(changes[t.key]));
    const names = cols.map((t) => t.column);
    const sql = `INSERT INTO admin_console.user_tags (object_id, ${names.join(', ')}, updated_at, updated_by) ` +
      `VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')}, now(), $${names.length + 2}) ` +
      `ON CONFLICT (object_id) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(', ')}, updated_at = now(), updated_by = EXCLUDED.updated_by ` +
      'RETURNING object_id, department, cost_center, company, office, division';
    const row = (await db.query(sql, [objectId.toLowerCase(), ...values, by ?? null])).rows[0];
    return { objectId: row?.object_id ?? objectId.toLowerCase(), ...fromRow(row) };
  }
  const check = (objectId, changes) => {
    if (!isGuid(objectId)) throw fail(400, 'the user must be an Entra object ID');
    const errors = tagErrors(changes);
    if (errors.length) throw fail(400, errors.join('; '));
  };
  return {
    async status() {
      try {
        const cred = await credential();
        return cred?.unavailable ? { available: false, reason: cred.reason } : { available: true };
      } catch (e) { return { available: false, reason: e.message }; }
    },
    async all() {
      return withDb(async (db) => new Map((await db.query('SELECT object_id, department, cost_center, company, office, division FROM admin_console.user_tags')).rows
        .map((r) => [String(r.object_id).toLowerCase(), fromRow(r)])));
    },
    async set(objectId, changes, by) {
      check(objectId, changes);
      return withDb((db) => write(db, objectId, changes, by));
    },
    /** resolve(user cell) -> object ID or null. Empty cells leave a tag unchanged. */
    async importCsv(text, { resolve, by }) {
      const [header, ...rows] = parseCsv(text);
      if (!header) throw fail(400, 'the CSV is empty');
      const at = columnsOf(header);
      if (rows.length > MAX_IMPORT_ROWS) throw fail(400, `the CSV has ${rows.length} rows; import at most ${MAX_IMPORT_ROWS} at a time`);
      const plan = [];
      const skipped = [];
      for (const [i, r] of rows.entries()) {
        const line = i + 2;
        const user = (r[at.user] ?? '').trim();
        const changes = Object.fromEntries(TAGS.filter((t) => t.key in at && (r[at[t.key]] ?? '').trim() !== '').map((t) => [t.key, r[at[t.key]].trim()]));
        if (!user) { skipped.push({ line, user, reason: 'no user' }); continue; }
        const errors = Object.keys(changes).length ? tagErrors(changes) : ['no tag value on this line'];
        if (errors.length) { skipped.push({ line, user, reason: errors.join('; ') }); continue; }
        const objectId = await resolve(user);
        if (!objectId) { skipped.push({ line, user, reason: 'no Entra user with this UPN, email or object ID' }); continue; }
        plan.push({ line, objectId, changes });
      }
      const updated = plan.length ? await withDb(async (db) => {
        const done = [];
        for (const p of plan) { await write(db, p.objectId, p.changes, by); done.push({ line: p.line, objectId: p.objectId.toLowerCase() }); }
        return done;
      }) : [];
      return { updated, skipped };
    },
  };
}
