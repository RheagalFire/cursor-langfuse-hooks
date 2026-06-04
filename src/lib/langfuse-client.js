/**
 * Langfuse client + trace identity.
 *
 * Trace model (the important part):
 *   session  = conversation_id   -> one Cursor chat thread (new chat = new session)
 *   trace    = generation_id     -> ONE turn (prompt -> response)
 *   userId   = workspace folder  -> filter all chats in a project
 *
 * Every hook event for the same turn upserts the SAME trace id, so observations
 * accumulate while top-level fields are written only by the event that owns them
 * (prompt sets input, response sets output). No clobbering, no giant traces.
 */

import { Langfuse } from "langfuse";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { baseTags, deriveWorkspaceName } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Credentials usually arrive already-exported by run.sh; dotenv is a fallback
// and never overrides an existing process.env value.
config({ path: resolve(__dirname, "..", ".env") });
if (!process.env.LANGFUSE_SECRET_KEY) {
  config({ path: resolve(process.cwd(), ".env") });
}

export const HOOK_HANDLER_VERSION = "2.0.0";

let client = null;

export function getLangfuseClient() {
  if (!client) {
    client = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
      release: HOOK_HANDLER_VERSION,
    });
  }
  return client;
}

/** Stable per-turn trace id. Falls back to the conversation if no turn id. */
export function turnId(input) {
  return input.generation_id || input.conversation_id || `cursor-${Date.now()}`;
}

/**
 * Upsert the turn's trace with only stable, idempotent fields. Safe to call on
 * every event — it never touches name/input/output (those belong to the prompt
 * and response handlers).
 */
export function getTrace(input) {
  const lf = getLangfuseClient();
  const workspace = deriveWorkspaceName(input.workspace_roots);
  return lf.trace({
    id: turnId(input),
    sessionId: input.conversation_id || input.session_id || undefined,
    userId: workspace,
    release: HOOK_HANDLER_VERSION,
    version: input.cursor_version,
    tags: baseTags(input),
    metadata: {
      conversation_id: input.conversation_id,
      generation_id: input.generation_id,
      workspace,
      model: input.model,
      composer_mode: input.composer_mode,
      cursor_version: input.cursor_version,
    },
  });
}

export function addCompletionScores(trace, input) {
  const map = {
    completed: [1, "Agent completed successfully"],
    aborted: [0.5, "Agent was aborted by user"],
    error: [0, "Agent encountered an error"],
  };
  const [value, comment] = map[input.status] || [0.5, `Unknown status: ${input.status}`];
  trace.score({ name: "completion_status", value, comment, dataType: "NUMERIC" });

  if (typeof input.loop_count === "number") {
    trace.score({
      name: "efficiency",
      value: Math.max(0, 1 - input.loop_count / 10),
      comment: `Completed in ${input.loop_count} loop(s)`,
      dataType: "NUMERIC",
    });
  }
}

export async function flushLangfuse() {
  await getLangfuseClient().flushAsync();
}
