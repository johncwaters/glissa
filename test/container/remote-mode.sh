#!/usr/bin/env bash
# Remote-mode integration suite. Runs INSIDE the container built from test/container/Dockerfile
# (npm run test:container), because it needs real listeners, a real ~/.glissa, and a Linux host.
#
# It exercises the whole pairing lifecycle against two live listeners: the unauthenticated local one
# and the cookie-gated remote one. Everything the unit tests cannot reach (actual sockets, actual
# cookies, actual fs.watch propagation of a revocation) lives here.
set -uo pipefail

GLISSA_DIR=/root/.glissa
CONFIG=$GLISSA_DIR/config.json
WORK=/tmp/remote-mode
LOCAL=http://127.0.0.1:3000
REMOTE=http://127.0.0.1:3001

mkdir -p "$GLISSA_DIR" "$WORK"
rm -f "$GLISSA_DIR/pairings.json" "$GLISSA_DIR/pairings-seen.json"

failures=0
assert() {
  local number="$1" expected="$2" actual="$3" what="$4"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS [$number] $what"
    return 0
  fi
  echo "  FAIL [$number] $what (expected '$expected', got '$actual')"
  failures=$((failures + 1))
  return 1
}

write_config() {
  local remote_enabled="$1"
  cat > "$CONFIG" <<EOF
{
  "port": 3000,
  "remote": {
    "enabled": $remote_enabled,
    "port": 3001,
    "publicHost": "glissa.test",
    "allowedOrigins": ["https://glissa.test"]
  },
  "projects": []
}
EOF
}

SERVER_PID=""
start_server() {
  node server/main.ts > "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$LOCAL/"; then return 0; fi
    sleep 0.5
  done
  echo "  FAIL server did not come up; log follows"
  cat "$WORK/server.log"
  exit 1
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}
trap stop_server EXIT

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== remote mode enabled =="
write_config true
start_server
grep -q 'remote listener' "$WORK/server.log" || { echo "  FAIL no remote listener line in the boot log"; cat "$WORK/server.log"; exit 1; }

assert 1 200 "$(status "$LOCAL/")" "local listener serves the dashboard unauthenticated"
assert 2 401 "$(status "$REMOTE/")" "remote listener refuses an unpaired device"

PAIR_OUT="$(node bin/glissa.ts pair --name test-device)"
echo "$PAIR_OUT" | sed 's/^/    | /'
TOKEN="$(printf '%s' "$PAIR_OUT" | grep -o '/pair/[A-Za-z0-9_-]\+' | head -1 | sed 's|/pair/||')"
URL_PRINTED="$(printf '%s' "$PAIR_OUT" | grep -c 'https://glissa.test/pair/')"
PAIR_URL_OK=no
if [ -n "$TOKEN" ] && [ "$URL_PRINTED" = "1" ]; then PAIR_URL_OK=yes; fi
assert 3 yes "$PAIR_URL_OK" "pair prints a single-use URL built from publicHost"
printf '%s' "$PAIR_OUT" | grep -qi 'password' \
  && echo "  PASS [3b] the output warns the link is a password" \
  || { echo "  FAIL [3b] no password warning in the pair output"; failures=$((failures + 1)); }

REDEEM_CODE="$(curl -s -o /dev/null -D "$WORK/pair-headers.txt" -c "$WORK/jar.txt" -w '%{http_code}' "$REMOTE/pair/$TOKEN")"
assert 4 303 "$REDEEM_CODE" "redeeming the pairing link redirects"
SET_COOKIE="$(grep -i '^set-cookie:' "$WORK/pair-headers.txt" | tr -d '\r')"
case "$SET_COOKIE" in
  *glissa_device=*HttpOnly*) echo "  PASS [4b] Set-Cookie glissa_device is HttpOnly" ;;
  *) echo "  FAIL [4b] expected an HttpOnly glissa_device cookie, got '$SET_COOKIE'"; failures=$((failures + 1)) ;;
esac
COOKIE="$(printf '%s' "$SET_COOKIE" | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)"

assert 5 200 "$(status -b "$WORK/jar.txt" "$REMOTE/")" "the paired cookie jar reaches the dashboard"
assert 5b 600 "$(stat -c '%a' "$GLISSA_DIR/pairings.json")" "pairings.json is created 0600"
assert 5c 0 "$(ls "$GLISSA_DIR" | grep -c 'pairings.json.lock')" "no write lock is left behind"
assert 6 403 "$(status "$REMOTE/pair/$TOKEN")" "replaying the pairing link is refused (single use)"

