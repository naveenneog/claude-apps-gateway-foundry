import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  SseParser, admissionFindings, alterToken, decodeJwt, deviceTokenOutcome, inferenceFindings, inferenceUpstream, isRoleAdmissionDenial,
  isSignInDenial, nextJournal, parseLogLines, quietGaps, reconcilePendingRestore, refreshFindings, refusedCliFindings, relayEvidence, restoreCommand,
  runThroughRelay, signHs256, startCaptureRelay, subjectMatch, tamperJwtPayload, withArmRoleRemoved, withRoleRemoved,
} from './live/lib.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

test('signHs256 produces a token whose signature verifies with the same secret only', () => {
  const token = signHs256({ sub: 'u1', exp: 2000000000 }, 'k'.repeat(32));
  const [h, p, s] = token.split('.');
  assert.deepEqual(decodeJwt(token).header, { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(decodeJwt(token).payload, { sub: 'u1', exp: 2000000000 });
  assert.equal(s, b64url(crypto.createHmac('sha256', 'k'.repeat(32)).update(`${h}.${p}`).digest()));
  assert.notEqual(s, b64url(crypto.createHmac('sha256', 'j'.repeat(32)).update(`${h}.${p}`).digest()));
});

test('tamperJwtPayload changes the payload and keeps the header and signature bytes', () => {
  const token = signHs256({ sub: 'u1', exp: 2000000000 }, 'k'.repeat(32));
  const tampered = tamperJwtPayload(token);
  const [h1, p1, s1] = token.split('.');
  const [h2, p2, s2] = tampered.split('.');
  assert.equal(h2, h1);
  assert.equal(s2, s1);
  assert.notEqual(p2, p1);
  assert.notEqual(decodeJwt(tampered).payload.sub, 'u1');
});

test('decodeJwt refuses text that is not three base64url parts of JSON', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', `${b64url('{')}.${b64url('{}')}.x`]) {
    assert.throws(() => decodeJwt(bad), /not a JWT/, JSON.stringify(bad));
  }
});

test('parseLogLines separates audit events from operational lines, raw or wrapped by the log stream', () => {
  const lines = [
    '{"ts":"2026-09-23T10:00:00.000Z","evt":"config.load","path":"/etc/claude/gateway.yaml"}',
    JSON.stringify({ TimeStamp: '2026-09-23T10:00:01Z', Log: '{"ts":"2026-09-23T10:00:01.000Z","evt":"inference","status":200}' }),
    '[gateway] 2026-09-23T10:00:02.000Z info claude gateway listening on http://0.0.0.0:8080',
    JSON.stringify({ TimeStamp: '2026-09-23T10:00:03Z', Log: 'plain text from postgres' }),
    '{"not":"an audit event"}',
    '',
    // The Container Apps log stream puts the container runtime's timestamp in front of each line.
    JSON.stringify({ TimeStamp: '2026-09-23T10:00:04Z', Log: '2026-09-23T10:00:04.123456789Z {"ts":"2026-09-23T10:00:04.123Z","evt":"auth.denied","request_id":"r1"}' }),
  ];
  const { audit, operational } = parseLogLines(lines);
  assert.deepEqual(audit.map((e) => e.evt), ['config.load', 'inference', 'auth.denied']);
  assert.equal(audit[1].status, 200);
  assert.equal(audit[2].request_id, 'r1');
  assert.deepEqual(operational, [
    '[gateway] 2026-09-23T10:00:02.000Z info claude gateway listening on http://0.0.0.0:8080',
    'plain text from postgres',
    '{"not":"an audit event"}',
  ]);
});

test('SseParser reassembles events split across chunks, CRLF or LF, and skips comments', () => {
  const parser = new SseParser();
  const events = [
    ...parser.feed('event: message_start\ndata: {"type":"mess'),
    ...parser.feed('age_start"}\n\n: keep-alive comment\n\nevent: ping\r\ndata: {"type": "ping"}\r\n\r\n'),
    ...parser.feed('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
  ];
  assert.deepEqual(events.map((e) => e.event), ['message_start', 'ping', 'message_stop']);
  assert.deepEqual(JSON.parse(events[0].data), { type: 'message_start' });
  assert.deepEqual(parser.feed('event: partial\ndata: {'), [], 'an unterminated event is held back');
});

test('deviceTokenOutcome maps RFC 8628 token responses, and nothing else counts as success', () => {
  assert.equal(deviceTokenOutcome(200, { access_token: 'x', token_type: 'Bearer' }), 'token');
  assert.equal(deviceTokenOutcome(200, {}), 'error');
  assert.equal(deviceTokenOutcome(400, { error: 'authorization_pending' }), 'pending');
  assert.equal(deviceTokenOutcome(400, { error: 'slow_down' }), 'slow_down');
  assert.equal(deviceTokenOutcome(429, { error: 'slow_down' }), 'slow_down', 'the gateway protocol allows 400 or 429 for slow_down');
  assert.equal(deviceTokenOutcome(429, { error: 'authorization_pending' }), 'error');
  assert.equal(deviceTokenOutcome(400, { error: 'access_denied' }), 'denied');
  assert.equal(deviceTokenOutcome(400, { error: 'expired_token' }), 'expired');
  assert.equal(deviceTokenOutcome(500, { error: 'authorization_pending' }), 'error');
  assert.equal(deviceTokenOutcome(400, null), 'error');
});

// A fake Graph holding app role assignments, recording every call (security review, 2026-09-23).
function fakeGraph(assignments, { failDelete = false } = {}) {
  const calls = [];
  let next = 1;
  const graph = async (method, url, body) => {
    calls.push(method);
    if (method === 'GET') return { status: 200, json: { value: assignments.map((a) => ({ ...a })) } };
    if (method === 'DELETE') {
      if (failDelete) throw Object.assign(new Error('DELETE returned 404'), { status: 404 });
      const id = url.split('/').pop();
      assignments.splice(assignments.findIndex((a) => a.id === id), 1);
      return { status: 204, json: null };
    }
    if (method === 'POST') {
      const created = { id: `restored-${next++}`, principalId: body.principalId, appRoleId: body.appRoleId, resourceId: body.resourceId };
      assignments.push(created);
      return { status: 201, json: created };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { graph, calls, assignments };
}
const target = { servicePrincipalId: 'sp1', principalId: 'tester', appRoleId: 'standard', assignmentId: 'a1' };
const held = () => ({ id: 'a1', principalId: 'tester', appRoleId: 'standard', resourceId: 'sp1' });

test('withRoleRemoved never grants a role that is already gone', async () => {
  const fake = fakeGraph([]);
  let ran = false;
  const outcome = await withRoleRemoved({ ...target, graph: fake.graph }, async () => { ran = true; });
  assert.deepEqual(outcome, { removed: false });
  assert.equal(ran, false);
  assert.deepEqual(fake.calls, ['GET']);
  assert.equal(fake.assignments.length, 0);
});

test('withRoleRemoved leaves alone an assignment that is not the recorded one', async () => {
  const fake = fakeGraph([{ ...held(), principalId: 'someone-else' }]);
  const outcome = await withRoleRemoved({ ...target, graph: fake.graph }, async () => {});
  assert.deepEqual(outcome, { removed: false });
  assert.deepEqual(fake.calls, ['GET']);
});

test('withRoleRemoved runs the body without the role, then restores it and reports the new id', async () => {
  const fake = fakeGraph([held()]);
  let during;
  let restoredId;
  const outcome = await withRoleRemoved({ ...target, graph: fake.graph, onRestored: (id) => { restoredId = id; } }, async () => {
    during = fake.assignments.length;
    return 'done';
  });
  assert.equal(during, 0, 'the role is absent while the body runs');
  assert.deepEqual(outcome, { removed: true, result: 'done' });
  assert.deepEqual(fake.calls, ['GET', 'DELETE', 'POST']);
  assert.equal(restoredId, 'restored-1');
  assert.equal(fake.assignments.length, 1);
});

test('withRoleRemoved restores the role when the body throws, and grants nothing when the delete fails', async () => {
  const fake = fakeGraph([held()]);
  await assert.rejects(withRoleRemoved({ ...target, graph: fake.graph }, async () => { throw new Error('sign-in broke'); }), /sign-in broke/);
  assert.deepEqual(fake.calls, ['GET', 'DELETE', 'POST']);
  const failing = fakeGraph([held()], { failDelete: true });
  await assert.rejects(withRoleRemoved({ ...target, graph: failing.graph }, async () => {}), /404/);
  assert.deepEqual(failing.calls, ['GET', 'DELETE'], 'no POST after a failed delete');
});
test('quietGaps finds upstream silences longer than the threshold and counts the pings inside them', () => {
  const at = (s, event) => ({ event, at: s * 1000 });
  const events = [at(0, 'message_start'), at(1, 'content_block_delta'), at(16, 'ping'), at(31, 'ping'), at(33, 'content_block_delta'),
    at(34, 'content_block_delta'), at(40, 'message_stop')];
  assert.deepEqual(quietGaps(events), [{ fromMs: 1000, toMs: 33000, pings: 2 }]);
  assert.deepEqual(quietGaps([at(0, 'message_start'), at(10, 'message_stop')]), [], 'no gap past 15 s');
  assert.deepEqual(quietGaps([at(0, 'message_start'), at(20, 'message_stop')]), [{ fromMs: 0, toMs: 20000, pings: 0 }]);
});

test('isSignInDenial accepts only a refusal on the sign-in path, not a missing token on inference', () => {
  assert.ok(isSignInDenial({ evt: 'auth.denied', reason: 'group not allowed', path: '/oauth/callback' }));
  assert.ok(!isSignInDenial({ evt: 'auth.denied', reason: 'missing_token', path: '/v1/messages' }));
  assert.ok(!isSignInDenial({ evt: 'auth.denied', reason: 'missing_token' }), 'no path, missing token');
  assert.ok(!isSignInDenial({ evt: 'session.mint', path: '/oauth/callback' }));
});

// A fake ARM holding one role assignment (T-06 negative: the gateway identity loses its Foundry role).
function fakeArm({ principalId = 'mi', present = true, failDelete = false } = {}) {
  const calls = [];
  let exists = present;
  const arm = async (method, url, body) => {
    calls.push(method);
    if (method === 'GET') return exists
      ? { status: 200, json: { properties: { principalId, roleDefinitionId: '/role/x', scope: '/acct' } } }
      : { status: 404, json: null };
    if (method === 'DELETE') { if (failDelete) throw Object.assign(new Error('DELETE returned 403'), { status: 403 }); exists = false; return { status: 200 }; }
    if (method === 'PUT') { exists = true; calls.push(JSON.stringify(body.properties)); return { status: 201 }; }
    throw new Error(`unexpected ${method}`);
  };
  return { arm, calls, get exists() { return exists; } };
}

test('withArmRoleRemoved removes and restores only the recorded assignment of the gateway identity', async () => {
  const ok = fakeArm();
  let during;
  const outcome = await withArmRoleRemoved({ arm: ok.arm, assignmentId: '/acct/ra/1', principalId: 'mi' }, async () => { during = ok.exists; return 'x'; });
  assert.deepEqual(outcome, { removed: true, result: 'x' });
  assert.equal(during, false);
  assert.deepEqual(ok.calls, ['GET', 'DELETE', 'PUT', '{"roleDefinitionId":"/role/x","principalId":"mi","principalType":"ServicePrincipal"}']);
  for (const [label, fake] of [['missing', fakeArm({ present: false })], ['another principal', fakeArm({ principalId: 'someone' })]]) {
    assert.deepEqual(await withArmRoleRemoved({ arm: fake.arm, assignmentId: '/acct/ra/1', principalId: 'mi' }, async () => {}), { removed: false }, label);
    assert.deepEqual(fake.calls, ['GET'], `${label}: nothing deleted or created`);
  }
  const failing = fakeArm({ failDelete: true });
  await assert.rejects(withArmRoleRemoved({ arm: failing.arm, assignmentId: '/acct/ra/1', principalId: 'mi' }, async () => {}), /403/);
  assert.deepEqual(failing.calls, ['GET', 'DELETE']);
});
test('both removals journal "removing" before the delete and "removed" after it, and clear the record when the delete fails', async () => {
  const order = [];
  const fake = fakeGraph([held()]);
  const graph = async (...args) => { order.push(args[0]); return fake.graph(...args); };
  const journal = (record) => order.push(record ? `journal:${record.kind}:${record.phase}` : 'journal:clear');
  await withRoleRemoved({ ...target, graph, journal }, async () => {});
  assert.deepEqual(order, ['GET', 'journal:appRole:removing', 'DELETE', 'journal:appRole:removed', 'journal:appRole:restoring', 'POST', 'journal:clear']);
  const none = [];
  await withRoleRemoved({ ...target, graph: fakeGraph([]).graph, journal: () => none.push('journal') }, async () => {});
  assert.deepEqual(none, [], 'nothing removed, nothing journalled');
  const failed = [];
  await assert.rejects(withRoleRemoved({ ...target, graph: fakeGraph([held()], { failDelete: true }).graph,
    journal: (record) => failed.push(record ? record.phase : 'clear') }, async () => {}), /404/);
  assert.deepEqual(failed, ['removing', 'clear'], 'a failed delete leaves no record behind');
  const armOrder = [];
  const fakeA = fakeArm();
  const arm = async (...args) => { armOrder.push(args[0]); return fakeA.arm(...args); };
  const records = [];
  await withArmRoleRemoved({ arm, assignmentId: '/acct/ra/1', principalId: 'mi', journal: (r) => { records.push(r); armOrder.push('journal'); } }, async () => {});
  assert.deepEqual(armOrder, ['GET', 'journal', 'DELETE', 'journal', 'journal', 'PUT', 'journal']);
  assert.deepEqual(records.map((r) => r?.phase ?? 'clear'), ['removing', 'removed', 'restoring', 'clear']);
  assert.deepEqual(records[1], { kind: 'armRole', phase: 'removed', assignmentId: '/acct/ra/1', principalId: 'mi', roleDefinitionId: '/role/x' });
  const armFailed = [];
  await assert.rejects(withArmRoleRemoved({ arm: fakeArm({ failDelete: true }).arm, assignmentId: '/acct/ra/1', principalId: 'mi',
    journal: (r) => armFailed.push(r ? r.phase : 'clear') }, async () => {}), /403/);
  assert.deepEqual(armFailed, ['removing', 'clear']);
});
test('reconcilePendingRestore puts back what an interrupted run removed, and nothing else', async () => {
  assert.equal(await reconcilePendingRestore({ pending: null }), null);
  const gone = fakeGraph([]);
  const appRole = { kind: 'appRole', phase: 'removed', servicePrincipalId: 'sp1', principalId: 'tester', appRoleId: 'standard' };
  assert.deepEqual(await reconcilePendingRestore({ pending: appRole, graph: gone.graph }), { restored: true, assignmentId: 'restored-1' });
  assert.deepEqual(gone.calls, ['GET', 'POST']);
  const still = fakeGraph([held()]);
  assert.deepEqual(await reconcilePendingRestore({ pending: appRole, graph: still.graph }), { restored: false, assignmentId: 'a1' });
  assert.deepEqual(still.calls, ['GET']);
  const armGone = fakeArm({ present: false });
  const armRole = { kind: 'armRole', phase: 'removed', assignmentId: '/acct/ra/1', principalId: 'mi', roleDefinitionId: '/role/x' };
  assert.deepEqual(await reconcilePendingRestore({ pending: armRole, arm: armGone.arm }), { restored: true, assignmentId: '/acct/ra/1' });
  assert.deepEqual(armGone.calls.slice(0, 2), ['GET', 'PUT']);
  const armStill = fakeArm();
  assert.deepEqual(await reconcilePendingRestore({ pending: armRole, arm: armStill.arm }), { restored: false, assignmentId: '/acct/ra/1' });
  await assert.rejects(reconcilePendingRestore({ pending: { kind: 'other', phase: 'removed' } }), /unknown/);
  // A run that died while removing may or may not have removed anything: nothing is granted from it.
  for (const pending of [{ ...appRole, phase: 'removing' }, { ...armRole, phase: 'removing' }, { ...appRole, phase: undefined }]) {
    const g = fakeGraph([]);
    const a = fakeArm({ present: false });
    assert.deepEqual(await reconcilePendingRestore({ pending, graph: g.graph, arm: a.arm }), { restored: false, ambiguous: true });
    assert.deepEqual([...g.calls, ...a.calls], [], 'no read, no grant');
  }
});
test('a transport failure during the delete keeps the "removing" record, because the outcome is unknown', async () => {
  const records = [];
  const graph = async (method) => {
    if (method === 'GET') return { status: 200, json: { value: [held()] } };
    if (method === 'DELETE') throw new Error('socket hang up');
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(withRoleRemoved({ ...target, graph, journal: (r) => records.push(r ? r.phase : 'clear') }, async () => {}), /hang up/);
  assert.deepEqual(records, ['removing'], 'no status, so the record stays for an operator to resolve');
});

test('isRoleAdmissionDenial needs a refusal of the sign-in callback for a group or role reason', () => {
  assert.ok(isRoleAdmissionDenial({ evt: 'auth.denied', reason: 'user not in allowed_groups', path: '/oauth/callback' }));
  assert.ok(!isRoleAdmissionDenial({ evt: 'auth.denied', reason: 'invalid state', path: '/oauth/callback' }), 'another OAuth failure');
  assert.ok(!isRoleAdmissionDenial({ evt: 'auth.denied', reason: 'missing_token', path: '/managed/settings' }));
  assert.ok(!isRoleAdmissionDenial({ evt: 'auth.denied', reason: 'role missing', path: '/v1/messages' }));
  assert.ok(!isRoleAdmissionDenial({ evt: 'auth.denied', reason: 'role missing', path: '/device/callback' }), 'only the OAuth callback');
  assert.ok(isRoleAdmissionDenial({ evt: 'auth.denied', reason: 'no allowed role', path: '/oauth/callback?code=x' }));
  assert.ok(isSignInDenial({ evt: 'auth.denied', reason: 'invalid state', path: '/oauth/callback' }), 'still ends the wait');
});

test('inferenceUpstream reads the upstream field only, and subjectMatch needs an identity field', () => {
  assert.equal(inferenceUpstream({ upstream: 'foundry', email: 'x@foundry.example' }), 'foundry');
  assert.equal(inferenceUpstream({ provider: 'foundry' }), 'foundry');
  assert.equal(inferenceUpstream({ upstream: 'anthropic', note: 'foundry' }), 'anthropic', 'the word elsewhere does not count');
  assert.equal(inferenceUpstream({ status: 200 }), null);
  const claims = { sub: 's1', email: 'a@example.com' };
  assert.equal(subjectMatch({ sub: 's1' }, claims), 'match');
  assert.equal(subjectMatch({ sub: 's2', email: 'a@example.com' }, claims), 'mismatch', 'sub decides when present');
  assert.equal(subjectMatch({ email: 'a@example.com' }, claims), 'match');
  assert.equal(subjectMatch({ email: 'b@example.com' }, claims), 'mismatch');
  assert.equal(subjectMatch({ status: 200 }, claims), 'unknown');
});
const claims = { sub: 'tester-sub', email: 'tester@example.com' };
const inRange = (ip) => typeof ip === 'string' && ip.startsWith('203.0.113.');

test('inferenceFindings: a missing field is a gap in the evidence, a wrong value is a failure', () => {
  const full = { evt: 'inference', status: 200, upstream: 'foundry', model: 'claude-sonnet-5', sub: 'tester-sub' };
  assert.deepEqual(inferenceFindings(full, { claims, model: 'claude-sonnet-5' }), { block: [], fail: [] });
  // The QA reproduction (round 2): a subjectless Foundry success used to pass.
  const subjectless = inferenceFindings({ ...full, sub: undefined }, { claims, model: 'claude-sonnet-5' });
  assert.equal(subjectless.fail.length, 0);
  assert.match(subjectless.block.join(), /sub or email/);
  assert.match(inferenceFindings({ ...full, upstream: undefined, note: 'foundry' }, { claims }).block.join(), /no upstream field/);
  assert.match(inferenceFindings({ ...full, model: undefined }, { claims, model: 'claude-sonnet-5' }).block.join(), /no model field/);
  assert.match(inferenceFindings({ ...full, upstream: 'anthropic' }, { claims }).fail.join(), /upstream anthropic/);
  assert.match(inferenceFindings({ ...full, model: 'claude-opus-5' }, { claims, model: 'claude-sonnet-5' }).fail.join(), /model claude-opus-5/);
  assert.match(inferenceFindings({ ...full, sub: 'someone-else' }, { claims }).fail.join(), /another subject/);
  assert.match(inferenceFindings({ ...full, status: 502 }, { claims }).fail.join(), /status 502/);
  assert.deepEqual(inferenceFindings({ ...full, status: 403 }, { claims, status: [401, 403] }), { block: [], fail: [] });
  assert.match(inferenceFindings({ evt: 'auth.denied' }, { claims }).block.join(), /no inference event/);
});

test('refreshFindings: the refresh of this request and this subject, and none for the altered token', () => {
  const good = { requestId: 'r-good' };
  const own = { evt: 'session.refresh', request_id: 'r-good', sub: 'tester-sub' };
  assert.deepEqual(refreshFindings({ good, goodEvents: [own], badEvents: [], claims }), { block: [], fail: [] });
  // The QA reproduction (round 2): a refresh event of another request used to pass.
  assert.match(refreshFindings({ good, goodEvents: [{ ...own, request_id: 'r-other' }], badEvents: [], claims }).fail.join(), /r-good: 0/);
  assert.match(refreshFindings({ good, goodEvents: [{ ...own, request_id: undefined }], badEvents: [], claims }).block.join(), /request_id/);
  assert.match(refreshFindings({ good, goodEvents: [{ ...own, sub: undefined }], badEvents: [], claims }).block.join(), /no subject/);
  assert.match(refreshFindings({ good, goodEvents: [{ ...own, sub: 'x' }], badEvents: [], claims }).fail.join(), /another subject/);
  assert.match(refreshFindings({ good, goodEvents: [own], badEvents: [{ evt: 'session.refresh' }], claims }).fail.join(), /altered token/);
});

test('admissionFindings: T-04\'s negative needs a role refusal of this sign-in on the callback', () => {
  const role = { evt: 'auth.denied', path: '/oauth/callback', reason: 'user not in allowed_groups', client_ip: '203.0.113.9' };
  assert.deepEqual(admissionFindings({ events: [{ ...role, user_code: 'ABCD-EFGH' }], outcome: 'pending', userCode: 'ABCD-EFGH', inRange }), { block: [], fail: [] });
  // The QA reproduction (round 2): an expired flow plus a missing_token refusal elsewhere used to pass.
  const other = admissionFindings({ events: [{ evt: 'auth.denied', path: '/managed/settings', reason: 'missing_token', client_ip: '203.0.113.9' }], outcome: 'expired', userCode: 'X', inRange });
  assert.equal(other.fail.length, 0);
  assert.match(other.block.join(), /another reason: missing_token on \/managed\/settings/);
  assert.match(admissionFindings({ events: [], outcome: 'expired', userCode: 'X', inRange }).block.join(), /did not happen/);
  assert.match(admissionFindings({ events: [role], outcome: 'token', userCode: 'X', inRange }).fail.join(), /got a token/);
  assert.match(admissionFindings({ events: [{ ...role, user_code: 'OTHER-CODE' }], outcome: 'pending', userCode: 'ABCD-EFGH', inRange }).block.join(), /this sign-in/);
  assert.match(admissionFindings({ events: [{ ...role, user_code: 'X', client_ip: undefined }], outcome: 'pending', userCode: 'X', inRange }).block.join(), /this sign-in/);
  // The Coder and QA reproductions (round 3): another flow's role refusal without a user code used to count.
  assert.match(admissionFindings({ events: [role], outcome: 'expired', userCode: 'ABCD-EFGH', inRange }).block.join(), /this sign-in/);
  assert.match(admissionFindings({ events: [role], outcome: 'denied', userCode: 'ABCD-EFGH', inRange }).block.join(), /this sign-in/, "the flow's own refusal says nothing about whose event this is");
  assert.deepEqual(admissionFindings({ events: [{ ...role, user_code: 'ABCD-EFGH' }], outcome: 'denied', userCode: 'ABCD-EFGH', inRange }), { block: [], fail: [] });
});

test('nextJournal keeps an outstanding restore record from being replaced by another check', () => {
  const armRole = { kind: 'armRole', phase: 'removed', assignmentId: '/ra/1', principalId: 'mi' };
  const appRole = { kind: 'appRole', phase: 'removing', servicePrincipalId: 'sp', principalId: 'tester', appRoleId: 'std' };
  assert.deepEqual(nextJournal(null, appRole), appRole);
  assert.deepEqual(nextJournal({ ...appRole }, { ...appRole, phase: 'removed' }), { ...appRole, phase: 'removed' }, 'the same removal moves on');
  assert.equal(nextJournal(appRole, null), null);
  // The Architect's reproduction (round 2): a failed Foundry-role restore, then the denied check.
  assert.throws(() => nextJournal(armRole, appRole), /armRole restore is outstanding/);
  assert.throws(() => nextJournal(appRole, { ...appRole, appRoleId: 'premium' }), /outstanding/);
});

test('restoreCommand repairs the deployment the record belongs to, with every override it needs (UX review, round 3)', () => {
  const deployment = { group: 'rg-custom', testerCidr: '203.0.113.0/26', emailDomain: 'contoso.example' };
  assert.equal(restoreCommand({ kind: 'appRole' }, deployment),
    'node infra/azure-test/deploy.mjs --resource-group rg-custom --tester-cidr 203.0.113.0/26 --email-domain contoso.example --step entra');
  const armRole = { kind: 'armRole', assignmentId: '/subscriptions/s/resourceGroups/rg-ai-other/providers/Microsoft.CognitiveServices/accounts/ai-other/providers/Microsoft.Authorization/roleAssignments/r1' };
  assert.equal(restoreCommand(armRole, deployment),
    'node infra/azure-test/deploy.mjs --resource-group rg-custom --tester-cidr 203.0.113.0/26 --foundry-resource-group rg-ai-other --foundry-account ai-other --step base');
  assert.equal(restoreCommand({ kind: 'appRole' }, { ...deployment, emailDomain: undefined }),
    'node infra/azure-test/deploy.mjs --resource-group rg-custom --tester-cidr 203.0.113.0/26 --step entra');
  assert.throws(() => restoreCommand({ kind: 'armRole', assignmentId: '/somewhere/else' }, deployment), /Foundry account/);
  assert.throws(() => restoreCommand({ kind: 'other' }, deployment), /unknown/);
});
test('alterToken changes the decoded bytes, where changing the last character may not', () => {
  for (let i = 0; i < 64; i++) {
    const token = crypto.randomBytes(32).toString('base64url');
    const altered = alterToken(token);
    assert.equal(altered.length, token.length);
    assert.notDeepEqual(Buffer.from(altered, 'base64url'), Buffer.from(token, 'base64url'), token);
  }
  const endsInA = `${'x'.repeat(42)}A`;
  assert.notDeepEqual(Buffer.from(alterToken(endsInA), 'base64url'), Buffer.from(endsInA, 'base64url'), 'a token whose last character is A');
  // The old alteration: 32 bytes take 43 characters, whose last two bits are padding.
  const token = `${crypto.randomBytes(32).toString('base64url').slice(0, 42)}A`;
  assert.deepEqual(Buffer.from(`${token.slice(0, -1)}B`, 'base64url'), Buffer.from(token, 'base64url'));
});
const loseResponse = (call, method, error = new Error('socket hang up')) => async (m, url, body) => {
  const r = await call(m, url, body);
  if (m === method) throw error;
  return r;
};

test('a restore whose response is lost stays "restoring", so a later revocation is not undone (security review, round 3)', async () => {
  const fake = fakeGraph([held()]);
  const phases = [];
  let last = null;
  const journal = (r) => { phases.push(r ? r.phase : 'clear'); last = r; };
  await assert.rejects(withRoleRemoved({ ...target, graph: loseResponse(fake.graph, 'POST'), journal }, async () => {}), /hang up/);
  assert.deepEqual(phases, ['removing', 'removed', 'restoring']);
  assert.equal(fake.assignments.length, 1, 'the restore reached the service');
  fake.assignments.length = 0; // an administrator revokes the restored assignment
  assert.deepEqual(await reconcilePendingRestore({ pending: last, graph: fake.graph }), { restored: false, ambiguous: true });
  assert.equal(fake.assignments.length, 0, 'the revocation stands');

  const fakeA = fakeArm();
  const armPhases = [];
  let armLast = null;
  await assert.rejects(withArmRoleRemoved({ arm: loseResponse(fakeA.arm, 'PUT'), assignmentId: '/acct/ra/1', principalId: 'mi',
    journal: (r) => { armPhases.push(r ? r.phase : 'clear'); armLast = r; } }, async () => {}), /hang up/);
  assert.deepEqual(armPhases, ['removing', 'removed', 'restoring']);
  await fakeA.arm('DELETE'); // an administrator revokes the restored Foundry role
  const before = fakeA.calls.length;
  assert.deepEqual(await reconcilePendingRestore({ pending: armLast, arm: fakeA.arm }), { restored: false, ambiguous: true });
  assert.equal(fakeA.calls.length, before, 'no read, no grant');
});

test('only a 4xx refusal other than 408 counts as "nothing happened"; a 5xx or a timeout keeps the record where it was', async () => {
  const status = (code) => Object.assign(new Error(`returned ${code}`), { status: code });
  const refusedRestore = [];
  let last = null;
  const fake = fakeGraph([held()]);
  await assert.rejects(withRoleRemoved({ ...target, graph: async (m, u, b) => { if (m === 'POST') throw status(403); return fake.graph(m, u, b); },
    journal: (r) => { refusedRestore.push(r ? r.phase : 'clear'); last = r; } }, async () => {}), /403/);
  assert.deepEqual(refusedRestore, ['removing', 'removed', 'restoring', 'removed'], 'a refused restore changed nothing: still removed');
  assert.deepEqual(await reconcilePendingRestore({ pending: last, graph: fake.graph }), { restored: true, assignmentId: 'restored-1' });
  for (const [method, expected, code] of [['DELETE', ['removing'], 503], ['POST', ['removing', 'removed', 'restoring'], 503], ['DELETE', ['removing'], 408], ['POST', ['removing', 'removed', 'restoring'], 408]]) {
    const phases = [];
    const f = fakeGraph([held()]);
    await assert.rejects(withRoleRemoved({ ...target, graph: async (m, u, b) => { if (m === method) throw status(code); return f.graph(m, u, b); },
      journal: (r) => phases.push(r ? r.phase : 'clear') }, async () => {}), new RegExp(String(code)));
    assert.deepEqual(phases, expected, `a ${code} on ${method} may have taken effect`);
  }
});

test('reconcilePendingRestore journals "restoring" before it grants, and keeps it when the outcome is unknown', async () => {
  const appRole = { kind: 'appRole', phase: 'removed', servicePrincipalId: 'sp1', principalId: 'tester', appRoleId: 'standard' };
  const phases = [];
  await assert.rejects(reconcilePendingRestore({ pending: appRole, graph: loseResponse(fakeGraph([]).graph, 'POST'),
    journal: (r) => phases.push(r ? r.phase : 'clear') }), /hang up/);
  assert.deepEqual(phases, ['restoring']);
  const armRole = { kind: 'armRole', phase: 'removed', assignmentId: '/acct/ra/1', principalId: 'mi', roleDefinitionId: '/role/x' };
  const armPhases = [];
  await assert.rejects(reconcilePendingRestore({ pending: armRole, arm: loseResponse(fakeArm({ present: false }).arm, 'PUT'),
    journal: (r) => armPhases.push(r ? r.phase : 'clear') }), /hang up/);
  assert.deepEqual(armPhases, ['restoring']);
  const done = [];
  assert.equal((await reconcilePendingRestore({ pending: appRole, graph: fakeGraph([]).graph, journal: (r) => done.push(r ? r.phase : 'clear') })).restored, true);
  assert.deepEqual(done, ['restoring'], 'the caller clears the record once it has the result');
});
// An upstream that answers like the gateway: an x-request-id per response, a streamed body.
async function fakeUpstream() {
  const seen = [];
  let next = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, authorization: req.headers.authorization, body });
      const status = req.headers.authorization === 'Bearer good' ? 200 : 401;
      res.writeHead(status, { 'x-request-id': `req-${next++}`, 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n');
      setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 50);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('startCaptureRelay forwards every request and records method, path, status and x-request-id only (QA and Coder review, round 3)', async () => {
  const upstream = await fakeUpstream();
  const relay = await startCaptureRelay(upstream.origin);
  try {
    assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback only');
    const ok = await fetch(`${relay.url}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: '{"x":1}' });
    const text = await ok.text();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-request-id'), 'req-1');
    assert.match(text, /ping[\s\S]*message_stop/, 'the streamed body passes through whole');
    const refused = await fetch(`${relay.url}/v1/models`, { headers: { authorization: 'Bearer forged' } });
    assert.equal(refused.status, 401);
    await refused.text();
    assert.deepEqual(relay.captured, [
      { method: 'POST', path: '/v1/messages', status: 200, requestId: 'req-1' },
      { method: 'GET', path: '/v1/models', status: 401, requestId: 'req-2' },
    ]);
    assert.deepEqual(upstream.seen.map((s) => [s.method, s.url, s.host, s.authorization, s.body]), [
      ['POST', '/v1/messages?beta=true', new URL(upstream.origin).host, 'Bearer good', '{"x":1}'],
      ['GET', '/v1/models', new URL(upstream.origin).host, 'Bearer forged', ''],
    ], 'path, query, body and credentials reach the upstream; the Host header names the upstream');
    assert.ok(!JSON.stringify(relay.captured).includes('Bearer'), 'no header is recorded');
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test('startCaptureRelay answers 502 and records the failure when the upstream cannot be reached', async () => {
  const upstream = await fakeUpstream();
  const origin = upstream.origin;
  await upstream.close();
  const relay = await startCaptureRelay(origin);
  try {
    const r = await fetch(`${relay.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 502);
    assert.equal(relay.captured.length, 1);
    assert.deepEqual({ ...relay.captured[0], error: typeof relay.captured[0].error }, { method: 'POST', path: '/v1/messages', status: null, requestId: null, error: 'string' });
  } finally {
    await relay.close();
  }
});

test('relayEvidence keeps the events of the captured requests only, and names the gaps', () => {
  const events = [{ evt: 'inference', request_id: 'req-1' }, { evt: 'inference', request_id: 'other' }, { evt: 'auth.denied', request_id: 'req-2' }];
  assert.deepEqual(relayEvidence([{ requestId: 'req-1' }, { requestId: 'req-2' }], events), { block: [], own: [events[0], events[2]] });
  // The Coder reproduction (round 3): another process's well-formed events used to count.
  assert.deepEqual(relayEvidence([], events), { block: ['the client sent no request through the relay'], own: [] });
  assert.deepEqual(relayEvidence([{ requestId: 'req-1' }, { requestId: null }], events).block, ['1 response through the relay carried no x-request-id']);
});
// Helpers for the relay's failure paths (QA and UX review, round 4).
const listening = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const shut = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
const within = (promise, ms, what) => Promise.race([promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms).unref(); })]);
async function eventually(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('startCaptureRelay breaks the client\'s connection when the upstream cuts a stream short (QA and UX review, round 4)', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'x-request-id': 'req-cut', 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {}\n\n');
    setTimeout(() => res.socket.destroy(), 50);
  });
  const relay = await startCaptureRelay(await listening(upstream));
  try {
    const r = await fetch(`${relay.url}/v1/messages`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    const started = Date.now();
    await assert.rejects(r.text(), (error) => error.name !== 'TimeoutError' && error.name !== 'AbortError', 'the body fails at once instead of waiting');
    assert.ok(Date.now() - started < 4000, `the body failed after ${Date.now() - started} ms`);
    await eventually(() => relay.captured[0]?.error);
    assert.deepEqual(relay.captured, [{ method: 'POST', path: '/v1/messages', status: 200, requestId: 'req-cut', error: 'response not completed' }]);
  } finally {
    await relay.close();
    await shut(upstream);
  }
});

test('startCaptureRelay cancels the upstream request when the client goes away before the response starts', async () => {
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  let ended;
  const upstreamEnded = new Promise((resolve) => { ended = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.on('close', () => ended(res.writableFinished));
    arrived();
  });
  const relay = await startCaptureRelay(await listening(upstream));
  try {
    const controller = new AbortController();
    const pending = fetch(`${relay.url}/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal });
    await within(reached, 3000, 'the request reaching the upstream');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(await within(upstreamEnded, 3000, 'the upstream request ending'), false, 'the relay closed the upstream connection');
    await eventually(() => relay.captured.length === 1);
    assert.deepEqual(relay.captured, [{ method: 'POST', path: '/v1/messages', status: null, requestId: null, error: 'client closed the connection' }]);
  } finally {
    await relay.close();
    await shut(upstream);
  }
});

test('relay.close() ends its upstream connections, busy and idle, and returns at once', async () => {
  let open = 0;
  let held;
  const holding = new Promise((resolve) => { held = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/hold') return held();
    res.writeHead(200, { 'x-request-id': 'req-ok' });
    return res.end('ok');
  });
  upstream.on('connection', (socket) => { open++; socket.on('close', () => { open--; }); });
  const relay = await startCaptureRelay(await listening(upstream));
  let closed = false;
  try {
    const pending = fetch(`${relay.url}/hold`).then(() => null, (error) => error);
    await within(holding, 3000, 'the held request reaching the upstream');
    const ok = await fetch(`${relay.url}/ok`);
    assert.equal(await ok.text(), 'ok');
    assert.equal(open, 2, 'one busy and one idle upstream connection');
    const started = Date.now();
    await relay.close();
    closed = true;
    assert.deepEqual(relay.captured, [
      { method: 'GET', path: '/ok', status: 200, requestId: 'req-ok' },
      { method: 'GET', path: '/hold', status: null, requestId: null, error: 'relay closed' },
    ], 'the capture is complete when close() returns (QA and UX review, round 5)');
    assert.ok(Date.now() - started < 2000, `close took ${Date.now() - started} ms`);
    await eventually(() => open === 0, 1000);
    assert.ok((await pending) instanceof Error, 'the held client request fails');
  } finally {
    if (!closed) await relay.close();
    await shut(upstream);
  }
});
test('refusedCliFindings: only the CLI\'s own requests count, so another client\'s inference does not fail it (Coder review, round 4)', () => {
  const captured = [{ method: 'HEAD', path: '/api/hello', status: 401, requestId: 'r1' }, { method: 'POST', path: '/v1/messages', status: 401, requestId: 'r2' }];
  const own = [{ evt: 'auth.denied', request_id: 'r2', reason: 'invalid_token' }];
  const others = [{ evt: 'inference', request_id: 'someone-else', status: 200 }];
  const run = { status: 1, stdout: 'Failed to authenticate. API Error: 401 invalid token', stderr: '' };
  // The Coder reproduction (round 4): another client's inference inside the window used to fail the check.
  assert.deepEqual(refusedCliFindings({ ...run, captured, events: [...own, ...others] }), { block: [], fail: [] });
  assert.match(refusedCliFindings({ ...run, captured, events: [...own, { evt: 'inference', request_id: 'r2', status: 200 }] }).fail.join(), /own requests/);
  assert.match(refusedCliFindings({ ...run, captured, events: others }).fail.join(), /no auth\.denied/);
  assert.match(refusedCliFindings({ ...run, captured: [captured[0]], events: own }).fail.join(), /401 on an inference path/);
  assert.match(refusedCliFindings({ ...run, status: 0, stdout: 'PONG', captured, events: own }).fail.join(), /succeeded/);
  assert.match(refusedCliFindings({ ...run, stdout: 'error', captured, events: own }).fail.join(), /did not report/);
  assert.deepEqual(refusedCliFindings({ ...run, stdout: '', stderr: 'API Error: 401', captured, events: own }), { block: [], fail: [] }, 'the report may come on stderr');
  assert.deepEqual(refusedCliFindings({ ...run, captured: [], events: own }), { block: ['the client sent no request through the relay'], fail: [] });
  assert.deepEqual(refusedCliFindings({ ...run, captured, events: null }), { block: ['log coverage for the refused CLI run could not be established'], fail: [] });
});
test('runThroughRelay returns the capture after the relay has closed, so a request still waiting at the end is in it (QA and UX review, round 5)', async () => {
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/pending') return arrived();
    res.writeHead(401, { 'x-request-id': 'req-done' });
    return res.end();
  });
  const origin = await listening(upstream);
  let stray;
  try {
    // The program finishes while its second request still waits for headers.
    const result = await runThroughRelay(origin, async (url) => {
      await (await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })).text();
      stray = fetch(`${url}/pending`).then(() => null, (error) => error);
      await within(reached, 3000, 'the second request reaching the upstream');
      return { status: 1, stdout: 'Failed to authenticate. API Error: 401 invalid token', stderr: '' };
    });
    assert.equal(result.status, 1);
    assert.deepEqual(result.captured, [
      { method: 'POST', path: '/v1/messages', status: 401, requestId: 'req-done' },
      { method: 'GET', path: '/pending', status: null, requestId: null, error: 'relay closed' },
    ]);
    assert.deepEqual(refusedCliFindings({ ...result, events: [{ evt: 'auth.denied', request_id: 'req-done' }] }),
      { block: ['1 response through the relay carried no x-request-id'], fail: [] }, 'the unanswered request leaves the evidence incomplete');
    assert.ok((await stray) instanceof Error);
  } finally {
    await shut(upstream);
  }
});

test('runThroughRelay closes the relay when the program throws', async () => {
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'x-request-id': 'r' }); res.end(); });
  const origin = await listening(upstream);
  let seen;
  try {
    await assert.rejects(runThroughRelay(origin, async (url) => { seen = url; throw new Error('spawn failed'); }), /spawn failed/);
    await assert.rejects(fetch(seen), 'the relay no longer listens');
  } finally {
    await shut(upstream);
  }
});
test('relay.close() during a streamed response records it as not completed before it returns', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'x-request-id': 'req-stream', 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {}\n\n');
  });
  const relay = await startCaptureRelay(await listening(upstream));
  let closed = false;
  try {
    const r = await fetch(`${relay.url}/v1/messages`, { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    await reader.read();
    const body = reader.read().then(() => null, (error) => error);
    await relay.close();
    closed = true;
    assert.deepEqual(relay.captured, [{ method: 'POST', path: '/v1/messages', status: 200, requestId: 'req-stream', error: 'response not completed' }]);
    assert.ok((await body) instanceof Error, 'the client sees the stream end early');
  } finally {
    if (!closed) await relay.close();
    await shut(upstream);
  }
});