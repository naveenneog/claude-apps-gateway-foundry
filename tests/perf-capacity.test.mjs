// T-109: capacity calculator for P-36. Its formulas are the ones docs/learn/concept-plan-for-scale.md states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { size, sizeTable, signInLimit, DEFAULT_PROFILE, MEASURED, POSTGRES_SKUS } from '../scripts/perf/capacity.mjs';

test('T-109 reproduces the 25,000-developer example of concept-plan-for-scale', () => {
  const r = size(25000, { ...DEFAULT_PROFILE, otherConnections: 0 });
  assert.equal(r.requestsPerMinute, 10000);
  assert.equal(r.openRequests, 5000);
  assert.equal(r.replicas.byConcurrency, 34);
  assert.equal(r.replicas.total, 34);
  assert.equal(r.postgres.connections, 680);
  assert.equal(r.postgres.smallest.name, 'D2ds_v5');
});

test('T-109 never sizes below the minimum replica count', () => {
  const r = size(500);
  assert.equal(r.openRequests, 100);
  assert.equal(r.replicas.byConcurrency, 1);
  assert.equal(r.replicas.total, DEFAULT_PROFILE.minReplicas);
});

test('T-109 measured CPU and memory per request raise the replica count when they bind', () => {
  const base = size(10000);
  const cpuBound = size(10000, { ...DEFAULT_PROFILE, cpuSecondsPerRequest: 0.5 });
  // 10,000 × 20% × 2 / 60 = 66.67 req/s × 0.5 s = 33.3 vCPU; at 70% of 1 vCPU per replica = 48 replicas
  assert.equal(cpuBound.replicas.byCpu, 48);
  assert.equal(cpuBound.replicas.total, 48);
  const memBound = size(10000, { ...DEFAULT_PROFILE, baseMiB: 200, mibPerOpenRequest: 10 });
  // 2,000 open × 10 MiB = 20,000 MiB; per replica 70% of 2,048 − 200 = 1,233.6 MiB → 17 replicas
  assert.equal(memBound.replicas.byMemory, 17);
  assert.equal(base.replicas.byCpu, null);
  assert.equal(base.replicas.byMemory, null);
  assert.equal(base.replicas.total, base.replicas.byConcurrency);
});

test('T-109 picks the smallest PostgreSQL tier whose user connections hold the rollout budget', () => {
  for (const developers of [500, 1000, 2000, 10000, 25000]) {
    const { postgres } = size(developers);
    assert.equal(postgres.connections, 2 * size(developers).replicas.total * DEFAULT_PROFILE.pool + DEFAULT_PROFILE.otherConnections);
    assert.ok(postgres.smallest.userConnections >= postgres.connections, `${developers}: ${postgres.smallest.name}`);
    const smaller = POSTGRES_SKUS.filter((s) => s.userConnections < postgres.smallest.userConnections);
    assert.ok(smaller.every((s) => s.userConnections < postgres.connections), `${developers}: a smaller tier fits`);
    assert.equal(postgres.production.tier, 'GeneralPurpose');
    assert.ok(postgres.production.userConnections >= postgres.connections);
  }
  assert.throws(() => size(25000, { ...DEFAULT_PROFILE, pool: 100 }), /no PostgreSQL tier/);
});

test('T-109 Log Analytics cost subtracts the free allowance and is never negative', () => {
  const small = size(500, { ...DEFAULT_PROFILE, logBytesPerRequest: 100 });
  assert.equal(small.logAnalytics.costPerMonth, 0);
  const big = size(25000);
  const p = DEFAULT_PROFILE;
  const perDay = 25000 * p.activeShare * p.requestsPerMinute * 60 * p.peakHoursPerDay;
  assert.equal(big.requestsPerDay, perDay);
  const gbMonth = (perDay * p.logBytesPerRequest + 25000 * p.signInEventsPerDeveloperPerDay * p.signInEventBytes) * p.workdaysPerMonth / 1e9;
  assert.ok(Math.abs(big.logAnalytics.gbPerMonth - gbMonth) < 1e-9);
  assert.ok(Math.abs(big.logAnalytics.costPerMonth - (gbMonth - 5) * 2.76) < 1e-6);
});

test('T-109 gateway cost at a fully active month matches the article for 1,000 developers', () => {
  // concept-plan-for-scale: 2 replicas, 1 vCPU / 2 GiB, $158 a month fully active
  const r = size(1000, { ...DEFAULT_PROFILE, peakHoursPerDay: 24, workdaysPerMonth: 730 / 24 });
  assert.equal(Math.round(r.cost.gateway), 158);
});

test('T-109 sign-in limit is twice the even share per address per window, rounded up', () => {
  assert.equal(signInLimit({ developers: 25000, addresses: 10, windowSeconds: 600, rolloutSeconds: 7200 }), 417);
  assert.throws(() => signInLimit({ developers: 25000, addresses: 0, windowSeconds: 600, rolloutSeconds: 7200 }), /addresses/);
});

test('T-109 rejects a negative, zero or non-numeric developer count', () => {
  for (const bad of [-1, 0, NaN, '25000', Infinity]) assert.throws(() => size(bad), /developers/);
  assert.throws(() => size(100, { ...DEFAULT_PROFILE, activeShare: 1.5 }), /activeShare/);
});

test('T-109 the measured profile: one process uses at most one core, so a second vCPU adds no CPU capacity', () => {
  const p = { ...DEFAULT_PROFILE, ...MEASURED, openPerReplica: 1000, secondsOpen: 9.5 };
  // 25,000 → 166.67 req/s × 0.026 s = 4.33 cores; at 70% of one usable core = 7 replicas
  assert.equal(size(25000, p).replicas.byCpu, 7);
  assert.equal(size(25000, { ...p, vcpuPerReplica: 2 }).replicas.byCpu, 7);
  assert.equal(size(25000, { ...p, vcpuPerReplica: 0.5 }).replicas.byCpu, 13);
  assert.equal(size(25000, { ...DEFAULT_PROFILE, ...MEASURED }).replicas.total, 34);
});

test('T-109 the table covers every requested headcount in order', () => {
  const rows = sizeTable([500, 1000, 2000, 10000, 25000]);
  assert.deepEqual(rows.map((r) => r.developers), [500, 1000, 2000, 10000, 25000]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].replicas.total >= rows[i - 1].replicas.total);
  assert.ok(rows.every((r) => r.foundry.itpm === r.requestsPerMinute * DEFAULT_PROFILE.inputTokensPerRequest));
});
