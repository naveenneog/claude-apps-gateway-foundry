#!/usr/bin/env bash
# Starts the Claude apps gateway once the PostgreSQL sidecar accepts TCP connections on 127.0.0.1:5432.
# Containers in a Container Apps replica start in no fixed order (docs/UNKNOWNS.md, U-35).
set -euo pipefail

for _ in {1..60}; do
  if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
    exec /usr/local/bin/claude gateway --config /etc/claude/gateway.yaml
  fi
  sleep 1
done
echo "[entrypoint] PostgreSQL did not accept connections on 127.0.0.1:5432 within 60 s" >&2
exit 1
