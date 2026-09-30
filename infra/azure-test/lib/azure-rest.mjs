// Azure Resource Manager and Microsoft Graph over HTTPS, with tokens from the signed-in Azure CLI.
// Request bodies may carry secrets: nothing here prints a body, and error text passes through the
// secret registry before it leaves this module.
import { azJson } from './spawn.mjs';
import { redactSecrets, registerSecret } from './secrets.mjs';

const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DEPLOYMENTS_API = 'api-version=2022-09-01';
const tokens = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function accessToken(audience) {
  const cached = tokens.get(audience);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.value;
  const target = audience === 'graph' ? ['--resource-type', 'ms-graph'] : ['--resource', audience];
  const result = azJson(['account', 'get-access-token', ...target, '--query', '{token:accessToken,expires:expires_on}']);
  registerSecret(result.token);
  tokens.set(audience, { value: result.token, expiresAt: Number(result.expires) * 1000 });
  return result.token;
}

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

async function call(base, audience, method, path, body, { ok = [200, 201, 202, 204], headers = {} } = {}) {
  const url = /^https:\/\//.test(path) ? path : `${base}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken(audience)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const json = parse(text);
  if (!ok.includes(response.status)) {
    const detail = json?.error ? `${json.error.code ?? ''}: ${json.error.message ?? ''}` : redactSecrets(text).slice(0, 400);
    const error = new Error(redactSecrets(`${method} ${url.split('?')[0]} returned ${response.status} ${detail}`));
    error.status = response.status;
    error.code = json?.error?.code;
    throw error;
  }
  return { status: response.status, json, headers: response.headers };
}

export const arm = (method, path, body, options) => call(ARM, 'https://management.azure.com/', method, path, body, options);
export const graph = (method, path, body, options) => call(GRAPH, 'graph', method, path, body, options);

// Graph replicates new objects over several seconds; a follow-up call can briefly see 400 or 404.
export async function retry(action, { attempts = 8, delayMs = 5000, when = (e) => [400, 403, 404].includes(e.status) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !when(error)) throw error;
      await sleep(delayMs);
    }
  }
}

async function pollLocation(response, label) {
  let location = response.headers.get('location');
  while (response.status === 202 && location) {
    await sleep(Number(response.headers.get('retry-after') ?? 5) * 1000);
    response = await arm('GET', location, undefined, { ok: [200, 202, 400] });
    if (response.status === 400) throw new Error(redactSecrets(`${label}: ${JSON.stringify(response.json?.error ?? response.json)}`));
    location = response.headers.get('location') ?? location;
  }
  return response;
}

// Server-side validation of the template and its parameters before anything changes (Astra review).
export async function validateDeployment(groupPath, name, bodyText) {
  const path = `${groupPath}/providers/Microsoft.Resources/deployments/${name}/validate?${DEPLOYMENTS_API}`;
  const first = await arm('POST', path, bodyText, { ok: [200, 202, 400] });
  if (first.status === 400) throw new Error(redactSecrets(`validation of ${name} failed: ${JSON.stringify(first.json?.error)}`));
  return pollLocation(first, `validation of ${name}`);
}

// The changes a deployment would make, without making them (ARM what-if). Secure parameter values are
// not part of the result.
export async function whatIfDeployment(groupPath, name, bodyText) {
  const path = `${groupPath}/providers/Microsoft.Resources/deployments/${name}/whatIf?api-version=2021-04-01`;
  const first = await arm('POST', path, bodyText, { ok: [200, 202] });
  const done = await pollLocation(first, `what-if of ${name}`);
  return done.json?.properties?.changes ?? [];
}

export async function runDeployment(groupPath, name, bodyText, { timeoutMs = 45 * 60_000 } = {}) {
  const path = `${groupPath}/providers/Microsoft.Resources/deployments/${name}`;
  await arm('PUT', `${path}?${DEPLOYMENTS_API}`, bodyText);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await arm('GET', `${path}?${DEPLOYMENTS_API}`);
    const state = json.properties.provisioningState;
    if (state === 'Succeeded') return json;
    if (['Failed', 'Canceled'].includes(state)) {
      const operations = await arm('GET', `${path}/operations?${DEPLOYMENTS_API}`);
      const failures = operations.json.value
        .filter((op) => op.properties.provisioningState === 'Failed')
        .map((op) => `${op.properties.targetResource?.resourceType ?? '?'}: ${JSON.stringify(op.properties.statusMessage?.error ?? op.properties.statusMessage)}`);
      throw new Error(redactSecrets(`deployment ${name} ${state}:\n  ${failures.join('\n  ')}`));
    }
    if (Date.now() > deadline) throw new Error(`deployment ${name} still ${state} after ${timeoutMs / 60_000} minutes`);
    await sleep(10_000);
  }
}
