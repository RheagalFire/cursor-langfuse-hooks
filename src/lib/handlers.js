/**
 * Hook handlers. Each turn is one trace; these add observations to it and only
 * the prompt/response handlers write the trace's top-level input/output.
 */

import {
  calculateEditStats,
  getFileExtension,
  fileName,
  formatDuration,
  determineLevel,
  baseTags,
} from "./utils.js";
import { addCompletionScores, turnId } from "./langfuse-client.js";

const llmId = (input) => `${turnId(input)}-llm`;

const MAX_OUTPUT = 20000; // cap large tool outputs (e.g. full file reads) so traces stay sane
function clamp(v) {
  if (typeof v !== "string") return v;
  return v.length > MAX_OUTPUT ? v.slice(0, MAX_OUTPUT) + `\n…[truncated ${v.length - MAX_OUTPUT} chars]` : v;
}

// A readable span title per tool type, from the generic postToolUse payload.
function toolLabel(input) {
  const name = input.tool_name || "tool";
  const ti = input.tool_input || {};
  const f = () => fileName(ti.file_path || ti.path || ti.target_file);
  switch (name) {
    case "Read": return `Read: ${f()}`;
    case "Write":
    case "Edit":
    case "MultiEdit": return `Edit: ${f()}`;
    case "Delete": return `Delete: ${f()}`;
    case "Shell":
    case "Terminal": return `Shell: ${String(ti.command || "").slice(0, 60)}`;
    case "Grep":
    case "Search":
    case "Codebase": return `${name}: ${String(ti.pattern || ti.query || "").slice(0, 60)}`;
    case "List":
    case "LS": return `List: ${ti.path || ti.directory || ""}`;
    case "Task": return `Task: ${String(ti.description || ti.prompt || "").slice(0, 50)}`;
    default: return `Tool: ${name}`;
  }
}

export function handleBeforeSubmitPrompt(trace, input) {
  // Owns the trace input (the prompt). The trace name is a constant set in getTrace.
  trace.update({
    input: input.prompt,
    metadata: { attachment_count: input.attachments?.length || 0 },
  });
  return { continue: true };
}

export function handleAfterAgentResponse(trace, input) {
  // Owns the trace output, and opens the LLM generation for this turn.
  trace.update({ output: input.text });
  trace.generation({
    id: llmId(input),
    name: "LLM",
    model: input.model,
    output: input.text,
    metadata: { response_length: input.text?.length || 0 },
  });
  return null;
}

// Generic capture for ALL agent tool calls (Read, Write, Shell, Grep, Search,
// List, Delete, Task, MCP, …). One span per completed tool call with its
// input + output + duration. Use this instead of the specialized hooks to get
// full coverage without double-logging.
export function handlePostToolUse(trace, input) {
  let output = input.tool_output;
  if (typeof output === "string") {
    try { output = JSON.parse(output); } catch { /* keep as string */ }
  }
  trace
    .span({
      name: toolLabel(input),
      input: input.tool_input,
      output: typeof output === "string" ? clamp(output) : output,
      metadata: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        duration_ms: input.duration,
        duration: formatDuration(input.duration),
        cwd: input.cwd,
      },
    })
    .end();
  return null;
}

export function handlePostToolUseFailure(trace, input) {
  trace
    .span({
      name: `Failed ${toolLabel(input)}`,
      level: input.failure_type === "permission_denied" ? "WARNING" : "ERROR",
      input: input.tool_input,
      output: clamp(input.error_message),
      metadata: {
        tool_name: input.tool_name,
        failure_type: input.failure_type,
        is_interrupt: input.is_interrupt,
        duration_ms: input.duration,
      },
    })
    .end();
  return null;
}

export function handleAfterAgentThought(trace, input) {
  trace
    .span({
      name: "Thinking",
      output: input.text,
      metadata: {
        duration_ms: input.duration_ms,
        duration: formatDuration(input.duration_ms),
        length: input.text?.length || 0,
      },
    })
    .end();
  return null;
}

export function handleBeforeShellExecution(trace, input) {
  trace
    .span({
      name: `Shell: ${(input.command || "command").slice(0, 60)}`,
      input: { command: input.command, cwd: input.cwd },
    })
    .end();
  return { permission: "allow" };
}

