// Live checks that run inside ACR Tasks, from Azure addresses outside the tester's allow list, with the
// deployed image and no local Docker (docs/TEST-PLAN.md T-02, T-05, T-42, T-43).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressInside, cidrContains } from '../../infra/azure-test/lib/plan.mjs';
import { redactSecrets } from '../../infra/azure-test/lib/secrets.mjs';
import { runAz } from '../../infra/azure-test/lib/spawn.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE_DIR = path.join(root, 'infra', 'azure-test', 'image');
const CONFIG = path.join(root, 'config', 'gateway.azure-test.yaml');
const PROBE = 'mcr.microsoft.com/azure-cli:latest';

// Values for the gateway's ${VAR} references in the negative boots; none is a real credential.
const DUMMY_ENV = [
  'GATEWAY_PUBLIC_URL=https://gateway.example.invalid',
  'OIDC_ISSUER=https://login.microsoftonline.com/common/v2.0',
  'OIDC_CLIENT_ID=00000000-0000-0000-0000-000000000000',
  'OIDC_CLIENT_SECRET=negative-boot-check-not-a-secret',
  'ALLOWED_EMAIL_DOMAIN=example.invalid',
  'GATEWAY_JWT_SECRET=negative-boot-check-not-a-signing-secret-0000000000',
  'GATEWAY_PG_PASSWORD=negative-boot-check-not-a-password',
  'FOUNDRY_RESOURCE=example-foundry',
  'TESTER_CIDR=203.0.113.0/24',
];

function taskDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-task-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function acrRun(state, dir, file, values) {
  const sets = Object.entries(values).flatMap(([k, v]) => ['--set', `${k}=${v}`]);
  const r = runAz(['acr', 'run', '--registry', state.acrName, '--file', file, ...sets, dir], { allowFailure: true });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`az acr run exited ${r.status}: ${redactSecrets(`${r.stdout}\n${r.stderr}`).trim().slice(-600)}`);
  return r.stdout;
}

// A task step's `cmd` in single quotes, so `: ` inside a header value stays one YAML scalar.
const cmd = (text) => `    cmd: '${text.replace(/'/g, "''")}'`;

// The output of one ACR Tasks step: from its "Executing step ID" line to the next line ACR itself
// writes about a step or the run.
const ACR_LINE = /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d (?:Executing step ID: |Step ID: |Container failed during run)|^Run ID: /m;
function stepLog(log, id) {
  const header = `Executing step ID: ${id}.`;
  const start = log.indexOf(header);
  if (start < 0) return null;
  const rest = log.slice(start + header.length);
  const end = rest.search(ACR_LINE);
  return rest.slice(0, end < 0 ? undefined : end);
}
// With ignoreErrors, ACR reports a non-zero exit this way and still marks the step successful.
const stepFailed = (log, id) => new RegExp(`Step ID: ${id} (?:encountered an error: exit status [1-9]|marked as failed)`).test(log);

export async function checkOutside(c, { state, base, testerCidr, http, bracket }) {
  const inside = await http('GET', `${base}/.well-known/oauth-authorization-server`);
  c.expect(inside.status === 200, `from the tester's machine: ${inside.status}`);
  // The forged entry must name an address the allow list admits; otherwise a 403 proves nothing.
  const forgedIp = addressInside(testerCidr);
  if (!cidrContains(testerCidr, forgedIp)) throw new Error(`forged address ${forgedIp} is outside ${testerCidr}`);
  const probe = (flags) => `${PROBE} curl -sS --max-time 20 -D - ${flags} {{.Values.url}}`;
  const task = [
    'version: v1.1.0',
    'steps:',
    '  - id: egress',
    cmd(`${PROBE} curl -sS --max-time 20 -w "\\nEGRESS_END\\n" https://api.ipify.org`),
    '    ignoreErrors: true',
    '  - id: plain',
    cmd(probe('-w "\\nPLAIN_STATUS=%{http_code}\\n"')),
    '    ignoreErrors: true',
    '  - id: forged',
    cmd(probe('-H "X-Forwarded-For: {{.Values.forged}}" -w "\\nFORGED_STATUS=%{http_code}\\n"')),
    '    ignoreErrors: true',
    '',
  ].join('\n');
  const { result: log, events } = await bracket(async () => acrRun(state, taskDir({ 'outside.yaml': task }), 'outside.yaml',
    { url: `${base}/.well-known/oauth-authorization-server`, forged: forgedIp }));
  const egress = /(\d{1,3}(?:\.\d{1,3}){3})\s*\r?\n\s*EGRESS_END/.exec(stepLog(log, 'egress') ?? '')?.[1];
  // Container Apps refuses a denied address in its Envoy ingress with a plain-text "RBAC: access
  // denied"; the gateway's own refusals are JSON, so the body attributes each 403.
  const answer = (id, marker) => {
    const out = stepLog(log, id) ?? '';
    return { status: new RegExp(`${marker}=(\\d{3})`).exec(out)?.[1], ingress: /^content-type: text\/plain/mi.test(out) && /^RBAC: access denied$/m.test(out) };
  };
  const plain = answer('plain', 'PLAIN_STATUS');
  const forged = answer('forged', 'FORGED_STATUS');
  c.note(`ACR Tasks egress ${egress ?? 'unknown'}; plain ${plain.status}; forged X-Forwarded-For ${forgedIp}: ${forged.status}; ingress denial body: ${plain.ingress && forged.ingress}`);
  if (!egress) return c.block('the runner egress address was not captured');
  if (cidrContains(testerCidr, egress)) return c.block(`the runner egress ${egress} lies inside ${testerCidr}`);
  c.expect(plain.status === '403', `outside request: ${plain.status} (000 means DNS or TLS failed, which does not count)`);
  c.expect(forged.status === '403', `outside request with forged X-Forwarded-For: ${forged.status}`);
  c.expect(plain.ingress && forged.ingress, 'both refusals carry the ingress denial body, not a gateway response');
  if (!events) return c.block('log coverage for the outside requests could not be established');
  const seen = events.filter((e) => e.client_ip === egress || e.client_ip === forgedIp);
  c.expect(seen.length === 0, `gateway audit events from ${egress} or ${forgedIp} during the run: ${seen.length}`);
}

