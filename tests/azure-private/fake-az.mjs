// A fake Azure CLI for tests/azure-private.test.mjs. It answers a read from the world file named by CGW_FAKE_AZ_WORLD,
// keyed by the command words before the first option ("containerapp env show"), and records every call, as a JSON
// array of its arguments, in the file named by CGW_FAKE_AZ_LOG. A read the world does not name is a missing resource.
import fs from 'node:fs';

const argv = process.argv.slice(2);
fs.appendFileSync(process.env.CGW_FAKE_AZ_LOG, `${JSON.stringify(argv)}\n`);
const end = argv.findIndex((a) => a.startsWith('-'));
const words = end < 0 ? argv : argv.slice(0, end);
const key = words.join(' ');
const world = JSON.parse(fs.readFileSync(process.env.CGW_FAKE_AZ_WORLD, 'utf8'));
// `az acr build` without --no-logs streams the build log, which is not JSON (measured 2026-09-29, run cj1).
if (key === 'acr build' && !argv.includes('--no-logs')) {
  process.stdout.write('2026/09/29 15:01:37 Successfully pushed image: acr.azurecr.io/claude-gateway:0.0.0\nRun ID: cj1 was successful after 1m53s\n');
  process.exit(0);
}
if (Object.hasOwn(world, key)) {
  if (world[key] === null) {
    process.stderr.write(`(ResourceNotFound) ${key}: not found\n`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify(world[key], null, 2)}\n`);
  process.exit(0);
}
if (['show', 'list'].includes(words.at(-1))) {
  process.stderr.write(`(ResourceNotFound) ${key}: the resource was not found\n`);
  process.exit(3);
}
process.stdout.write('{}\n');