export function handleAfterShellExecution(trace, input) {
  const out = (input.output || "").toLowerCase();
  const maybeFailed = out.includes("error") || out.includes("failed") || out.includes("not found");
  trace
    .span({
      name: `Shell result: ${(input.command || "command").slice(0, 50)}`,
      input: { command: input.command },
      output: input.output,
      level: maybeFailed ? "WARNING" : "DEFAULT",
      metadata: {
        duration_ms: input.duration,
        duration: formatDuration(input.duration),
        maybe_failed: maybeFailed,
      },
    })
    .end();
  return null;
}

export function handleBeforeMCPExecution(trace, input) {
  trace
    .span({
      name: `MCP: ${input.tool_name || "tool"}`,
      input: {
        tool_name: input.tool_name,
        tool_input: input.tool_input,
        server_url: input.url,
        server_command: input.command,
      },
    })
    .end();
  return { permission: "allow" };
}

export function handleAfterMCPExecution(trace, input) {
  trace
    .span({
      name: `MCP result: ${input.tool_name || "tool"}`,
      input: { tool_name: input.tool_name },
      output: input.result_json,
      metadata: { duration_ms: input.duration, duration: formatDuration(input.duration) },
    })
    .end();
  return null;
}

export function handleBeforeReadFile(trace, input) {
  trace
    .span({
      name: `Read: ${fileName(input.file_path)}`,
      input: { file_path: input.file_path, extension: getFileExtension(input.file_path) },
    })
    .end();
  return { permission: "allow" };
}

export function handleAfterFileEdit(trace, input) {
  const stats = calculateEditStats(input.edits);
  trace
    .span({
      name: `Edit: ${fileName(input.file_path)}`,
      input: { file_path: input.file_path, extension: getFileExtension(input.file_path) },
      output: stats,
      metadata: stats,
    })
    .end();
  return null;
}

export function handleStop(trace, input) {
  trace.event({
    name: "Agent stopped",
    level: determineLevel(input.status),
    metadata: { status: input.status, loop_count: input.loop_count },
  });

  // Attach token usage to the turn's LLM generation (merged by id).
  if (input.input_tokens != null || input.output_tokens != null) {
    trace.generation({
      id: llmId(input),
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

  addCompletionScores(trace, input);
  trace.update({ tags: [...baseTags(input), `status-${input.status}`] });
  return {};
}

export function handleBeforeTabFileRead(trace, input) {
  trace
    .span({
      name: `Tab read: ${fileName(input.file_path)}`,
      input: { file_path: input.file_path, extension: getFileExtension(input.file_path) },
      metadata: { source: "tab" },
    })
    .end();
  return { permission: "allow" };
}

export function handleAfterTabFileEdit(trace, input) {
  const stats = calculateEditStats(input.edits);
  trace
    .span({
      name: `Tab edit: ${fileName(input.file_path)}`,
      input: { file_path: input.file_path, extension: getFileExtension(input.file_path) },
      output: stats,
      metadata: { source: "tab", ...stats },
    })
    .end();
  return null;
}

// Lifecycle events (session/workspace/subagent/compact) — recorded as a simple
// event on the turn's trace. Used by the `all` profile.
export function handleLifecycle(trace, input) {
  trace.event({
    name: input.hook_event_name || "lifecycle",
    metadata: {
      status: input.status,
      reason: input.reason,
      subagent_id: input.subagent_id,
    },
  });
  return null;
}

const HANDLERS = {
  beforeSubmitPrompt: handleBeforeSubmitPrompt,
  sessionStart: handleLifecycle,
  sessionEnd: handleLifecycle,
  workspaceOpen: handleLifecycle,
  preCompact: handleLifecycle,
  subagentStart: handleLifecycle,
  subagentStop: handleLifecycle,
  afterAgentResponse: handleAfterAgentResponse,
  afterAgentThought: handleAfterAgentThought,
  postToolUse: handlePostToolUse,
  postToolUseFailure: handlePostToolUseFailure,
  beforeShellExecution: handleBeforeShellExecution,
  afterShellExecution: handleAfterShellExecution,
  beforeMCPExecution: handleBeforeMCPExecution,
  afterMCPExecution: handleAfterMCPExecution,
  beforeReadFile: handleBeforeReadFile,
  afterFileEdit: handleAfterFileEdit,
  stop: handleStop,
  beforeTabFileRead: handleBeforeTabFileRead,
  afterTabFileEdit: handleAfterTabFileEdit,
};

export function routeHookHandler(hookName, trace, input) {
  const handler = HANDLERS[hookName];
  if (!handler) {
    console.error(`[cursor-langfuse] Unknown hook: ${hookName}`);
    return null;
  }
  return handler(trace, input);
}