export async function checkBoot(c, { state }) {
  const config = fs.readFileSync(CONFIG, 'utf8');
  const env = DUMMY_ENV.map((e) => `      - ${e}`).join('\n');
  const step = (id, command) => [`  - id: ${id}`, cmd(`{{.Values.image}} ${command}`), '    env:', env, '    timeout: 180', '    ignoreErrors: true'].join('\n');
  const task = ['version: v1.1.0', 'steps:',
    ['  - id: version', cmd('{{.Values.image}} claude --version'), '    ignoreErrors: true'].join('\n'),
    step('no-store', 'claude gateway --config /workspace/gateway.yaml'),
    step('unknown-key', 'claude gateway --config /workspace/unknown-key.yaml'), ''].join('\n');
  const log = acrRun(state, taskDir({ 'boot.yaml': task, 'gateway.yaml': config, 'unknown-key.yaml': `${config}\nnot_a_gateway_key: true\n` }),
    'boot.yaml', { image: state.images.gateway });
  const version = stepLog(log, 'version') ?? '';
  c.note(`claude --version: ${/\d+\.\d+\.\d+ \(Claude Code\)/.exec(version)?.[0] ?? 'not found'}`);
  c.expect(/2\.1\.280 \(Claude Code\)/.test(version), 'the image runs Claude Code 2.1.280');
  for (const [id, pattern, label] of [['no-store', /could not connect to Postgres|store\.postgres_url/, 'names the store'], ['unknown-key', /not_a_gateway_key/, 'names the unknown key']]) {
    // The container's own output only: ACR's timestamped runner lines name the step itself ("no-store").
    const out = (stepLog(log, id) ?? '').split(/\r?\n/).filter((l) => l.trim() && !/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /.test(l)).join('\n');
    const named = out.split('\n').map((l) => l.trim()).find((l) => pattern.test(l)) ?? '';
    c.note(`${id}: "${named.slice(0, 160)}"`);
    c.expect(stepFailed(log, id), `${id} exits non-zero`);
    c.expect(!/listening on/.test(out), `${id} never reaches the listening line`);
    c.expect(pattern.test(out), `${id} ${label}`);
  }
}

export async function checkBuild(c, { state }) {
  const tag = `claude-gateway:negative-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
  const r = runAz(['acr', 'build', '--registry', state.acrName, '--image', tag, '--build-arg', `CLAUDE_SHA256=${'0'.repeat(64)}`, IMAGE_DIR], { allowFailure: true });
  const log = `${r.stdout}\n${r.stderr}`;
  c.expect(r.status !== 0, `build with an unlisted checksum exits ${r.status}`);
  c.expect(/manifest checksum for linux-x64 is not the pinned value/.test(log), 'verify-release.sh names the checksum mismatch');
  const pushed = runAz(['acr', 'repository', 'show', '--name', state.acrName, '--image', tag], { allowFailure: true });
  c.expect(pushed.status !== 0, `no image pushed as ${tag}`);
}
