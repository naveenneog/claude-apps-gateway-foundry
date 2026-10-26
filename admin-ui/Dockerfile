# admin-ui image (ADR-0008): a plain Node.js 22 service, no build step and no npm dependencies (this repository's
# own convention, README.md). The official node:22-alpine image, not the gateway's Azure Linux base: this service
# doesn't need the gateway's own pinned-binary verification chain, and Alpine keeps the image small for a service
# that is just a thin HTTP server over two external APIs.
#
# Build context must be the REPOSITORY ROOT, not admin-ui/: admin-ui/server/*.mjs imports
# ../../scripts/admin/*.mjs directly (reusing set-developer.mjs and new-gateway-config.mjs unmodified, so the
# gateway's own admin tooling and the admin-ui's never drift apart into two implementations of the same Graph
# calls), and Docker COPY cannot reach outside its build context with ../.
#   az acr build --registry <acr> --image admin-ui:<tag> --file admin-ui/Dockerfile .    (run from the repository root)
FROM node:22-alpine
RUN addgroup -S adminui && adduser -S adminui -G adminui
WORKDIR /app
COPY scripts ./scripts
# new-client-policy.mjs, which the client-kit route reuses, imports the address-range helpers from here (P-41).
COPY infra/azure-test/lib ./infra/azure-test/lib
COPY admin-ui/server ./admin-ui/server
COPY admin-ui/web ./admin-ui/web
RUN chown -R adminui:adminui /app
USER adminui
WORKDIR /app/admin-ui
EXPOSE 8080
CMD ["node", "server/server.mjs"]
