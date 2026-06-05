#!/usr/bin/env node
/**
 * Cursor -> Langfuse hook entry point (transcript-driven).
 *
 * Reads a hook payload from stdin. On the reliable turn-end events
 * (stop / afterAgentResponse) it rebuilds the whole conversation trace from
 * Cursor's transcript file and posts it to Langfuse in one batch. Other events
 * are ignored here (run.sh emits any required permissive response).
 *
 * Failures are swallowed — tracing must never break Cursor.
 */

import { readStdin } from "./lib/utils.js";
import { getTrace, flushLangfuse, HOOK_HANDLER_VERSION } from "./lib/langfuse-client.js";
import { buildTraceFromTranscript } from "./lib/handlers.js";

const FLUSH_EVENTS = new Set(["stop", "afterAgentResponse"]);

async function main() {
  try {
    const input = await readStdin();
    if (!input || !FLUSH_EVENTS.has(input.hook_event_name)) return;
    const trace = getTrace(input);
    buildTraceFromTranscript(trace, input);
    await flushLangfuse();
  } catch (error) {
    console.error(`[cursor-langfuse v${HOOK_HANDLER_VERSION}] ${error.message}`);
  }
}

main();
