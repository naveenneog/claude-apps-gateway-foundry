#!/usr/bin/env bash
# Checks a Claude Code release download against its GPG-signed manifest before the image uses it.
# Procedure: https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing
# Usage: verify-release.sh <dir> <version> <platform> <sha256> <key-fingerprint>
#   <dir> holds key.asc, manifest.json, manifest.json.sig and claude.
# Behaviour under tampering is tested in tests/verify-release.test.mjs.
set -euo pipefail

fail() {
  echo "verify-release: $*" >&2
  exit 1
}

[ "$#" -eq 5 ] || fail "usage: verify-release.sh <dir> <version> <platform> <sha256> <key-fingerprint>"
dir=$1 version=$2 platform=$3 pinned=$4 fingerprint=$5
[[ $pinned =~ ^[0-9a-f]{64}$ ]] || fail "pinned SHA-256 is not 64 lowercase hex characters"
[[ $fingerprint =~ ^[0-9A-F]{40}$ ]] || fail "key fingerprint is not 40 uppercase hex characters"
[[ $platform =~ ^[a-z0-9-]+$ ]] || fail "platform is not a plain name"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version is not of the form N.N.N"
for file in key.asc manifest.json manifest.json.sig claude; do
  [ -f "$dir/$file" ] || fail "missing $dir/$file"
done

GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT

gpg --batch --quiet --import "$dir/key.asc" 2>/dev/null || fail "key.asc does not import"
listing=$(gpg --batch --with-colons --fingerprint)
grep -qx "fpr:::::::::${fingerprint}:" <<<"$listing" || fail "key.asc does not hold key $fingerprint"
gpg --batch --status-file "$GNUPGHOME/status" --verify "$dir/manifest.json.sig" "$dir/manifest.json" 2>/dev/null ||
  fail "manifest signature does not verify"
# A signature from any other key in key.asc also verifies, so the signer must be the pinned key.
grep -Eq "^\[GNUPG:\] VALIDSIG [0-9A-F]{40} .* ${fingerprint}\$" "$GNUPGHOME/status" ||
  fail "manifest is not signed by key $fingerprint"

manifest=$(tr -d '\r\n' <"$dir/manifest.json")
[[ $manifest =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] || fail "manifest has no version"
[ "${BASH_REMATCH[1]}" = "$version" ] || fail "manifest version ${BASH_REMATCH[1]} is not $version"
[[ $manifest =~ \"$platform\"[[:space:]]*:[[:space:]]*[{][^{}]*\"checksum\"[[:space:]]*:[[:space:]]*\"([0-9a-f]{64})\" ]] ||
  fail "manifest has no checksum for $platform"
[ "${BASH_REMATCH[1]}" = "$pinned" ] || fail "manifest checksum for $platform is not the pinned value"
actual=$(sha256sum "$dir/claude" | cut -d' ' -f1)
[ "$actual" = "$pinned" ] || fail "binary checksum $actual is not the pinned value"
echo "verify-release: $version $platform verified against key $fingerprint"
