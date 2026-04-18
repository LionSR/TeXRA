# Connecting to the Codex CLI

TeXRA can hand off tasks to [OpenAI Codex](https://developers.openai.com/codex/cli) — a sandboxed coding agent that runs locally, reads files, runs commands, and edits code. Once connected, any TeXRA tool-use agent can delegate to it via the `codex` tool and keep your ChatGPT Plus / Pro plan paying for the compute.

## Quick Start

Three steps, about two minutes.

### 1. Install the CLI

```bash
npm install -g @openai/codex
```

- macOS users can also `brew install codex`.
- **Windows:** install inside WSL and launch VS Code with the WSL remote — Codex has no native Windows binary.

Check it installed:

```bash
codex --version
```

### 2. Sign in

```bash
codex login
```

This opens a browser and stores credentials at `~/.codex/auth.json`. Your ChatGPT Plus / Pro plan covers the compute.

Prefer API billing? Export `OPENAI_API_KEY` in the shell that launches VS Code instead — Codex picks it up automatically.

### 3. Verify in TeXRA

Open **TeXRA: Show Dashboard** (`Ctrl+Shift+P`) → **Tools** (<i class="codicon codicon-tools"></i>) → **Computation** (<i class="codicon codicon-symbol-operator"></i>). The **OpenAI Codex CLI** card should read <i class="codicon codicon-check"></i> **Available**.

If it doesn't, jump to [Troubleshooting](#troubleshooting).

That's the whole setup — any tool-use agent with the `codex` tool enabled can now delegate to Codex.

## Settings

All Codex options live on the Codex card in **Dashboard → Tools** and are scoped to the current workspace.

| Setting              | Options                                                                       | Default             | What it controls                                                         |
| -------------------- | ----------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| **Sandbox mode**     | `read-only`, `workspace-write`, `danger-full-access`                          | `workspace-write`   | File-system access. Agents may override per call via `sandbox_mode`.     |
| **Reasoning effort** | `low`, `medium`, `high`, `xhigh`                                              | `high`              | How deeply Codex deliberates. `xhigh` is capped to `high` before hand-off. |
| **Require approval** | checkbox under *Approval & Safety* (<i class="codicon codicon-shield"></i>)   | on                  | Show a confirmation prompt before every Codex call.                      |

TeXRA always drives Codex with the short model name `gpt-5.4`. Everything else (providers, MCP servers, custom instructions) comes from Codex's own `~/.codex/config.toml`.

## Running Codex

Check which agents have the `codex` tool enabled on the **Agents** tab (<i class="codicon codicon-sparkle"></i>), then prompt one of them:

> Use codex to sketch a minimal FastAPI server that returns a JSON healthcheck.

When it fires:

1. A child stream tab `codex@codex-sdk` opens on the ProgressBoard (<i class="codicon codicon-type-hierarchy"></i>).
2. Reasoning, commands, file diffs, web searches (<i class="codicon codicon-globe"></i>), and todos stream in live.
3. When the turn ends, the tab sits in **WAITING**. Type a follow-up to continue the thread, or press <i class="codicon codicon-debug-stop"></i> **Stop** to end it.
4. The calling agent gets back the final response, token usage, and a `thread_id` it can resume later.

::: tip Background mode
Agents can pass `run_in_background: true` to get the execution ID immediately and receive the result as a follow-up when Codex finishes. Good for long refactors that shouldn't block the parent.
:::

## Troubleshooting

**Tools card shows <i class="codicon codicon-warning"></i> Not Found.** Hover the card for the exact message:

| Message                                         | Fix                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `@openai/codex-sdk not found`                   | `npm install -g @openai/codex`, then reload VS Code.                         |
| `Codex SDK loaded but native binary not found`  | Reinstall — the platform binary didn't ship. On Windows, install inside WSL. |
| `Platform not supported`                        | Unsupported OS/arch. Use WSL on Windows or a supported Linux/macOS host.     |

**Card is still Not Found after installing.** Reload the window (`Developer: Reload Window`) so the extension re-checks for the binary.

**Auth prompts keep appearing.** Run `codex login` in the shell VS Code inherits its environment from. On macOS, launching VS Code from Finder can strip exported variables — start it from a terminal instead.

**`codex login` fails in WSL.** Install `wslu` so Codex can open URLs in your host browser, or paste the login URL into a browser manually.

**Session stuck in WAITING after a reload.** TeXRA interrupts Codex threads when the extension reloads. Close the tab and start a new turn — pass the previous `thread_id` if you want to continue where you left off.

## Next Steps

- [Configuration](./configuration.md) — full Dashboard and settings reference
- [LaTeX Tools](./latex-tools.md) — other local tools TeXRA plugs into
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
