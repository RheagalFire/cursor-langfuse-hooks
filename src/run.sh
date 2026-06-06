#!/usr/bin/env bash
# cursor-langfuse hook wrapper — transcript-driven.
#
# Cursor fires per-event hooks inconsistently, so we don't build traces from
# them. On the reliable turn-end events (stop / afterAgentResponse) we rebuild
# the whole turn's trace from Cursor's transcript file.
#
# For a real total duration (Cursor reports none), we stamp the turn START on
# beforeSubmitPrompt and pass it to the handler at turn end.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PAYLOAD="$(cat)"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DIR/.env"
  set +a
fi

EVENT="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
CONV="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"conversation_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
SAFE_CONV="$(printf '%s' "${CONV:-default}" | tr -c 'A-Za-z0-9._-' '_')"
STARTDIR="$DIR/.turnstart"

# Permissive responses for any before* hooks; record turn start on submit.
case "$EVENT" in
  beforeSubmitPrompt)
    printf '{"continue":true}\n'
    mkdir -p "$STARTDIR" 2>/dev/null || true
    date +%s > "$STARTDIR/$SAFE_CONV" 2>/dev/null || true
    ;;
  beforeShellExecution|beforeMCPExecution|beforeReadFile|beforeTabFileRead) printf '{"permission":"allow"}\n' ;;
esac

# Turn-end events: rebuild the trace from the transcript.
case "$EVENT" in
  stop|afterAgentResponse)
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ]; then
      for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node /usr/bin/node; do
        [ -x "$c" ] && NODE_BIN="$c" && break
      done
    fi
    if [ -n "$NODE_BIN" ]; then
      START="$(cat "$STARTDIR/$SAFE_CONV" 2>/dev/null || true)"
      LOG="/dev/null"; [ "${CURSOR_LANGFUSE_DEBUG:-0}" = "1" ] && LOG="$DIR/hook-debug.log"
      printf '%s' "$PAYLOAD" | CURSOR_LANGFUSE_TURN_START="$START" "$NODE_BIN" "$DIR/hook-handler.js" >>"$LOG" 2>&1 || true
    fi
    ;;
esac
exit 0
