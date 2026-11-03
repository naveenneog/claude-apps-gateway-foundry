#!/usr/bin/env bash
# Starts the Claude apps gateway (docs/adr/0003-*.md).
# - With the in-app database (GATEWAY_PG_HOST 127.0.0.1, the default) it waits for PostgreSQL to accept TCP connections
#   first: containers in a Container Apps replica start in no fixed order (docs/UNKNOWNS.md, U-35).
# - With GATEWAY_IDP_PEM, a private key and certificate in PEM (ADR-0016), it writes the key and the first certificate to
#   GATEWAY_IDP_DIR (mode 0600) and starts from a copy of the configuration whose client_secret line is replaced by
#   private_key_jwt (https://code.claude.com/docs/en/claude-apps-gateway-config#certificate-client-authentication).
# Pure bash: the image's Azure Linux core base has no awk or sed.
set -euo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-/usr/local/bin/claude}"
CONFIG="${GATEWAY_CONFIG:-/etc/claude/gateway.yaml}"
IDP_DIR="${GATEWAY_IDP_DIR:-/tmp/idp}"
SECRET_LINE='  client_secret: "${OIDC_CLIENT_SECRET}"'
fail() { echo "[entrypoint] $*" >&2; exit 1; }

if [ -n "${GATEWAY_IDP_PEM:-}" ]; then
  umask 077
  mkdir -p "$IDP_DIR"
  key="" cert="" in_key=0 in_cert=0 certs=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      "-----BEGIN PRIVATE KEY-----"|"-----BEGIN RSA PRIVATE KEY-----") in_key=1 ;;  # PEM boundary markers: not-a-secret
      "-----BEGIN CERTIFICATE-----") certs=$((certs + 1)); [ "$certs" -eq 1 ] && in_cert=1 ;;
    esac
    [ "$in_key" -eq 1 ] && key+="$line"$'\n'
    [ "$in_cert" -eq 1 ] && cert+="$line"$'\n'
    case "$line" in
      "-----END PRIVATE KEY-----"|"-----END RSA PRIVATE KEY-----") in_key=0 ;;
      "-----END CERTIFICATE-----") in_cert=0 ;;
    esac
  done <<< "$GATEWAY_IDP_PEM"
  [ -n "$key" ] || fail "GATEWAY_IDP_PEM holds no private key; the gateway was not started"
  [ -n "$cert" ] || fail "GATEWAY_IDP_PEM holds no certificate; the gateway was not started"
  printf '%s' "$key" > "$IDP_DIR/key.pem"
  printf '%s' "$cert" > "$IDP_DIR/cert.pem"
  out="" swapped=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "${line%$'\r'}" = "$SECRET_LINE" ]; then
      out+="  token_endpoint_auth_method: private_key_jwt"$'\n'"  client_assertion:"$'\n'
      out+="    private_key_pem: \${file:$IDP_DIR/key.pem}"$'\n'"    certificate_pem: \${file:$IDP_DIR/cert.pem}"$'\n'
      swapped=1
    else
      out+="$line"$'\n'
    fi
  done < "$CONFIG"
  [ "$swapped" -eq 1 ] || fail "$CONFIG has no line '$SECRET_LINE' to replace; the gateway was not started"
  printf '%s' "$out" > "$IDP_DIR/gateway.yaml"
  CONFIG="$IDP_DIR/gateway.yaml"
  echo "[entrypoint] sign-in: certificate (private_key_jwt)"
fi

if [ "${GATEWAY_PG_HOST:-127.0.0.1}" = "127.0.0.1" ]; then
  for _ in {1..60}; do
    if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
      exec "$CLAUDE_BIN" gateway --config "$CONFIG"
    fi
    sleep 1
  done
  fail "PostgreSQL did not accept connections on 127.0.0.1:5432 within 60 s"
fi
exec "$CLAUDE_BIN" gateway --config "$CONFIG"