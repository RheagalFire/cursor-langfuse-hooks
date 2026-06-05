/**
 * Langfuse client + trace identity — ZERO dependencies.
 *
 * Posts directly to Langfuse's public ingestion API over Node's built-in https,
 * so the handler can be dropped into a Cursor plugin with no node_modules.
 *
 * Trace model:
 *   trace    = conversation_id   -> one Cursor chat (all turns + tool calls)
 *   session  = conversation_id   -> new chat = new session
 *   userId   = signed-in email   -> per-person usage tracking (workspace -> tag)
 *   env      = local-dev         -> separates Cursor sessions from prod traffic
 *
 * Note: Cursor assigns a fresh generation_id per LLM step, so a single user turn
 * spans multiple generation_ids. We therefore key the TRACE by conversation_id
 * (stable per chat) and use generation_id only to group per-step observations.
 *
 * Same exported surface as before (getTrace/turnId/addCompletionScores/
 * flushLangfuse) so handlers.js is unchanged.
 */

import https from "node:https";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { baseTags, deriveWorkspaceName } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dotenv). run.sh usually exports these already; this is
// a fallback and never overrides an existing process.env value.
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || m[1] in process.env) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {
    /* no .env — rely on real env */
  }
}
loadEnv(resolve(__dirname, "..", ".env"));
if (!process.env.LANGFUSE_SECRET_KEY) loadEnv(resolve(process.cwd(), ".env"));

export const HOOK_HANDLER_VERSION = "3.2.0";
const TRACE_NAME = process.env.CURSOR_LANGFUSE_TRACE_NAME || "cursor-agent";
const ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT || "local-dev";
const BASE_URL = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");

// In-memory ingestion batch for this process.
const batch = [];
const stamp = () => new Date().toISOString();
function emit(type, body) {
  batch.push({ id: randomUUID(), type, timestamp: stamp(), body: { environment: ENVIRONMENT, ...body } });
}

// Trace id = the CHAT (conversation). Cursor assigns a new generation_id per
// LLM step, so one user turn can span several generation_ids — keying the trace
// by generation_id splits a turn into incomplete traces. conversation_id is the
// stable per-chat id, so every prompt/response/tool of the chat lands in one
// trace. (Per-step grouping is still done via generation_id on the observations.)
export function chatTraceId(input) {
  return input.conversation_id || input.session_id || input.generation_id || `cursor-${Date.now()}`;
}

/** A handle whose methods mirror the Langfuse SDK's trace/observation API. */
export function getTrace(input) {
  const traceId = chatTraceId(input);
  const workspace = deriveWorkspaceName(input.workspace_roots);
  const userId =
    input.user_email ||
    process.env.CURSOR_USER_EMAIL ||
    process.env.CURSOR_LANGFUSE_USER_ID ||
    undefined;

  emit("trace-create", {
    id: traceId,
    name: TRACE_NAME,
    sessionId: input.conversation_id || input.session_id || undefined,
    userId,
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

  const observation = (createType, updateType) => (body = {}) => {
    const id = body.id || randomUUID();
    emit(createType, { id, traceId, startTime: stamp(), ...body });
    return { id, end: (extra = {}) => emit(updateType, { id, traceId, endTime: stamp(), ...extra }) };
  };

  return {
    id: traceId,
    update: (body = {}) => emit("trace-create", { id: traceId, ...body }),
    generation: observation("generation-create", "generation-update"),
    span: observation("span-create", "span-update"),
    event: (body = {}) => {
      const id = body.id || randomUUID();
      emit("event-create", { id, traceId, startTime: stamp(), ...body });
      return { id, end: () => {} };
    },
    score: (body = {}) => emit("score-create", { id: randomUUID(), traceId, ...body }),
  };
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

/** POST the batch to Langfuse's ingestion API. Fails open (never throws). */
export async function flushLangfuse() {
  if (!batch.length) return;
  const events = batch.splice(0, batch.length);
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!pk || !sk) return;
  const payload = JSON.stringify({ batch: events });
  const url = new URL(BASE_URL + "/api/public/ingestion");
  const lib = url.protocol === "http:" ? http : https;
  const auth = Buffer.from(`${pk}:${sk}`).toString("base64");
  await new Promise((done) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", done);
        res.on("error", done);
      }
    );
    req.on("error", done); // fail open — tracing must never block Cursor
    req.setTimeout(8000, () => { req.destroy(); done(); });
    req.write(payload);
    req.end();
  });
}
