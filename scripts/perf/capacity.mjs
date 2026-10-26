// Capacity calculator for the Claude apps gateway on Azure Container Apps (P-36, T-109).
// Formulas follow docs/learn/concept-plan-for-scale.md; prices are Azure Retail Prices, eastus2,
// checked 2026-10-25 (docs/UNKNOWNS.md U-99). Usage:
//   node scripts/perf/capacity.mjs [--developers 500,1000,2000,10000,25000] [--measured] [--cpu-seconds 0.024]
//     [--base-mib 175] [--mib-per-open 0.6] [--log-bytes 690] [--seconds-open 30] [--per-replica 150]
//     [--vcpu 1] [--gib 2] [--pool 10] [--json]
import { pathToFileURL } from 'node:url';
import { parseArgs as parseCli } from 'node:util';

export const DEFAULT_PROFILE = Object.freeze({
  activeShare: 0.2,              // developers active at peak (concept-plan-for-scale, U-96)
  requestsPerMinute: 2,          // model requests per active developer per minute (U-96)
  secondsOpen: 30,               // average seconds a request stays open (U-96)
  openPerReplica: 150,           // -ConcurrentRequests, below 256 upstream slots
  minReplicas: 2,                // zone loss and rollouts
  vcpuPerReplica: 1,
  gibPerReplica: 2,
  targetUtilization: 0.7,        // headroom for bursts and uneven routing
  cpuSecondsPerRequest: null,    // measured by T-110; null leaves CPU out of the count
  baseMiB: null,                 // measured idle RSS of one replica
  mibPerOpenRequest: null,       // measured memory growth per open request
  pool: 10,                      // store.max_connections per replica
  otherConnections: 10,          // admin-ui, migrations, an operator's psql
  peakHoursPerDay: 8,
  workdaysPerMonth: 22,
  logBytesPerRequest: 1000,      // billed bytes per inference event row (U-98)
  signInEventsPerDeveloperPerDay: 10,
  signInEventBytes: 400,
  inputTokensPerRequest: 2000,   // concept-plan-for-scale Foundry assumption
  outputTokensPerRequest: 500,
  maxUsableCoresPerReplica: null, // null: every requested vCPU counts
});

// Measured 2026-10-25 on gateway 2.1.308 in load_test_mode (docs/learn/how-to-load-test-and-size.md):
// one gateway process, WSL2 on an AMD EPYC 7763 host, 750-token canned replies over 9.5 s.
export const MEASURED = Object.freeze({
  cpuSecondsPerRequest: 0.026,   // 25.5 ms at 150 and 256 open: cores busy × run seconds ÷ requests, below saturation
  baseMiB: 175,                  // idle RSS 165 to 174 MB
  mibPerOpenRequest: 0.6,        // highest growth seen: 0.58 MB per open request at 50 open
  maxUsableCoresPerReplica: 1,   // the process levelled at 1.03 to 1.05 cores from 512 to 2,000 open
  logBytesPerRequest: 690,       // Log Analytics _BilledSize of an inference row: 686 bytes, 125 rows
  signInEventBytes: 660,         // _BilledSize of sign-in rows: 546 to 657 bytes
});

export const PRICES = Object.freeze({
  acaVcpuActivePerSecond: 0.000024,
  acaVcpuIdlePerSecond: 0.000003,
  acaGibPerSecond: 0.000003,
  acaPerMillionRequests: 0.40,
  logAnalyticsPerGb: 2.76,
  logAnalyticsFreeGbPerMonth: 5,
  hoursPerMonth: 730,
});

// Maximum user connections = default max_connections − 15 reserved (Azure PostgreSQL limits).
export const POSTGRES_SKUS = Object.freeze([
  { name: 'B1ms', tier: 'Burstable', userConnections: 35, perHour: 0.017 },
  { name: 'B2s', tier: 'Burstable', userConnections: 414, perHour: 0.068 },
  { name: 'D2ds_v5', tier: 'GeneralPurpose', userConnections: 844, perHour: 0.178 },
  { name: 'D4ds_v5', tier: 'GeneralPurpose', userConnections: 1703, perHour: 0.356 },
  { name: 'D8ds_v5', tier: 'GeneralPurpose', userConnections: 3422, perHour: 0.712 },
  { name: 'D16ds_v5', tier: 'GeneralPurpose', userConnections: 4985, perHour: 1.424 },
]);

