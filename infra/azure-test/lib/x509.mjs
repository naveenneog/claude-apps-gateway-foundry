// ADR-0016 (amended 2026-11-03): the gateway's Entra sign-in certificate, made with Node's crypto alone (no
// dependencies, docs/CHARTER.md): an RSA 2048 key and a self-signed X.509 v3 certificate, DER-encoded by hand.
// Used by deploy.mjs's app stage and admin-ui's renewal job. https://www.rfc-editor.org/rfc/rfc5280#section-4.1
import crypto from 'node:crypto';

const len = (n) => (n < 0x80 ? Buffer.from([n]) : (() => { const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) { const chunk = [n & 0x7f]; let v = n >> 7; while (v > 0) { chunk.unshift(0x80 | (v & 0x7f)); v >>= 7; } bytes.push(...chunk); }
  return tlv(0x06, Buffer.from(bytes));
};
const integer = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const explicit = (n, body) => tlv(0xa0 + n, body);
const utcTime = (d) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

/**
 * A new key and a self-signed certificate valid from five minutes before now for the given whole months (1 to 24).
 * Returns { keyPem (PKCS#8), certPem, notBefore, notAfter }.
 */
export function selfSignedCertificate({ commonName, months, now = new Date(), randomBytes = crypto.randomBytes }) {
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new Error(`the certificate validity is 1 to 24 months, not ${JSON.stringify(months)}`);
  if (typeof commonName !== 'string' || !/^[A-Za-z0-9 ._-]{1,64}$/.test(commonName)) throw new Error(`the certificate common name takes letters, digits, space, dot, dash and underscore, not ${JSON.stringify(commonName)}`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCMonth(notAfter.getUTCMonth() + months);
  const serial = randomBytes(16);
  // RFC 5280, "Serial Number": a positive serial of at most 20 octets. Top bit clear and second bit set: never negative, and the
  // first octet is never 0, which DER would need to strip (code review, 2026-11-03).
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const extensions = explicit(3, seq(
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())), // basicConstraints, critical, not a CA
    seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage: digitalSignature
  ));
  const tbs = seq(explicit(0, integer(Buffer.from([2]))), integer(serial), SHA256_RSA, name(commonName), seq(utcTime(notBefore), utcTime(notAfter)),
    name(commonName), publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem: pem('CERTIFICATE', der), notBefore, notAfter };
}

/** The certificate's DER bytes, its SHA-1 thumbprint as Entra shows it, and the x5t header value the gateway sends. */
export function thumbprints(certPem) {
  const der = new crypto.X509Certificate(certPem).raw;
  const sha1 = crypto.createHash('sha1').update(der).digest();
  return { der, sha1Hex: sha1.toString('hex').toUpperCase(), x5t: sha1.toString('base64url') };
}

/** A PEM holding a private key and one or more certificates, as the private key and the first certificate. */
export function splitPem(text) {
  const key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----\n?/.exec(text);
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/.exec(text);
  if (!key) throw new Error('the PEM holds no private key');
  if (!cert) throw new Error('the PEM holds no certificate');
  const end = (s) => (s.endsWith('\n') ? s : `${s}\n`);
  return { keyPem: end(key[0]), certPem: end(cert[0]) };
}
