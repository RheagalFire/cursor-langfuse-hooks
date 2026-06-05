/**
 * Parse Cursor's per-conversation transcript (the authoritative record).
 *
 * Path: ~/.cursor/projects/<enc-workspace>/agent-transcripts/<conv>/<conv>.jsonl
 * exposed to hooks via CURSOR_TRANSCRIPT_PATH (and sometimes payload.transcript_path).
 *
 * Each line: { role: "user"|"assistant", message: { content: [block, ...] } }
 *   block = { type:"text", text } | { type:"tool_use", name, input } | { type:"tool_result", ... }
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/** Read + parse the JSONL transcript into ordered messages. Returns [] on any error. */
export function parseTranscript(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const msgs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const content = o && o.message && o.message.content;
      if (Array.isArray(content)) msgs.push({ role: o.role, blocks: content });
      else if (typeof content === "string") msgs.push({ role: o.role, blocks: [{ type: "text", text: content }] });
    } catch {
      /* skip a malformed line */
    }
  }
  return msgs;
}

/** Strip Cursor's <user_query> wrapper from a user prompt. */
export function cleanPrompt(text) {
  return String(text || "")
    .replace(/<\/?user_query>/g, "")
    .trim();
}

/** First user-message text of a (sub)transcript, cleaned. */
function firstUserText(msgs) {
  const u = msgs.find((m) => m.role === "user");
  if (!u) return "";
  return cleanPrompt(u.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
}

/**
 * Subagents (the `Task` tool) write their own transcript at
 * `<conv>/subagents/<id>.jsonl`. There's no id on the Task block, but the
 * subagent's first user message IS the Task's `input.prompt`, so we match by
 * prompt text. Returns the parsed subagent messages, or [] if not found.
 */
export function findSubagentMessages(mainTranscriptPath, taskPrompt) {
  const want = cleanPrompt(taskPrompt);
  if (!want) return [];
  let files;
  try {
    const dir = join(dirname(mainTranscriptPath), "subagents");
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
  const key = want.slice(0, 120);
  for (const f of files) {
    const msgs = parseTranscript(f);
    const head = firstUserText(msgs).slice(0, 120);
    if (head && (head === key || head.startsWith(key.slice(0, 80)) || key.startsWith(head.slice(0, 80)))) {
      return msgs;
    }
  }
  return [];
}

/**
 * Resolve the transcript path: prefer the env var Cursor sets, then the payload
 * field, then derive it from the workspace + conversation_id.
 */
export function resolveTranscriptPath(input) {
  if (process.env.CURSOR_TRANSCRIPT_PATH) return process.env.CURSOR_TRANSCRIPT_PATH;
  if (input && input.transcript_path) return input.transcript_path;
  const ws = input && Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null;
  const conv = input && input.conversation_id;
  if (!ws || !conv) return null;
  const enc = ws.split("/").filter(Boolean).join("-");
  const home = process.env.HOME || "";
  return resolve(home, ".cursor/projects", enc, "agent-transcripts", conv, `${conv}.jsonl`);
}