export const FOUNDRY_ENTERPRISE_DEFAULTS = Object.freeze({ rpm: 10000, itpm: 10000000, otpm: 2000000 });

function positive(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${String(value)}`);
  }
}

function validate(developers, p) {
  positive('developers', developers);
  positive('activeShare', p.activeShare);
  if (p.activeShare > 1) throw new RangeError(`activeShare must be at most 1, got ${p.activeShare}`);
  for (const k of ['requestsPerMinute', 'secondsOpen', 'openPerReplica', 'minReplicas', 'vcpuPerReplica',
    'gibPerReplica', 'targetUtilization', 'pool', 'peakHoursPerDay', 'workdaysPerMonth', 'logBytesPerRequest']) {
    positive(k, p[k]);
  }
  for (const k of ['cpuSecondsPerRequest', 'baseMiB', 'mibPerOpenRequest', 'maxUsableCoresPerReplica']) if (p[k] !== null) positive(k, p[k]);
}

export function signInLimit({ developers, addresses, windowSeconds, rolloutSeconds }) {
  positive('developers', developers);
  positive('addresses', addresses);
  positive('windowSeconds', windowSeconds);
  positive('rolloutSeconds', rolloutSeconds);
  return Math.ceil(2 * (developers / addresses) * (windowSeconds / rolloutSeconds));
}

function replicaCounts(p, requestsPerSecond, openRequests) {
  const byConcurrency = Math.ceil(openRequests / p.openPerReplica);
  const usableCores = Math.min(p.vcpuPerReplica, p.maxUsableCoresPerReplica ?? Infinity);
  const byCpu = p.cpuSecondsPerRequest === null ? null
    : Math.ceil((requestsPerSecond * p.cpuSecondsPerRequest) / (usableCores * p.targetUtilization));
  let byMemory = null;
  if (p.mibPerOpenRequest !== null) {
    const usable = p.gibPerReplica * 1024 * p.targetUtilization - (p.baseMiB ?? 0);
    if (usable <= 0) throw new RangeError('baseMiB leaves no memory for requests at the target utilization');
    byMemory = Math.ceil((openRequests * p.mibPerOpenRequest) / usable);
  }
  const total = Math.max(p.minReplicas, byConcurrency, byCpu ?? 0, byMemory ?? 0);
  return { byConcurrency, byCpu, byMemory, total };
}

function postgresFor(connections) {
  const smallest = POSTGRES_SKUS.find((s) => s.userConnections >= connections);
  const production = POSTGRES_SKUS.find((s) => s.tier === 'GeneralPurpose' && s.userConnections >= connections);
  if (!smallest || !production) {
    throw new RangeError(`no PostgreSQL tier holds ${connections} connections; lower the pool or add PgBouncer`);
  }
  return { smallest, production };
}

export function size(developers, profile = DEFAULT_PROFILE) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  validate(developers, p);
  const requestsPerMinute = developers * p.activeShare * p.requestsPerMinute;
  const requestsPerSecond = requestsPerMinute / 60;
  const openRequests = requestsPerSecond * p.secondsOpen;
  const replicas = replicaCounts(p, requestsPerSecond, openRequests);

  const connections = 2 * replicas.total * p.pool + p.otherConnections;
  const { smallest, production } = postgresFor(connections);

  const requestsPerDay = requestsPerMinute * 60 * p.peakHoursPerDay;
  const bytesPerDay = requestsPerDay * p.logBytesPerRequest
    + developers * p.signInEventsPerDeveloperPerDay * p.signInEventBytes;
  const gbPerDay = bytesPerDay / 1e9;
  const gbPerMonth = gbPerDay * p.workdaysPerMonth;
  const laCost = Math.max(0, gbPerMonth - PRICES.logAnalyticsFreeGbPerMonth) * PRICES.logAnalyticsPerGb;

  const monthSeconds = PRICES.hoursPerMonth * 3600;
  const activeSeconds = Math.min(monthSeconds, p.peakHoursPerDay * 3600 * p.workdaysPerMonth);
  const idleSeconds = Math.max(0, monthSeconds - activeSeconds);
  const memoryRate = p.gibPerReplica * PRICES.acaGibPerSecond;
  const gateway = replicas.total * (p.vcpuPerReplica * PRICES.acaVcpuActivePerSecond + memoryRate) * activeSeconds
    + p.minReplicas * (p.vcpuPerReplica * PRICES.acaVcpuIdlePerSecond + memoryRate) * idleSeconds;
  const requestsPerMonth = requestsPerDay * p.workdaysPerMonth;

  const itpm = requestsPerMinute * p.inputTokensPerRequest;
  const otpm = requestsPerMinute * p.outputTokensPerRequest;
  const f = FOUNDRY_ENTERPRISE_DEFAULTS;
  const quotaMultiple = Math.max(requestsPerMinute / f.rpm, itpm / f.itpm, otpm / f.otpm);

  const cost = {
    gateway,
    requests: (requestsPerMonth / 1e6) * PRICES.acaPerMillionRequests,
    postgresSmallest: smallest.perHour * PRICES.hoursPerMonth,
    postgresProductionHa: production.perHour * PRICES.hoursPerMonth * 2,
    logAnalytics: laCost,
  };
  cost.totalSmallest = cost.gateway + cost.requests + cost.postgresSmallest + cost.logAnalytics;
  cost.totalProduction = cost.gateway + cost.requests + cost.postgresProductionHa + cost.logAnalytics;

  return {
    developers,
    requestsPerMinute,
    requestsPerSecond,
    openRequests,
    requestsPerDay,
    replicas,
    vcpu: replicas.total * p.vcpuPerReplica,
    postgres: { connections, smallest, production },
    logAnalytics: { gbPerDay, gbPerMonth, costPerMonth: laCost },
    foundry: { rpm: requestsPerMinute, itpm, otpm, enterpriseDefaultMultiple: quotaMultiple },
    cost,
  };
}

export function sizeTable(headcounts, profile = DEFAULT_PROFILE) {
  return headcounts.map((n) => size(n, profile));
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const num = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

export function toMarkdown(rows) {
  const head = '| Developers | Requests/min | Open requests | Replicas (concurrency / CPU / memory) | vCPU | PostgreSQL connections | PostgreSQL smallest / production HA | Log Analytics GB/day | Foundry vs enterprise default quota | Monthly infra (smallest / production) |';
  const sep = '|' + '---|'.repeat(10);
  const body = rows.map((r) => `| ${num(r.developers)} | ${num(r.requestsPerMinute)} | ${num(r.openRequests)} | ${r.replicas.total} (${r.replicas.byConcurrency} / ${r.replicas.byCpu ?? '—'} / ${r.replicas.byMemory ?? '—'}) | ${num(r.vcpu, 1)} | ${num(r.postgres.connections)} | ${r.postgres.smallest.name} / ${r.postgres.production.name} ×2 | ${num(r.logAnalytics.gbPerDay, 2)} | ${num(r.foundry.enterpriseDefaultMultiple, 2)}× | ${money(r.cost.totalSmallest)} / ${money(r.cost.totalProduction)} |`);
  return [head, sep, ...body].join('\n');
}

const NUMERIC = { 'cpu-seconds': 'cpuSecondsPerRequest', 'base-mib': 'baseMiB', 'mib-per-open': 'mibPerOpenRequest',
  'log-bytes': 'logBytesPerRequest', 'seconds-open': 'secondsOpen', 'per-replica': 'openPerReplica', pool: 'pool',
  vcpu: 'vcpuPerReplica', gib: 'gibPerReplica' };

export function parseArgs(argv) {
  const { values } = parseCli({
    args: argv,
    options: {
      developers: { type: 'string', default: '500,1000,2000,10000,25000' },
      measured: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'cpu-seconds': { type: 'string' }, 'base-mib': { type: 'string' }, 'mib-per-open': { type: 'string' },
      'log-bytes': { type: 'string' }, 'seconds-open': { type: 'string' }, 'per-replica': { type: 'string' },
      pool: { type: 'string' }, vcpu: { type: 'string' }, gib: { type: 'string' },
    },
  });
  const profile = values.measured ? { ...MEASURED } : {};
  for (const [flag, key] of Object.entries(NUMERIC)) if (values[flag] !== undefined) profile[key] = Number(values[flag]);
  return { developers: values.developers.split(',').map(Number), profile, json: values.json };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { developers, profile, json } = parseArgs(process.argv.slice(2));
  const rows = sizeTable(developers, profile);
  console.log(json ? JSON.stringify(rows, null, 2) : toMarkdown(rows));
}
