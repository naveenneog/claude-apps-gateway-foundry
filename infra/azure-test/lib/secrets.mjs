// Registry of the secrets the deploy and live-test tools hold in memory. Every value is registered as
// soon as it exists, so it can be redacted from output and refused as a command-line argument.
import { redact } from './plan.mjs';

const registry = new Set();

export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 8) throw new Error('refusing to register a secret shorter than 8 characters');
  registry.add(value);
  return value;
}

export const redactSecrets = (text) => redact(text, registry);

export function assertNoSecretIn(args) {
  for (const arg of args) {
    for (const secret of registry) {
      if (String(arg).includes(secret)) throw new Error('refusing to pass a registered secret as a command-line argument');
    }
  }
}

export const clearSecrets = () => registry.clear();
