# admin-ui image (ADR-0008): a plain Node.js service, no build step and no npm dependencies (this repository's own
# convention, README.md). Base: Microsoft's Azure Linux distroless Node.js image from mcr.microsoft.com, pinned by
# digest, running as its nonroot user; the image has no shell or package manager. Refresh the digest with the newest
# tag 24.<x>-nonroot-azl3.0.<date> from https://mcr.microsoft.com/v2/azurelinux/distroless/nodejs/tags/list.
#
# Build context must be the REPOSITORY ROOT, not admin-ui/: admin-ui/server/*.mjs imports
# ../../scripts/admin/*.mjs directly (reusing set-developer.mjs and new-gateway-config.mjs unmodified, so the
# gateway's own admin tooling and the admin-ui's never drift apart into two implementations of the same Graph
# calls), and Docker COPY cannot reach outside its build context with ../.
#   az acr build --registry <acr> --image admin-ui:<tag> --file admin-ui/Dockerfile .    (run from the repository root)
FROM mcr.microsoft.com/azurelinux/distroless/nodejs:24.22.1-1-nonroot-azl3.0.20261027@sha256:546ae02c9a3537e0a322fe9e594da019350273b82b7e56929bdb32b5482e33cd
WORKDIR /app
# Root-owned and read-only to the nonroot user: the service writes no files.
COPY scripts ./scripts
# new-client-policy.mjs, which the client-kit route reuses, imports the address-range helpers from here (P-41); the
# sign-in renewal (ADR-0016) uses the certificate helpers.
COPY infra/azure-test/lib ./infra/azure-test/lib
COPY admin-ui/server ./admin-ui/server
COPY admin-ui/web ./admin-ui/web
USER nonroot
WORKDIR /app/admin-ui
EXPOSE 8080
CMD ["node", "server/server.mjs"]