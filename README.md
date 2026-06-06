# cursor-langfuse-hooks

Trace your **Cursor** AI agent chats to **Langfuse** using [Cursor Hooks](https://cursor.com/docs/agent/hooks) — no code changes to your project, one-line install, **dependency-free** (no `node_modules`).

It reconstructs each turn from Cursor's own conversation **transcript**, so traces are complete and reliable regardless of which fine-grained hooks Cursor happens to fire.

## Trace model

```
session  =  conversation_id        →  one Cursor chat (new chat = new session)
  trace  =  <conversation_id>-turn<N>   →  ONE turn (a prompt → final response)
    ├─ User Prompt
    ├─ LLM (assistant response text)
    ├─ Read / Grep / Shell / … (tool calls, from the transcript)
    └─ Task → (subagent's own Read/Grep/… nested underneath)
  userId =  signed-in email         →  per-person usage
  env    =  local-dev               →  separates Cursor sessions from prod
  total duration  =  prompt-submit → stop  (real request latency)
```

- **One trace per turn**, all turns of a chat grouped under one **session** (the same convention as a typical `*-assistant` Langfuse setup).
- **Subagents** (`Task`) get their own tool calls nested under the Task span.
- **Real total duration** per turn (Cursor exposes none, so we measure prompt-submit → stop). Per-tool durations are **not** shown (Cursor has no per-tool timing — we don't fabricate it).
- **Idempotent**: observation ids are deterministic, so re-flushing a turn upserts instead of duplicating.

## How it works

Cursor writes a transcript per chat at `~/.cursor/.../agent-transcripts/<conv>/<conv>.jsonl` (and exposes it as `CURSOR_TRANSCRIPT_PATH`). The plugin subscribes to just three hooks:

- `beforeSubmitPrompt` — stamps the turn **start** (for total duration); returns instantly.
- `afterAgentResponse` / `stop` — on turn end, parse the transcript and (re)build that turn's trace in **one** batched POST to Langfuse's ingestion API.

No per-tool hooks (`beforeReadFile`, `postToolUse`, …) are used — Cursor fires them inconsistently, and the transcript already contains everything.

## Install

From your project root:

```bash
npx github:RheagalFire/cursor-langfuse-hooks init
```

You'll be asked for your Langfuse keys. Non-interactive / global:

```bash
npx github:RheagalFire/cursor-langfuse-hooks init --global --yes \
  --public-key pk-lf-xxxx --secret-key sk-lf-xxxx \
  --base-url https://us.cloud.langfuse.com
```

Then **reload Cursor** (`Cmd/Ctrl+Shift+P → "Developer: Reload Window"`) and send a chat.

## Options

| Flag | Description |
|------|-------------|
| `--global` | Install to `~/.cursor` (all projects) instead of the current project |
| `--project <path>` | Target project root (default: cwd) |
| `--events <profile>` | `minimal` (`beforeSubmitPrompt`,`stop`) · `recommended`/`all` (+`afterAgentResponse`). Default `recommended` |
| `--public-key` / `--secret-key` / `--base-url` | Langfuse credentials / host |
| `--trace-name <name>` | Constant trace name (default `cursor-agent`) |
| `--environment <env>` | Langfuse environment tag (default `local-dev`) |
| `--yes` | Non-interactive |

### Environment variables (`.cursor/hooks/langfuse/.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Credentials (required) |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Langfuse host (EU/US/self-hosted) |
| `CURSOR_LANGFUSE_TRACE_NAME` | `cursor-agent` | Constant trace name; the prompt is the trace **input** |
| `LANGFUSE_TRACING_ENVIRONMENT` | `local-dev` | Environment tag |
| `CURSOR_LANGFUSE_USER_ID` | — | Fallback `userId` when Cursor's email isn't available |
| `CURSOR_LANGFUSE_DEBUG` | `0` | `1` logs each invocation to `hook-debug.log` |

## What gets installed

```
<project>/.cursor/
├── hooks.json                 # your existing hooks preserved; ours merged in
└── hooks/langfuse/
    ├── hook-handler.js
    ├── lib/{langfuse-client,handlers,transcript,utils}.js
    ├── run.sh                 # loads .env, resolves node, routes turn-end events
    ├── .env                   # your keys — gitignored
    └── .gitignore             # ignores .env, .turnstart/, hook-debug.log
```

`hooks.json` references `run.sh` by **absolute path** (project install) or `"$CURSOR_PLUGIN_ROOT/run.sh"` (plugin install) so it resolves regardless of Cursor's working directory.

## Troubleshooting

- **No traces?** Reload Cursor after install; ensure the workspace is trusted. Set `CURSOR_LANGFUSE_DEBUG=1` in `.env`, send a chat, read `.cursor/hooks/langfuse/hook-debug.log`.
- **Ingestion lag:** Langfuse can take ~30s to surface a trace — that's normal.
- Tracing failures never block Cursor — the handler always fails open.

## License

MIT
