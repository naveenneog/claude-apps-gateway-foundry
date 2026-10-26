#!/usr/bin/env node
// Sets each initial spend cap an admin file declares (ADR-0009, T-90): the one deploy-time step this repository had
// no automation for at all (ROADMAP, P-34) - every other admin-file-driven step (roles, models, policies) had a
// script before this one. Reuses admin-ui/server/gateway-client.mjs's setSpendLimit unmodified: no parallel HTTP
// client for the gateway's documented admin API (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits).
//   node scripts/admin/bootstrap-budgets.mjs --admin config/gateway-admin.azure-test.json --resource-group rg-claude-apps-gateway-test [--gateway-app ca-claude-gw] [--plan]
// The admin file is read and checked (adminErrors, the same validation every other admin script shares) before any
// network call. Idempotent: POST replaces the existing cap for an unchanged {scope, period} rather than duplicating
// it (the gateway's own documented behaviour), so re-running after an amountUsd changes is a plain redeploy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adminErrors } from './new-gateway-config.mjs';
import { setSpendLimit } from '../../admin-ui/server/gateway-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ADMIN = path.join(root, 'config', 'gateway-admin.azure-test.json');
const shownPath = (file) => (path.relative(root, file).startsWith('..') ? file : path.relative(root, file).replaceAll('\\', '/'));

/** The budgets rows from an admin file that passes the renderer's validation (T-89), or [] when it declares none. */
export function budgetsFrom(adminFile, knownRoles, topology) {
  let admin;
  try {
    admin = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
  } catch (error) {
    throw new Error(`${shownPath(adminFile)} is not readable JSON: ${error.message}`);
  }
  const errors = adminErrors(admin, knownRoles, topology);
  if (errors.length) throw new Error(`${shownPath(adminFile)} has ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  return admin.budgets ?? [];
}

// The wire format is a whole-number string of USD cents, or null for unlimited (validated as a number by adminErrors).
const centsOf = (amountUsd) => (amountUsd === null ? null : Math.round(amountUsd * 100));
const describe = (scope) => (scope.type === 'organization' ? 'organization' : `${scope.type}:${scope.rbac_group_id ?? scope.user_id}`);

/**
 * Sets every row through gateway.setSpendLimit, or only prints what would be sent when plan is true. Continues past
 * a row's own failure so one bad row does not stop the rows after it; returns {set, failed}, both arrays of
 * {budget, message}. gateway is the admin-ui/server/gateway-client.mjs deps shape: {baseUrl, writeKey, fetch?}.
 */
export async function bootstrapBudgets({ gateway, budgets, plan = false, log = () => {} }) {
  const set = [];
  const failed = [];
  for (const budget of budgets) {
    const amountCents = centsOf(budget.amountUsd);
    const label = `${describe(budget.scope)} ${budget.period} = ${amountCents === null ? 'unlimited' : `$${(amountCents / 100).toFixed(2)}`}`;
    if (plan) { log(`PLAN: set ${label}`); continue; }
    try {
      await setSpendLimit(gateway, { scope: budget.scope, amountCents, period: budget.period });
      log(`set ${label}`);
      set.push({ budget, message: label });
    } catch (error) {
      log(`FAILED to set ${label}: ${error.message}`);
      failed.push({ budget, message: error.message });
    }
  }
  return { set, failed };
}

// Real discovery of the gateway's base URL and admin-write-key, matching admin-ui/infra/Deploy-AdminUi.ps1's own
// `az containerapp secret show --secret-name admin-write-key` pattern - both read the one secret value the app step
// already set, rather than inventing a second key.
async function discoverGateway({ resourceGroup, gatewayApp }) {
  const { azJson } = await import('../../infra/azure-test/lib/spawn.mjs');
  const fqdn = azJson(['containerapp', 'show', '-g', resourceGroup, '-n', gatewayApp, '--query', 'properties.configuration.ingress.fqdn']);
  if (!fqdn) throw new Error(`no ingress FQDN for Container App ${gatewayApp} in ${resourceGroup}`);
  const writeKey = azJson(['containerapp', 'secret', 'show', '-g', resourceGroup, '-n', gatewayApp, '--secret-name', 'admin-write-key', '--query', 'value']);
  if (!writeKey) throw new Error(`the gateway's admin-write-key secret was not found in ${gatewayApp}; deployment.adminApi must be true and the app step must have run`);
  return { baseUrl: `https://${fqdn}`, writeKey };
}

/** The command line; returns what it prints. deps replaces Graph-free gateway discovery and the gateway client for tests. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({ args: argv, options: {
    admin: { type: 'string', default: DEFAULT_ADMIN },
    'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
    'gateway-app': { type: 'string', default: 'ca-claude-gw' },
    topology: { type: 'string', default: 'test' },
    plan: { type: 'boolean', default: false },
  } });
  const adminFile = path.resolve(values.admin);
  const knownRoles = deps.knownRoles ?? JSON.parse(fs.readFileSync(path.join(root, 'infra', 'azure-test', 'entra-app.json'), 'utf8')).appRoles.map((r) => r.value);
  const budgets = budgetsFrom(adminFile, knownRoles, values.topology);
  if (!budgets.length) return `${shownPath(adminFile)} declares no budgets; nothing to set`;
  const discover = deps.discoverGateway ?? discoverGateway;
  const gateway = values.plan ? { baseUrl: '(plan)', writeKey: '(plan)' } : await discover({ resourceGroup: values['resource-group'], gatewayApp: values['gateway-app'] });
  const lines = [];
  const { set, failed } = await bootstrapBudgets({ gateway, budgets, plan: values.plan, log: (line) => lines.push(line) });
  if (failed.length) {
    const error = new Error(`${failed.length} of ${budgets.length} budget(s) failed:\n  ${failed.map((f) => f.message).join('\n  ')}\n${lines.join('\n')}`);
    error.partial = { set, failed };
    throw error;
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((out) => console.log(out), (error) => {
    console.error(`[bootstrap-budgets] ${error.message}`);
    process.exitCode = 1;
  });
}
