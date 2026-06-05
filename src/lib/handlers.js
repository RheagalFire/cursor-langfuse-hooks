/**
 * Build a Langfuse trace for the LATEST turn of a Cursor chat, from its transcript.
 *
 * Triggered on `stop` / `afterAgentResponse` (reliable turn-end events). Reading
 * the transcript — rather than assembling from per-event hooks, which Cursor
 * fires inconsistently — is what makes tracing reliable and complete.
 *
 * Model: trace = one TURN (`<conversation_id>-turn<N>`), sessionId = conversation_id,
 * so all of a chat's turns share a session (matches the brainforge-assistant
 * convention). Turns are split by user-message boundaries in the transcript,
 * which is deterministic and stable. Observation ids are deterministic, so a
 * re-flush of the same turn upserts (no duplicates). One batched POST per flush.
 */

import { addCompletionScores, getTrace, chatTraceId } from "./langfuse-client.js";
import { fileName } from "./utils.js";
import { parseTranscript, cleanPrompt, resolveTranscriptPath } from "./transcript.js";

const MAX = 20000;
const clamp = (v) =>
  typeof v === "string" && v.length > MAX ? v.slice(0, MAX) + `\n…[truncated ${v.length - MAX} chars]` : v;

function toolLabel(name, input = {}) {
  const f = () => fileName(input.path || input.file_path || input.target_file);
  switch (name) {
    case "Read": return `Read: ${f()}`;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "search_replace": return `Edit: ${f()}`;
    case "Delete":
    case "delete_file": return `Delete: ${f()}`;
    case "Shell":
    case "Terminal":
    case "run_terminal_cmd": return `Shell: ${String(input.command || "").slice(0, 60)}`;
    case "Grep":
    case "grep":
    case "grep_search": return `Grep: ${String(input.pattern || input.query || "").slice(0, 60)}`;
    case "Search":
    case "codebase_search": return `Search: ${String(input.query || "").slice(0, 60)}`;
    case "list_dir":
    case "LS": return `List: ${input.path || input.target_directory || ""}`;
    case "Task": return `Task: ${String(input.description || input.prompt || "").slice(0, 50)}`;
    default: return `Tool: ${name || "tool"}`;
  }
}

/**
 * Reconstruct the whole conversation trace from the transcript.
 * `trace` is the handle from getTrace(input); `input` is the stop/response payload.
 */
export function buildLatestTurnTrace(input) {
  const path = resolveTranscriptPath(input);
  if (!path) return;
  const msgs = parseTranscript(path);
  if (!msgs.length) return;

  // Turns are delimited by user messages. The latest turn = the last user
  // message plus the assistant messages that follow it.
  const userIdxs = [];
  msgs.forEach((m, i) => { if (m.role === "user") userIdxs.push(i); });
  if (!userIdxs.length) return;

  const turnNum = userIdxs.length; // 1-based, stable across flushes (append-only)
  const turnMsgs = msgs.slice(userIdxs[userIdxs.length - 1]);
  const traceId = `${chatTraceId(input)}-turn${turnNum}`;
  const trace = getTrace(input, traceId); // sessionId = conversation_id

  let prompt = null;
  let lastResponse = null;
  let lastLlmId = null;
  let llmN = 0;
  let toolN = 0;

  for (const m of turnMsgs) {
    const text = m.blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (m.role === "user") {
      prompt = cleanPrompt(text);
      if (prompt) trace.event({ id: `${traceId}-user`, name: "User Prompt", input: clamp(prompt) });
    } else if (m.role === "assistant") {
      if (text) {
        lastLlmId = `${traceId}-llm${llmN++}`;
        trace.generation({ id: lastLlmId, name: "LLM", model: input.model, output: clamp(text) });
        lastResponse = text;
      }
      for (const b of m.blocks.filter((b) => b.type === "tool_use")) {
        trace
          .span({ id: `${traceId}-tool${toolN++}`, name: toolLabel(b.name, b.input), input: b.input })
          .end();
      }
    }
  }

  trace.update({ input: prompt ?? undefined, output: lastResponse ?? undefined });

  // Token usage comes from the stop payload (the transcript has content, not counts).
  if (lastLlmId && (input.input_tokens != null || input.output_tokens != null)) {
    trace.generation({
      id: lastLlmId,
      name: "LLM",
      model: input.model,
      usage: {
        input: input.input_tokens,
        output: input.output_tokens,
        total: (input.input_tokens || 0) + (input.output_tokens || 0),
      },
      metadata: {
        cache_read_tokens: input.cache_read_tokens,
        cache_write_tokens: input.cache_write_tokens,
      },
    });
  }

  if (input.status) addCompletionScores(trace, input);
}
