import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { selfSignedCertificate, splitPem, thumbprints } from '../infra/azure-test/lib/x509.mjs';

const NOW = new Date('2026-11-03T12:00:00Z');

test('T-150 selfSignedCertificate: an RSA 2048 key and a self-signed certificate Node parses, signed by that key, for the given months', () => {
  const { keyPem, certPem, notAfter } = selfSignedCertificate({ commonName: 'claude-gateway rg-x', months: 12, now: NOW });
  // PKCS#8, unencrypted, as the gateway requires.
  assert.match(keyPem, /^-----BEGIN PRIVATE KEY-----\n/); // not-a-secret: a PEM marker
  const key = crypto.createPrivateKey(keyPem);
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  const cert = new crypto.X509Certificate(certPem);
  assert.equal(cert.subject, 'CN=claude-gateway rg-x');
  assert.equal(cert.issuer, cert.subject, 'self-signed');
  assert.ok(cert.checkPrivateKey(key), 'the certificate holds the key\'s public half');
  assert.ok(cert.verify(cert.publicKey), 'the signature verifies with its own key');
  assert.equal(new Date(cert.validFrom).toISOString(), '2026-11-03T11:55:00.000Z', 'valid from five minutes before, for clock skew');
  assert.equal(new Date(cert.validTo).toISOString(), '2027-11-03T12:00:00.000Z');
  assert.equal(notAfter.toISOString(), '2027-11-03T12:00:00.000Z');
  assert.equal(cert.ca, false);
  const other = selfSignedCertificate({ commonName: 'claude-gateway rg-x', months: 1, now: NOW });
  assert.notEqual(new crypto.X509Certificate(other.certPem).serialNumber, cert.serialNumber, 'a new serial each time');
  assert.equal(new Date(new crypto.X509Certificate(other.certPem).validTo).toISOString(), '2026-12-03T12:00:00.000Z');
});

test('T-150 selfSignedCertificate refuses a validity outside 1 to 24 months and a name that is not plain text', () => {
  for (const months of [0, 25, 1.5, '12']) assert.throws(() => selfSignedCertificate({ commonName: 'x', months, now: NOW }), /1 to 24 months/);
  assert.throws(() => selfSignedCertificate({ commonName: 'a,b=c', months: 12, now: NOW }), /common name/);
});

test('T-150 thumbprints and splitPem: the SHA-1 thumbprint Entra shows, and a combined PEM split into its key and first certificate', () => {
  const { keyPem, certPem } = selfSignedCertificate({ commonName: 'claude-gateway', months: 12, now: NOW });
  const t = thumbprints(certPem);
  assert.equal(t.sha1Hex, new crypto.X509Certificate(certPem).fingerprint.replace(/:/g, ''));
  assert.equal(Buffer.from(t.x5t, 'base64url').toString('hex').toUpperCase(), t.sha1Hex);
  assert.equal(t.der.length > 500, true);
  const combined = `${keyPem}${certPem}${certPem}`;
  assert.deepEqual(splitPem(combined), { keyPem, certPem }, 'only the first certificate, as the gateway requires');
  assert.throws(() => splitPem(certPem), /private key/);
});

test('T-150 code review: a serial whose random first byte is 0x00 or 0x80 still encodes as a minimal positive INTEGER that parses', () => {
  for (const first of [0x00, 0x80, 0x7f, 0xff]) {
    const randomBytes = (n) => Buffer.from([first, 0x10, ...Array(n - 2).fill(0x01)]);
    const { certPem } = selfSignedCertificate({ commonName: 'claude-gateway', months: 1, now: NOW, randomBytes });
    const cert = new crypto.X509Certificate(certPem);
    assert.ok(cert.serialNumber.length >= 30, `first byte ${first}: ${cert.serialNumber}`);
    assert.doesNotThrow(() => thumbprints(certPem));
  }
});