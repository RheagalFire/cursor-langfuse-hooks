#!/usr/bin/env bash
# cursor-langfuse hook wrapper.
#
# - loads credentials from the gitignored .env beside this script
# - resolves a node binary even under Cursor's minimal GUI PATH
# - forwards Cursor's stdin payload to the handler
# - optional debug log when CURSOR_LANGFUSE_DEBUG=1
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PAYLOAD="$(cat)"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DIR/.env"
  set +a
fi

# GUI-launched apps often have a minimal PATH (no Homebrew/nvm); fall back.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node /usr/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi

if [ "${CURSOR_LANGFUSE_DEBUG:-0}" = "1" ]; then
  {
    echo "---- $(date '+%Y-%m-%dT%H:%M:%S%z') ----"
    echo "node=$NODE_BIN"
    echo "payload=${PAYLOAD:0:200}"
  } >> "$DIR/hook-debug.log" 2>&1
fi

if [ -z "$NODE_BIN" ]; then
  echo '{"continue":true}'
  exit 0
fi

LOG_REDIR="/dev/null"
[ "${CURSOR_LANGFUSE_DEBUG:-0}" = "1" ] && LOG_REDIR="$DIR/hook-debug.log"
printf '%s' "$PAYLOAD" | "$NODE_BIN" "$DIR/hook-handler.js" 2>>"$LOG_REDIR"
