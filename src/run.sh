#!/usr/bin/env bash
# cursor-langfuse hook wrapper — queue + batch-flush.
#
# Cursor blocks on "before" hooks (e.g. beforeReadFile fires on every file read),
# so doing network I/O here would add latency to the agent. Instead, every hook
# just appends its payload to a per-conversation queue (a fast local file write,
# no node) and returns immediately. At turn boundaries (afterAgentResponse/stop)
# the queue is flushed to Langfuse in ONE batched request.
#
# Result: high-frequency hooks add ~no latency, and we make ~1 HTTP call per turn
# instead of one per read.
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
[ -z "$CONV" ] && CONV="default"
SAFE_CONV="$(printf '%s' "$CONV" | tr -c 'A-Za-z0-9._-' '_')"

# Respond immediately so the agent is never blocked waiting on tracing.
case "$EVENT" in
  beforeSubmitPrompt) printf '{"continue":true}\n' ;;
  beforeShellExecution|beforeMCPExecution|beforeReadFile|beforeTabFileRead) printf '{"permission":"allow"}\n' ;;
esac

# Enqueue this payload (one JSON file per event; concurrency-safe, no locking).
QDIR="$DIR/.queue/$SAFE_CONV"
mkdir -p "$QDIR" 2>/dev/null || true
printf '%s' "$PAYLOAD" > "$QDIR/$(date +%s)-$$-${RANDOM}.json" 2>/dev/null || true

# Flush the conversation's queue at turn boundaries (low-frequency, not latency-critical).
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
      "$NODE_BIN" "$DIR/hook-handler.js" --flush "$QDIR" >>"$LOG" 2>&1 || true
    fi
    ;;
esac
exit 0
