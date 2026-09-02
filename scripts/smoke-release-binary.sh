#!/bin/sh
set -eu

binary=${1:-}
if [ -z "$binary" ] || [ ! -x "$binary" ]; then
  echo "usage: smoke-release-binary.sh /path/to/friday-binary" >&2
  exit 2
fi
binary=$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")
root=$(mktemp -d "${TMPDIR:-/tmp}/friday-sea-smoke.XXXXXXXX")
home="$root/.friday"
workspace="$root/FRIDAY-workspace"
unsafe="$root/unsafe-bootstrap-home"
out="$root/stdout.log"
err="$root/stderr.log"
pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$home" "$unsafe"
chmod 0700 "$home" "$unsafe"
cat > "$home/runtime.env" <<SETTINGS
FRIDAY_MODEL_PROVIDER="openai"
FRIDAY_MODEL_ID="gpt-5"
FRIDAY_PERMISSION_MODE="ask"
FRIDAY_TIMEZONE="UTC"
FRIDAY_WORKSPACE="$workspace"
SETTINGS
chmod 0600 "$home/runtime.env"

(
  cd "$unsafe"
  FRIDAY_HOME="$home" FRIDAY_WORKSPACE="$workspace" "$binary" >"$out" 2>"$err"
) &
pid=$!

ready=0
i=0
while [ "$i" -lt 150 ]; do
  if grep -q '^FRIDAY ready\.$' "$out" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.1
done

if [ "$ready" -ne 1 ]; then
  echo "Packaged FRIDAY did not reach runtime readiness" >&2
  cat "$out" >&2 2>/dev/null || true
  cat "$err" >&2 2>/dev/null || true
  exit 1
fi

test -d "$workspace"
case "$(cd "$workspace" && pwd)" in
  "$home"|"$home"/*) echo "Runtime workspace overlapped FRIDAY_HOME" >&2; exit 1 ;;
esac

kill -TERM "$pid"
if ! wait "$pid"; then
  echo "Packaged FRIDAY did not shut down cleanly after SIGTERM" >&2
  cat "$err" >&2 2>/dev/null || true
  exit 1
fi
pid=""
echo "FRIDAY packaged runtime smoke: PASS"
