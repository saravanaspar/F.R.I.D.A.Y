#!/bin/sh
set -eu
umask 077

repo="${1:-${FRIDAY_GITHUB_REPOSITORY:-}}"
if [ -z "$repo" ]; then
  echo "usage: install-release.sh OWNER/REPO" >&2
  exit 2
fi
owner=${repo%%/*}
name=${repo#*/}
case "$owner" in ''|*[!A-Za-z0-9_.-]*) echo "invalid GitHub repository owner" >&2; exit 2 ;; esac
case "$name" in ''|*/*|*[!A-Za-z0-9_.-]*) echo "invalid GitHub repository name" >&2; exit 2 ;; esac
if [ "$name" = "$repo" ]; then
  echo "usage: install-release.sh OWNER/REPO" >&2
  exit 2
fi

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) echo "Windows release binaries are not published yet; FRIDAY's private-state hardening currently requires POSIX filesystem permissions." >&2; exit 1 ;;
  *) echo "unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="friday-${os}-${arch}"
binary="friday"
provenance_asset="friday-build-provenance.json"

install_dir="${FRIDAY_INSTALL_DIR:-$HOME/.local/bin}"
url="https://github.com/${repo}/releases/latest/download/${asset}"
provenance_url="https://github.com/${repo}/releases/latest/download/${provenance_asset}"
tmp_root="${TMPDIR:-/tmp}"
tmp_dir="$(mktemp -d "${tmp_root%/}/friday-install.XXXXXXXX")"
tmp="$tmp_dir/$binary"
sum="$tmp_dir/${asset}.sha256"
provenance="$tmp_dir/$provenance_asset"
target_tmp=""
cleanup() {
  [ -n "$target_tmp" ] && rm -f "$target_tmp" 2>/dev/null || true
  rm -rf "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$install_dir"
target_tmp="$(mktemp "${install_dir%/}/.friday-install.XXXXXXXX")"
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) with artifact-attestation support is required to verify FRIDAY release provenance." >&2
  echo "Install or upgrade gh, then run this installer again." >&2
  exit 1
fi
echo "Installing FRIDAY from $url"
curl -fL --proto '=https' --tlsv1.2 "$url" -o "$tmp"
curl -fL --proto '=https' --tlsv1.2 "${url}.sha256" -o "$sum"
curl -fL --proto '=https' --tlsv1.2 "$provenance_url" -o "$provenance"
expected="$(awk 'NF { print $1; exit }' "$sum")"
case "$expected" in
  ''|*[!0-9A-Fa-f]* ) echo "FRIDAY checksum file is invalid" >&2; exit 1 ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo "FRIDAY checksum file is invalid" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required to verify the FRIDAY binary" >&2
  exit 1
fi
if [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" != "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" ]; then
  echo "FRIDAY binary checksum verification failed" >&2
  exit 1
fi
if ! gh attestation verify "$tmp" \
  --repo "$repo" \
  --bundle "$provenance" \
  --cert-identity "https://github.com/${repo}/.github/workflows/release.yml@refs/heads/main" \
  --source-ref "refs/heads/main" \
  --deny-self-hosted-runners >/dev/null; then
  echo "FRIDAY build provenance verification failed" >&2
  exit 1
fi
cat "$tmp" > "$target_tmp"
chmod 0755 "$target_tmp"
mv -f "$target_tmp" "$install_dir/$binary"
target_tmp=""

"$install_dir/$binary" --version
printf '\nInstalled %s\n' "$install_dir/$binary"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH, then run: friday setup\n' "$install_dir" ;;
esac
