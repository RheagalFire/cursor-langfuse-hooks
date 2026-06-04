#!/usr/bin/env node
/**
 * cursor-langfuse-hooks installer.
 *
 *   npx github:RheagalFire/cursor-langfuse-hooks init [options]
 *
 * Installs the hook runtime into a project's .cursor/ (or ~/.cursor with
 * --global), wires hooks.json with absolute paths, writes a gitignored .env,
 * and installs the runtime deps. Existing hooks are preserved.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PKG_ROOT, "src");

// Supported Cursor hook events, by profile.
const EVENT_PROFILES = {
  minimal: ["beforeSubmitPrompt", "afterAgentResponse", "stop"],
  recommended: [
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "afterAgentThought",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "afterFileEdit",
    "afterTabFileEdit",
    "stop",
  ],
  all: [
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "afterAgentThought",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "beforeReadFile",
    "afterFileEdit",
    "beforeTabFileRead",
    "afterTabFileEdit",
    "stop",
  ],
};

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
const log = (m = "") => console.log(m);
const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const die = (m) => {
  console.error(`${C.red}✗ ${m}${C.reset}`);
  process.exit(1);
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function ensureGitignore(dir, entries) {
  const file = path.join(dir, ".gitignore");
  let current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length === 0) return;
  if (current && !current.endsWith("\n")) current += "\n";
  fs.writeFileSync(file, current + missing.join("\n") + "\n");
}

function mergeHooksJson(hooksFile, events, command) {
  let doc = { version: 1, hooks: {} };
  if (fs.existsSync(hooksFile)) {
    try {
      doc = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    } catch {
      die(`Existing ${hooksFile} is not valid JSON — fix or remove it, then re-run.`);
    }
    doc.version = doc.version || 1;
    doc.hooks = doc.hooks || {};
  }
  let added = 0;
  for (const event of events) {
    const list = (doc.hooks[event] = doc.hooks[event] || []);
    if (!list.some((h) => h && h.command === command)) {
      list.push({ command });
      added++;
    }
  }
  fs.writeFileSync(hooksFile, JSON.stringify(doc, null, 2) + "\n");
  return added;
}

async function promptCredentials(args) {
  let pub = args["public-key"] || process.env.LANGFUSE_PUBLIC_KEY;
  let sec = args["secret-key"] || process.env.LANGFUSE_SECRET_KEY;
  let base = args["base-url"] || process.env.LANGFUSE_BASE_URL;

  const interactive = process.stdin.isTTY && !args.yes;
  if (interactive && (!pub || !sec)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    log(`\n${C.bold}Langfuse credentials${C.reset} ${C.dim}(from your project settings page)${C.reset}`);
    if (!pub) pub = (await rl.question("  LANGFUSE_PUBLIC_KEY (pk-lf-...): ")).trim();
    if (!sec) sec = (await rl.question("  LANGFUSE_SECRET_KEY (sk-lf-...): ")).trim();
    if (!base)
      base =
        (await rl.question("  LANGFUSE_BASE_URL [https://cloud.langfuse.com]: ")).trim() ||
        "https://cloud.langfuse.com";
    rl.close();
  }
  base = base || "https://cloud.langfuse.com";
  if (!pub || !sec) {
    die(
      "Missing credentials. Pass --public-key / --secret-key (and optional --base-url),\n" +
        "  or set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY in the environment, or run interactively."
    );
  }
  return { pub, sec, base };
}

function npmInstall(dir) {
  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

async function init(args) {
  const profile = (args.events || "recommended").toLowerCase();
  const events = EVENT_PROFILES[profile];
  if (!events) die(`Unknown --events "${profile}". Use: minimal | recommended | all.`);

  const targetRoot = args.global
    ? os.homedir()
    : path.resolve(args.project || process.cwd());
  const cursorDir = path.join(targetRoot, ".cursor");
  const installDir = path.join(cursorDir, "hooks", "langfuse");
  const hooksFile = path.join(cursorDir, "hooks.json");
  const runScript = path.join(installDir, "run.sh");

  log(`\n${C.cyan}${C.bold}cursor-langfuse-hooks${C.reset} installer\n`);
  log(`  scope     : ${args.global ? "global (~/.cursor)" : "project"}`);
  log(`  target    : ${cursorDir}`);
  log(`  events    : ${profile} (${events.length})\n`);

  const { pub, sec, base } = await promptCredentials(args);

  // 1. Copy runtime files.
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(SRC, "hook-handler.js"), path.join(installDir, "hook-handler.js"));
  copyDir(path.join(SRC, "lib"), path.join(installDir, "lib"));
  fs.copyFileSync(path.join(SRC, "run.sh"), runScript);
  fs.chmodSync(runScript, 0o755);
  fs.copyFileSync(path.join(SRC, "runtime-package.json"), path.join(installDir, "package.json"));
  ok("Copied hook runtime");

  // 2. Credentials (gitignored).
  fs.writeFileSync(
    path.join(installDir, ".env"),
    `LANGFUSE_PUBLIC_KEY=${pub}\nLANGFUSE_SECRET_KEY=${sec}\nLANGFUSE_BASE_URL=${base}\n`,
    { mode: 0o600 }
  );
  ok("Wrote .env");

  // 3. Keep secrets/deps/logs out of git.
  ensureGitignore(installDir, [".env", "node_modules/", "hook-debug.log"]);

  // 4. Install runtime deps.
  log(`\n${C.dim}Installing runtime deps (langfuse, dotenv)…${C.reset}`);
  if (npmInstall(installDir)) ok("Installed dependencies");
  else warn(`npm install failed — run it yourself:  (cd "${installDir}" && npm install)`);

  // 5. Wire hooks.json (absolute path; preserves existing hooks).
  const added = mergeHooksJson(hooksFile, events, runScript);
  ok(`Wired hooks.json (${added} event${added === 1 ? "" : "s"} added, existing hooks preserved)`);

  // Done.
  log(`\n${C.green}${C.bold}Done.${C.reset}`);
  log(`\n${C.bold}Next:${C.reset}`);
  log(`  1. Reload Cursor:  Cmd/Ctrl+Shift+P → "Developer: Reload Window"`);
  log(`  2. Send any chat in this workspace.`);
  log(`  3. Open Langfuse → traces appear under session = your chat id.\n`);
  log(`${C.dim}Tracing model: session = chat, trace = turn, userId = workspace folder.${C.reset}`);
  log(`${C.dim}Debug a silent failure: set CURSOR_LANGFUSE_DEBUG=1 in ${path.join(installDir, ".env")} → writes hook-debug.log.${C.reset}\n`);
}

function help() {
  log(`
${C.bold}cursor-langfuse-hooks${C.reset} — trace Cursor agent chats to Langfuse

${C.bold}Usage${C.reset}
  npx github:RheagalFire/cursor-langfuse-hooks init [options]

${C.bold}Options${C.reset}
  --global             Install to ~/.cursor (all projects) instead of this project
  --project <path>     Target project root (default: current directory)
  --events <profile>   minimal | recommended | all   (default: recommended)
  --public-key <key>   LANGFUSE_PUBLIC_KEY (pk-lf-...)
  --secret-key <key>   LANGFUSE_SECRET_KEY (sk-lf-...)
  --base-url <url>     Langfuse host (default: https://cloud.langfuse.com)
  --yes                Non-interactive; fail if credentials are missing
  -h, --help           Show this help

${C.bold}Examples${C.reset}
  npx github:RheagalFire/cursor-langfuse-hooks init
  npx github:RheagalFire/cursor-langfuse-hooks init --global --events all \\
      --public-key pk-lf-xxx --secret-key sk-lf-xxx --base-url https://us.cloud.langfuse.com
`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (args.help || args.h || cmd === "help") help();
else if (cmd === "init" || cmd === undefined) await init(args);
else die(`Unknown command "${cmd}". Try --help.`);
