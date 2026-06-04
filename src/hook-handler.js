#!/usr/bin/env node
/**
 * Cursor -> Langfuse hook entry point.
 *
 * Reads a hook payload from stdin, upserts this turn's trace, routes the event
 * to its handler, prints the (optional) response Cursor expects, and flushes.
 * Any failure is swallowed with a permissive response so hooks never block the
 * agent.
 */

import { readStdin } from "./lib/utils.js";
import { getTrace, flushLangfuse, HOOK_HANDLER_VERSION } from "./lib/langfuse-client.js";
import { routeHookHandler } from "./lib/handlers.js";

async function main() {
  try {
    const input = await readStdin();
    const trace = getTrace(input);
    const response = routeHookHandler(input.hook_event_name, trace, input);
    if (response !== null && response !== undefined) {
      console.log(JSON.stringify(response));
    }
    await flushLangfuse();
  } catch (error) {
    console.error(`[cursor-langfuse v${HOOK_HANDLER_VERSION}] ${error.message}`);
    // Stay permissive so a tracing failure never blocks Cursor.
    console.log(JSON.stringify({ continue: true, permission: "allow" }));
    process.exit(0);
  }
}

main();
