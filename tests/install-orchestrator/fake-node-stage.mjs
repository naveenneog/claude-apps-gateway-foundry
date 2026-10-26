// A stand-in for scripts/admin/new-gateway-config.mjs, infra/azure-test/deploy.mjs or scripts/admin/bootstrap-budgets.mjs,
// for tests/install-orchestrator.test.mjs (T-91). It logs its own argv to CGW_FAKE_LOG as one JSON line under the stage
// it stands for (deploy.mjs's --step value; config when the argv names an --out file; budgets otherwise), exits 1 when
// CGW_FAKE_FAIL_STEP names that stage, and for base writes the state file a real base stage leaves in
// CGW_FAKE_STATE_DIR, from which the installer reads admin-ui's registry.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const step = at('--step') ?? (argv.includes('--out') ? 'config' : 'budgets');
fs.appendFileSync(process.env.CGW_FAKE_LOG, `${JSON.stringify({ step, argv })}\n`);
if (process.env.CGW_FAKE_FAIL_STEP === step) {
  console.error(`fake-node-stage: ${step} failed on purpose`);
  process.exit(1);
}
if (step === 'base' && process.env.CGW_FAKE_STATE_DIR) {
  fs.writeFileSync(path.join(process.env.CGW_FAKE_STATE_DIR, `${at('--resource-group')}.json`), JSON.stringify({ acrName: 'crfakeregistry1' }));
}
