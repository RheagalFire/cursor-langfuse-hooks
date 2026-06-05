/**
 * Parse Cursor's per-conversation transcript (the authoritative record).
 *
 * Path: ~/.cursor/projects/<enc-workspace>/agent-transcripts/<conv>/<conv>.jsonl
 * exposed to hooks via CURSOR_TRANSCRIPT_PATH (and sometimes payload.transcript_path).
 *
 * Each line: { role: "user"|"assistant", message: { content: [block, ...] } }
 *   block = { type:"text", text } | { type:"tool_use", name, input } | { type:"tool_result", ... }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