WS_NO_COOKIE="$(node test/container/ws-check.js ws://127.0.0.1:3001/control | cut -d' ' -f1)"
assert 7 REJECTED "$WS_NO_COOKIE" "control WS on the remote listener is refused without a cookie"
# An Origin is mandatory on the dashboard channels since the 2026-08 security pass, so the paired
# device sends the one it was configured with (a browser always does).
WS_COOKIE="$(node test/container/ws-check.js ws://127.0.0.1:3001/control --cookie "$COOKIE" --origin https://glissa.test | cut -d' ' -f1)"
assert 7 OK "$WS_COOKIE" "control WS with the paired cookie connects and receives a snapshot"
WS_NO_ORIGIN="$(node test/container/ws-check.js ws://127.0.0.1:3001/control --cookie "$COOKIE" | cut -d' ' -f1)"
assert 7b REJECTED "$WS_NO_ORIGIN" "a control WS with no Origin at all is refused"

WS_EVIL="$(node test/container/ws-check.js ws://127.0.0.1:3001/control --cookie "$COOKIE" --origin https://evil.example | cut -d' ' -f1)"
assert 8 REJECTED "$WS_EVIL" "a foreign Origin is refused even with a valid cookie"
WS_GOOD="$(node test/container/ws-check.js ws://127.0.0.1:3001/control --cookie "$COOKIE" --origin https://glissa.test | cut -d' ' -f1)"
assert 8 OK "$WS_GOOD" "the configured Origin is accepted"

LIST_OUT="$(node bin/glissa.ts pair --list)"
echo "$LIST_OUT" | sed 's/^/    | /'
DEVICE_ID="$(printf '%s' "$LIST_OUT" | awk 'NR==2 {print $1}')"
printf '%s' "$LIST_OUT" | grep -q 'test-device' \
  && echo "  PASS [9] pair --list shows the paired device" \
  || { echo "  FAIL [9] pair --list did not show test-device"; failures=$((failures + 1)); }
REVOKE_OUT="$(node bin/glissa.ts pair --revoke "$DEVICE_ID")"
echo "$REVOKE_OUT" | sed 's/^/    | /'
printf '%s' "$REVOKE_OUT" | grep -q '30 seconds' \
  && echo "  PASS [9b] revoke quotes the worst-case propagation, not an instant promise" \
  || { echo "  FAIL [9b] revoke output does not state the bounded propagation window"; failures=$((failures + 1)); }
sleep 2  # fs.watch debounce: the running server reloads the device list without a restart
assert 9 401 "$(status -b "$WORK/jar.txt" "$REMOTE/")" "revocation locks the device out with no restart"

FRESH_OUT="$(node bin/glissa.ts pair --name expiring-device)"
FRESH_TOKEN="$(printf '%s' "$FRESH_OUT" | grep -o '/pair/[A-Za-z0-9_-]\+' | head -1 | sed 's|/pair/||')"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
const doc = JSON.parse(fs.readFileSync(p, "utf8"));
doc.pending[doc.pending.length - 1].expiresAt = 1;
fs.writeFileSync(p, JSON.stringify(doc, null, 2));
' "$GLISSA_DIR/pairings.json"
assert 10 403 "$(status "$REMOTE/pair/$FRESH_TOKEN")" "an expired pending token cannot be redeemed"

echo "== remote mode disabled =="
stop_server
write_config false
start_server
grep -q 'remote mode is disabled' "$WORK/server.log" || { echo "  FAIL boot log does not report remote disabled"; failures=$((failures + 1)); }
assert 11 200 "$(status "$LOCAL/")" "the local listener still serves the dashboard"
REMOTE_CURL_EXIT=0
curl -s -o /dev/null --max-time 5 "$REMOTE/" || REMOTE_CURL_EXIT=$?
assert 11 7 "$REMOTE_CURL_EXIT" "the remote port refuses connections (curl exit 7)"
NO_COOKIE_HEADERS="$(curl -s -o /dev/null -D - "$LOCAL/pair/$FRESH_TOKEN" | grep -ci 'set-cookie' || true)"
assert 11 0 "$NO_COOKIE_HEADERS" "no Set-Cookie is issued anywhere with remote disabled"

echo
if [ "$failures" -eq 0 ]; then
  echo "remote-mode container suite: ALL ASSERTIONS PASSED"
  exit 0
fi
echo "remote-mode container suite: $failures FAILED"
exit 1
