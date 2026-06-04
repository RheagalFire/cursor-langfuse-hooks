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

const HANDLERS = {
  beforeSubmitPrompt: handleBeforeSubmitPrompt,
  afterAgentResponse: handleAfterAgentResponse,
  afterAgentThought: handleAfterAgentThought,
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
