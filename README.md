# cursor-langfuse-hooks

Trace your **Cursor** AI agent chats to **Langfuse** using [Cursor Hooks](https://cursor.com/docs/agent/hooks) — no code changes to your project, just a one-line install.

Every prompt, response, thought, shell command, MCP call, and file edit is captured and organized so you can actually read what the agent did.

## Tracing model

This is the important design decision, and what makes traces readable:

```
Session  =  conversation_id   →  one Cursor chat thread   (new chat = new session)
  Trace  =  generation_id     →  ONE turn (prompt → response)
    └─ observations: thinking · shell · MCP · file edits · token usage
  userId =  workspace folder  →  filter every chat in a project
```

- **One trace per turn**, not one giant trace per chat. The trace's `input` is your prompt, its `output` is the agent's reply, and the tool activity nests underneath.
- **Sessions group a whole chat**, so you can replay a conversation turn by turn.
- **`userId` is the workspace folder name**, so you can filter to a single project across all chats.

> Why it matters: keying the trace by the per-turn `generation_id` (not the chat-wide `conversation_id`) means each event writes only the fields it owns — the prompt sets `input`, the response sets `output` — so nothing clobbers anything and traces stay small and legible.

## Install

From your project root:

```bash
npx github:RheagalFire/cursor-langfuse-hooks init
```

You'll be asked for your Langfuse keys (from your Langfuse project settings). Non-interactive:

```bash
npx github:RheagalFire/cursor-langfuse-hooks init \
  --public-key pk-lf-xxxx \
  --secret-key sk-lf-xxxx \
  --base-url https://cloud.langfuse.com
```

Install for **all** projects (user-level hooks in `~/.cursor`):

```bash
npx github:RheagalFire/cursor-langfuse-hooks init --global
```

Then **reload Cursor** (`Cmd/Ctrl+Shift+P → "Developer: Reload Window"`) and send a chat. Traces show up in Langfuse immediately.

## Options

| Flag | Description |
|------|-------------|
| `--global` | Install to `~/.cursor` (all projects) instead of the current project |
| `--project <path>` | Target project root (default: current directory) |
| `--events <profile>` | `minimal` · `recommended` · `all` (default: `recommended`) |
| `--public-key <key>` | `LANGFUSE_PUBLIC_KEY` |
| `--secret-key <key>` | `LANGFUSE_SECRET_KEY` |
| `--base-url <url>` | Langfuse host (default `https://cloud.langfuse.com`; EU/US clouds supported) |
| `--yes` | Non-interactive; fail if credentials are missing |

### Event profiles

- **minimal** — `beforeSubmitPrompt`, `afterAgentResponse`, `stop` (just prompt → response).
- **recommended** *(default)* — adds thinking, shell, MCP, and file edits. The good balance.
- **all** — everything, including high-frequency `beforeReadFile` / `beforeTabFileRead` (noisy).

## What gets installed

```
<project>/.cursor/
├── hooks.json                 # your existing hooks are preserved; ours are merged in
└── hooks/langfuse/
    ├── hook-handler.js
    ├── lib/{langfuse-client,handlers,utils}.js
    ├── run.sh                 # wrapper: loads .env, resolves node, forwards stdin
    ├── package.json
    ├── .env                   # your keys — gitignored
    └── .gitignore             # ignores .env, node_modules, hook-debug.log
```

`hooks.json` references `run.sh` by **absolute path** — Cursor runs hooks from the workspace root, and a relative path can silently fail to resolve. The wrapper also resolves a `node` binary even under the minimal `PATH` a GUI-launched Cursor provides.

## Troubleshooting

**No traces showing up?**

1. Reload the Cursor window after installing — `hooks.json` only registers on load.
2. Make sure the workspace is **trusted** (project hooks don't run in restricted mode).
3. Check **Cursor Settings → Hooks** for the configured/executed hooks and any errors.
4. Turn on debug logging: set `CURSOR_LANGFUSE_DEBUG=1` in `.cursor/hooks/langfuse/.env`, send a chat, then read `.cursor/hooks/langfuse/hook-debug.log`. Each invocation logs the resolved node path and payload — if the file stays empty, Cursor isn't invoking the hook (config/trust issue, not the script).

Tracing failures never block Cursor — the handler always returns a permissive response.

## Credits

Inspired by [naoufalelh/cursor-langfuse](https://github.com/naoufalelh/cursor-langfuse); reworked around a per-turn trace model and packaged with a one-line installer.

## License

MIT
