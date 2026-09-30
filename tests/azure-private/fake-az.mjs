// A fake Azure CLI for tests/azure-private.test.mjs. It answers a read from the world file named by CGW_FAKE_AZ_WORLD,
// keyed by the command words before the first option ("containerapp env show"), and records every call, as a JSON
// array of its arguments, in the file named by CGW_FAKE_AZ_LOG. A key can also name one option and its value
// ("acr repository show --image name:tag"), which takes precedence. A read the world does not name is a missing
// resource. A string answer is printed as JSON only under --output json, as the Azure CLI prints tsv and exec output.
import fs from 'node:fs';

const argv = process.argv.slice(2);
fs.appendFileSync(process.env.CGW_FAKE_AZ_LOG, `${JSON.stringify(argv)}\n`);
const end = argv.findIndex((a) => a.startsWith('-'));
const words = end < 0 ? argv : argv.slice(0, end);
const world = JSON.parse(fs.readFileSync(process.env.CGW_FAKE_AZ_WORLD, 'utf8'));
const qualified = end < 0 ? [] : argv.slice(end).flatMap((a, i, rest) => (a.startsWith('-') && rest[i + 1] !== undefined ? [`${words.join(' ')} ${a} ${rest[i + 1]}`] : []));
const key = qualified.find((k) => Object.hasOwn(world, k)) ?? words.join(' ');
// `az acr build` without --no-logs streams the build log, which is not JSON (measured 2026-09-29, run cj1).
if (key === 'acr build' && !argv.includes('--no-logs')) {
  process.stdout.write('2026/09/29 15:01:37 Successfully pushed image: acr.azurecr.io/claude-gateway:0.0.0\nRun ID: cj1 was successful after 1m53s\n');
  process.exit(0);
}
if (Object.hasOwn(world, key)) {
  let answer = world[key];
  // { sequence: [a, b, ...] } answers the nth call with the nth entry and repeats the last, counted per key.
  if (answer && typeof answer === 'object' && Array.isArray(answer.sequence)) {
    const counter = `${process.env.CGW_FAKE_AZ_LOG}.${Buffer.from(key).toString('hex').slice(0, 80)}.n`;
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(n + 1));
    answer = answer.sequence[Math.min(n, answer.sequence.length - 1)];
  }
  if (answer === null) {
    process.stderr.write(`(ResourceNotFound) ${key}: not found\n`);
    process.exit(3);
  }
  // { fail: 'text', code: n } is a failed command: the text on standard error and exit code n (1 by default).
  if (answer && typeof answer === 'object' && typeof answer.fail === 'string') {
    process.stderr.write(`${answer.fail}\n`);
    process.exit(answer.code ?? 1);
  }
  const json = argv[argv.indexOf('--output') + 1] === 'json';
  process.stdout.write(typeof answer === 'string' && !json ? `${answer}\n` : `${JSON.stringify(answer, null, 2)}\n`);
  process.exit(0);
}
if (['show', 'list'].includes(words.at(-1))) {
  process.stderr.write(`(ResourceNotFound) ${key}: the resource was not found\n`);
  process.exit(3);
}
process.stdout.write('{}\n');
