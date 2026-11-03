# Claude apps gateway image for the Azure test deployment (docs/adr/0003-*.md).
# Recipe: https://code.claude.com/docs/en/claude-apps-gateway-deploy#container-image
# The release is trusted only after verify-release.sh checks the signed manifest, the signing key's
# fingerprint and the pinned checksum. Build: az acr build --registry <acr> --image <name> <this dir>
ARG BASE_IMAGE=mcr.microsoft.com/azurelinux/base/core:3.0@sha256:88fc2b4a425801b3b4d8fe5342e24fb6134669fb718ec970340bdd36dee50c35

FROM ${BASE_IMAGE} AS fetch
ARG CLAUDE_VERSION=2.1.311
ARG CLAUDE_SHA256=86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada
ARG CLAUDE_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
ARG RELEASES=https://downloads.claude.ai/claude-code-releases
RUN tdnf install -y ca-certificates curl gnupg2 grep coreutils && tdnf clean all
COPY verify-release.sh /usr/local/bin/verify-release.sh
WORKDIR /release
RUN set -eu; \
    curl -fsSL --proto '=https' -o key.asc https://downloads.claude.ai/keys/claude-code.asc; \
    curl -fsSL --proto '=https' -o manifest.json "${RELEASES}/${CLAUDE_VERSION}/manifest.json"; \
    curl -fsSL --proto '=https' -o manifest.json.sig "${RELEASES}/${CLAUDE_VERSION}/manifest.json.sig"; \
    curl -fsSL --proto '=https' -o claude "${RELEASES}/${CLAUDE_VERSION}/linux-x64/claude"; \
    bash /usr/local/bin/verify-release.sh /release "${CLAUDE_VERSION}" linux-x64 "${CLAUDE_SHA256}" "${CLAUDE_KEY_FINGERPRINT}"; \
    chmod 0755 claude

FROM ${BASE_IMAGE}
RUN tdnf install -y ca-certificates && tdnf clean all
COPY --from=fetch /release/claude /usr/local/bin/claude
COPY gateway-entrypoint.sh /usr/local/bin/gateway-entrypoint.sh
ENV CLAUDE_CONFIG_DIR=/tmp/.claude HOME=/tmp
USER 10001:10001
EXPOSE 8080
CMD ["/bin/bash", "/usr/local/bin/gateway-entrypoint.sh"]
