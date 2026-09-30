// T-79 (P-9, ADR-0007): the OpenTelemetry Collector configuration of the network-restricted deployment. JSON is YAML,
// so the collector reads this file as its configuration. The sidecar receives OTLP/HTTP from the gateway on the shared
// loopback and exports metrics to Application Insights with the gateway's managed identity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'otel-collector.azure-private.json'), 'utf8'));

test('T-79 the collector has one pipeline, for metrics, so it holds no receiver for logs or traces', () => {
  assert.deepEqual(Object.keys(config.service.pipelines), ['metrics']);
  // The memory limiter comes first, so the batch processor never holds more than the limit allows.
  assert.deepEqual(config.service.pipelines.metrics, { receivers: ['otlp'], processors: ['memory_limiter', 'batch'], exporters: ['azure_monitor'] });
  assert.deepEqual(Object.keys(config.receivers), ['otlp']);
  // v0.161.0 logs that the name azuremonitor is deprecated and azure_monitor replaces it (measured 2026-09-30).
  assert.deepEqual(Object.keys(config.exporters), ['azure_monitor']);
});

test('T-79 the receiver listens on the loopback only, so no other app in the environment can send to it', () => {
  assert.deepEqual(config.receivers.otlp, { protocols: { http: { endpoint: 'localhost:4318' } } });
});

test('T-79 the exporter authenticates with the gateway\'s user-assigned identity, for the Azure Monitor audience', () => {
  assert.equal(config.exporters.azure_monitor.connection_string, '${env:APPLICATIONINSIGHTS_CONNECTION_STRING}');
  assert.deepEqual(config.exporters.azure_monitor.auth, { authenticator: 'azure_auth' });
  assert.deepEqual(config.extensions, { azure_auth: { managed_identity: { client_id: '${env:AZURE_CLIENT_ID}' }, scopes: ['https://monitor.azure.com/.default'] } });
  assert.deepEqual(config.service.extensions, ['azure_auth']);
});
