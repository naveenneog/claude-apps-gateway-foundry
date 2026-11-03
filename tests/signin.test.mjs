import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selfSignedCertificate, thumbprints } from '../infra/azure-test/lib/x509.mjs';
import { certPlan, imageSupportsCertificate, keyCredentialsBody, signInMode, templateForCredential } from '../infra/azure-test/lib/signin.mjs';
import { templateForDatabase, unmanagedAppSettings } from '../infra/azure-test/lib/plan.mjs';

const NOW = new Date('2026-11-03T12:00:00Z');
const OWN = 'gateway-test run-1';
const cert = (months, now = NOW) => selfSignedCertificate({ commonName: 'claude-gateway', months, now });
const registered = (c, name = OWN) => ({ customKeyIdentifier: thumbprints(c.certPem).sha1Hex, displayName: name, endDateTime: c.notAfter.toISOString(), type: 'AsymmetricX509Cert' });
const template = () => JSON.parse(fs.readFileSync(new URL('../infra/azure-test/gateway-test.json', import.meta.url), 'utf8'));

test('T-152 signInMode: an explicit option wins; then the recorded mode; an app that already signs in with a secret keeps it; a new install uses a certificate', () => {
  assert.equal(signInMode({ option: 'secret', state: { signIn: { mode: 'certificate' } }, liveSecretNames: [] }), 'secret');
  assert.equal(signInMode({ option: undefined, state: { signIn: { mode: 'certificate' } }, liveSecretNames: ['oidc-client-secret'] }), 'certificate');
  assert.equal(signInMode({ option: undefined, state: {}, liveSecretNames: ['oidc-client-secret', 'jwt-secret'] }), 'secret');
  assert.equal(signInMode({ option: undefined, state: {}, liveSecretNames: [] }), 'certificate');
  assert.throws(() => signInMode({ option: 'password', state: {}, liveSecretNames: [] }), /certificate or secret/);
});

test('T-152 certPlan: reuse a registered certificate with more than 30 days left; otherwise, or when forced, issue a new one', () => {
  const live = cert(12);
  const keys = [registered(live)];
  assert.deepEqual(certPlan({ livePem: live.keyPem + live.certPem, keyCredentials: keys, ownName: OWN, now: NOW }).action, 'reuse');
  assert.equal(certPlan({ livePem: null, keyCredentials: [], ownName: OWN, now: NOW }).action, 'issue');
  assert.match(certPlan({ livePem: null, keyCredentials: [], ownName: OWN, now: NOW }).reason, /no certificate/);
  const soon = cert(1);
  const p = certPlan({ livePem: soon.keyPem + soon.certPem, keyCredentials: [registered(soon)], ownName: OWN, now: new Date('2026-11-10T12:00:00Z') });
  assert.equal(p.action, 'issue');
  assert.match(p.reason, /ends 2026-12-03/);
  assert.equal(p.keep?.certPem, soon.certPem, 'the running certificate stays registered until the new revision is ready');
  assert.equal(certPlan({ livePem: live.keyPem + live.certPem, keyCredentials: [], ownName: OWN, now: NOW }).action, 'issue', 'not registered in Entra');
  assert.equal(certPlan({ livePem: live.keyPem + live.certPem, keyCredentials: keys, ownName: OWN, now: NOW, force: true }).action, 'issue');
  const expired = certPlan({ livePem: soon.keyPem + soon.certPem, keyCredentials: [registered(soon)], ownName: OWN, now: new Date('2027-01-01T00:00:00Z') });
  assert.equal(expired.keep, null, 'an expired certificate is not kept');
});

test('T-152 certPlan refuses to replace certificates the installer did not register, because Graph replaces the whole set', () => {
  const live = cert(12);
  assert.throws(() => certPlan({ livePem: null, keyCredentials: [registered(live, 'someone else')], ownName: OWN, now: NOW }), /someone else.*not made by the installer/);
});

test('T-152 keyCredentialsBody: each certificate as an AsymmetricX509Cert Verify key with its DER in base64 and this install\'s name', () => {
  const a = cert(12); const b = cert(12);
  const body = keyCredentialsBody([a.certPem, b.certPem], OWN);
  assert.equal(body.keyCredentials.length, 2);
  assert.deepEqual(Object.keys(body.keyCredentials[0]).sort(), ['displayName', 'key', 'type', 'usage']);
  assert.equal(body.keyCredentials[0].type, 'AsymmetricX509Cert');
  assert.equal(body.keyCredentials[0].usage, 'Verify');
  assert.equal(body.keyCredentials[0].displayName, OWN);
  assert.equal(Buffer.from(body.keyCredentials[1].key, 'base64').equals(thumbprints(b.certPem).der), true);
});

test('T-152 templateForCredential: a certificate replaces the client secret with the PEM secret and starts the gateway through the entrypoint', () => {
  for (const database of ['sidecar', 'managed']) {
    const t = templateForCredential(templateForDatabase(template(), database), 'certificate');
    const app = t.resources.find((r) => r.type === 'Microsoft.App/containerApps');
    const secrets = app.properties.configuration.secrets;
    assert.ok(!secrets.some((s) => s.name === 'oidc-client-secret'), database);
    assert.equal(secrets.find((s) => s.name === 'oidc-certificate').value, "[parameters('oidcCertificatePem')]");
    assert.equal(t.parameters.oidcCertificatePem.type, 'securestring');
    const gateway = app.properties.template.containers.find((c) => c.name === 'gateway');
    assert.ok(!gateway.env.some((e) => e.name === 'OIDC_CLIENT_SECRET'));
    assert.deepEqual(gateway.env.find((e) => e.name === 'GATEWAY_IDP_PEM'), { name: 'GATEWAY_IDP_PEM', secretRef: 'oidc-certificate' });
    assert.deepEqual(gateway.command, ['/bin/bash', '/usr/local/bin/gateway-entrypoint.sh']);
    assert.deepEqual(gateway.args ?? [], []);
  }
  const secret = templateForDatabase(template(), 'managed');
  assert.deepEqual(templateForCredential(secret, 'secret'), secret, 'a secret leaves the template as it is');
});

test('T-152 unmanagedAppSettings treats both sign-in settings as the template\'s own, so switching between them is not refused', () => {
  const cert = templateForCredential(template(), 'certificate');
  assert.deepEqual(unmanagedAppSettings({ secretNames: ['oidc-client-secret', 'jwt-secret'], gatewayEnv: ['OIDC_CLIENT_SECRET'] }, cert), []);
  assert.deepEqual(unmanagedAppSettings({ secretNames: ['oidc-certificate'], gatewayEnv: ['GATEWAY_IDP_PEM'] }, template()), []);
  assert.deepEqual(unmanagedAppSettings({ secretNames: ['foundry-key'], gatewayEnv: [] }, cert), ['secret foundry-key'], 'anything else is still reported');
});

test('T-152 imageSupportsCertificate: only an image built from 2.1.311 or later has the entrypoint that splits the PEM', () => {
  assert.equal(imageSupportsCertificate('claude-gateway:2.1.311-202611031900'), true);
  assert.equal(imageSupportsCertificate('claude-gateway:2.2.0-202612010000'), true);
  assert.equal(imageSupportsCertificate('claude-gateway:2.1.280-202610010000'), false);
  assert.equal(imageSupportsCertificate(undefined), false);
});
