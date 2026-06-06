/**
 * Langfuse client + trace identity — ZERO dependencies.
 *
 * Posts directly to Langfuse's public ingestion API over Node's built-in https,
 * so the handler can be dropped into a Cursor plugin with no node_modules.
 *
 * Trace model:
 *   trace    = one TURN (`<conversation_id>-turn<N>`)  -> a single prompt→response
 *   session  = conversation_id   -> all of a chat's turns share a session
 *   userId   = signed-in email   -> per-person usage tracking (workspace -> tag)
 *   env      = local-dev         -> separates Cursor sessions from prod traffic
 *
 * Content is built from Cursor's transcript on the reliable turn-end events, and
 * turns are split by user-message boundaries (deterministic), so per-turn traces
 * are stable and idempotent. See handlers.js (buildLatestTurnTrace).
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

export const HOOK_HANDLER_VERSION = "3.6.0";
const TRACE_NAME = process.env.CURSOR_LANGFUSE_TRACE_NAME || "cursor-agent";
const ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT || "local-dev";
const BASE_URL = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");

// In-memory ingestion batch for this process.
const batch = [];
// Monotonically increasing timestamps (1ms apart) in EMISSION order. We emit
// observations in logical order (prompt → responses/tools → …), so this keeps
// them ordered in Langfuse — otherwise every observation gets the same flush
// time and the timeline renders in arbitrary/ reversed order.
let _seq = 0;
const _base = Date.now();
const stamp = () => new Date(_base + _seq++).toISOString();
function emit(type, body) {
  batch.push({ id: randomUUID(), type, timestamp: stamp(), body: { environment: ENVIRONMENT, ...body } });
}

// The chat (conversation) id — used as the Langfuse sessionId so all of a
// chat's turn-traces group together.
export function chatTraceId(input) {
  return input.conversation_id || input.session_id || input.generation_id || `cursor-${Date.now()}`;
}

/**
 * A handle whose methods mirror the Langfuse SDK's trace/observation API.
 * Pass `overrideId` for a per-turn trace id (e.g. `<conv>-turn<N>`); sessionId
 * stays the conversation id so all turns of a chat share one session.
 */
export function getTrace(input, overrideId) {
  const traceId = overrideId || chatTraceId(input);
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
