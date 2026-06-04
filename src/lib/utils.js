/**
 * Utility functions for the Cursor -> Langfuse hooks.
 */

/** Read and JSON-parse the hook payload Cursor sends on stdin. */
export async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Failed to parse JSON from stdin: ${e.message}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

/** A short, human-readable trace title derived from the user's prompt. */
export function traceTitle(prompt, model) {
  if (!prompt) return `Cursor ${model || "Agent"}`;
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

/** Folder name of the first workspace root, used as Langfuse userId for filtering. */
export function deriveWorkspaceName(workspaceRoots) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) return undefined;
  const root = workspaceRoots[0];
  return root.split("/").filter(Boolean).pop() || root;
}

/** Normalize a model string into a tag-friendly token. */
function modelTag(model) {
  if (!model) return null;
  return model
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
}

/**
 * Stable, idempotent tag set for a trace. Computed identically on every hook
 * event so cross-process upserts never flip the tags around.
 */
export function baseTags(input) {
  const tags = new Set(["cursor"]);
  const hook = input.hook_event_name || "";
  tags.add(hook.includes("Tab") || input.composer_mode === "tab" ? "tab" : "agent");
  const mt = modelTag(input.model);
  if (mt) tags.add(mt);
  if (input.composer_mode) tags.add(`mode-${input.composer_mode}`);
  return Array.from(tags);
}

export function getFileExtension(filePath) {
  if (!filePath) return "unknown";
  const parts = filePath.split(".");
  return parts.length < 2 ? "unknown" : parts.pop().toLowerCase();
}

export function fileName(filePath) {
  return filePath?.split("/").pop() || "file";
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

export function determineLevel(status) {
  switch (status) {
    case "error":
      return "ERROR";
    case "aborted":
      return "WARNING";
    default:
      return "DEFAULT";
  }
}

export function calculateEditStats(edits) {
  if (!Array.isArray(edits)) return { editCount: 0, linesAdded: 0, linesRemoved: 0, netChange: 0 };
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const edit of edits) {
    const oldLines = (edit.old_string || "").split("\n").length;
    const newLines = (edit.new_string || "").split("\n").length;
    if (newLines > oldLines) linesAdded += newLines - oldLines;
    else if (oldLines > newLines) linesRemoved += oldLines - newLines;
  }
  return { editCount: edits.length, linesAdded, linesRemoved, netChange: linesAdded - linesRemoved };
}
