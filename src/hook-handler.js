#!/usr/bin/env node
/**
 * Cursor -> Langfuse hook entry point.
 *
 * Two modes:
 *   (default) read one hook payload from stdin and post it — kept for direct use.
 *   --flush <dir>  process every queued *.json payload in <dir> (oldest first),
 *                  post them to Langfuse in ONE batch, then delete them.
 *
 * run.sh enqueues each hook payload as a file and calls --flush at turn
 * boundaries, so frequent "before" hooks never block on network I/O.
 *
 * Failures are swallowed — tracing must never break Cursor.
 */

import { readdirSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { readStdin } from "./lib/utils.js";
import { getTrace, flushLangfuse, HOOK_HANDLER_VERSION } from "./lib/langfuse-client.js";
import { routeHookHandler } from "./lib/handlers.js";

function process_(input) {
  if (!input || !input.hook_event_name) return;
  const trace = getTrace(input);
  routeHookHandler(input.hook_event_name, trace, input);
}

async function flushQueue(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return; // no queue dir yet
  }
  // Oldest first, so observations keep their real order.
  files = files
    .map((f) => ({ f, m: safeMtime(join(dir, f)) }))
    .sort((a, b) => a.m - b.m)
    .map((x) => x.f);

  for (const f of files) {
    try {
      process_(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      /* skip a corrupt/partial file */
    }
  }
  await flushLangfuse();
  for (const f of files) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* already gone */
    }
  }
}

function safeMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

async function main() {
  try {
    if (process.argv[2] === "--flush") {
      await flushQueue(process.argv[3]);
      return;
    }
    const input = await readStdin();
    process_(input);
    await flushLangfuse();
  } catch (error) {
    console.error(`[cursor-langfuse v${HOOK_HANDLER_VERSION}] ${error.message}`);
  }
}

main();
