#!/usr/bin/env bash
# cursor-langfuse hook wrapper — transcript-driven.
#
# Cursor fires per-event hooks inconsistently, so we don't build traces from
# them. Instead, on the reliable turn-end events (stop / afterAgentResponse) we
# rebuild the whole conversation trace from Cursor's transcript file. Those are
# the only events that do work here; any other registered hook just gets a fast
# permissive response so the agent is never blocked.
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

# Permissive responses for any before* hooks that happen to be registered.
case "$EVENT" in
  beforeSubmitPrompt) printf '{"continue":true}\n' ;;
  beforeShellExecution|beforeMCPExecution|beforeReadFile|beforeTabFileRead) printf '{"permission":"allow"}\n' ;;
esac

# Only turn-end events do work: rebuild the trace from the transcript.
case "$EVENT" in
  stop|afterAgentResponse)
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ]; then
      for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node /usr/bin/node; do
        [ -x "$c" ] && NODE_BIN="$c" && break
      done
    fi
    if [ -n "$NODE_BIN" ]; then
      LOG="/dev/null"; [ "${CURSOR_LANGFUSE_DEBUG:-0}" = "1" ] && LOG="$DIR/hook-debug.log"
      printf '%s' "$PAYLOAD" | "$NODE_BIN" "$DIR/hook-handler.js" >>"$LOG" 2>&1 || true
    fi
    ;;
esac
exit 0
