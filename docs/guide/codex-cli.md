# Connecting to the Codex CLI

TeXRA can hand off tasks to [OpenAI Codex](https://developers.openai.com/codex/cli) — a sandboxed coding agent that runs locally, reads files, runs commands, and edits code. Once connected, any TeXRA tool-use agent can delegate to it via the `codex` tool and let your ChatGPT Plus / Pro plan cover the compute.

## Quick Start

Set everything up from the TeXRA Dashboard — no terminal copy-paste.

1. Open **TeXRA: Show Dashboard** (`Ctrl+Shift+P`) → **Tools** tab (<i class="codicon codicon-tools"></i>) → **Computation** (<i class="codicon codicon-symbol-operator"></i>).
2. Find the **OpenAI Codex CLI** card. When it's **Not Found**, the setup actions expand automatically.
3. Click the two buttons in order:
   - <i class="codicon codicon-terminal"></i> **Install in Terminal** — opens an integrated terminal and runs `npm install -g @openai/codex`.
   - <i class="codicon codicon-sign-in"></i> **Sign in** — runs `codex login`, which completes the OAuth flow in your browser using your ChatGPT Plus / Pro account.
4. After both finish, click the card's **Recheck** action. The status flips to <i class="codicon codicon-check"></i> **Available** and the `codex` tool is ready.

That's it — any tool-use agent with the `codex` tool enabled can now delegate to Codex.

::: tip Prefer API-key billing?
Skip **Sign in** and export `OPENAI_API_KEY` in the shell you launch VS Code from. Codex picks it up automatically. You can also use the <i class="codicon codicon-link-external"></i> **Open Install Page** button on the card for the official installer if you'd rather do it outside VS Code.
:::

::: warning Windows
Codex has no native Windows binary. Open TeXRA inside a **WSL** remote window before clicking **Install in Terminal** — otherwise the install runs in PowerShell and VS Code won't find the binary.
:::

## Settings

All Codex options live on the Codex card in **Dashboard → Tools** and are scoped to the current workspace.

| Setting              | Options                                                                       | Default             | What it controls                                                           |
| -------------------- | ----------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| **Sandbox mode**     | `read-only`, `workspace-write`, `danger-full-access`                          | `workspace-write`   | File-system access. Agents may override per call via `sandbox_mode`.       |
| **Reasoning effort** | `low`, `medium`, `high`, `xhigh`                                              | `high`              | How deeply Codex deliberates. `xhigh` is capped to `high` before hand-off. |
| **Require approval** | checkbox under *Approval & Safety* (<i class="codicon codicon-shield"></i>)   | on                  | Show a confirmation prompt before every Codex call.                        |

TeXRA always drives Codex with the short model name `gpt-5.4`. Everything else (providers, MCP servers, custom instructions) comes from Codex's own `~/.codex/config.toml`.

## Running Codex

Check which agents have the `codex` tool enabled on the **Agents** tab (<i class="codicon codicon-sparkle"></i>), then prompt one of them:

> Use codex to sketch a minimal FastAPI server that returns a JSON healthcheck.

When it fires:

1. A child stream tab `codex@codex-sdk` opens on the ProgressBoard (<i class="codicon codicon-type-hierarchy"></i>).
2. Reasoning, commands, file diffs, web searches (<i class="codicon codicon-globe"></i>), and todos stream in live.
3. When the turn ends, the tab sits in **WAITING**. Type a follow-up to continue the thread, or press <i class="codicon codicon-debug-stop"></i> **Stop** to end it.
4. Every turn is delivered to the calling agent as a follow-up message (final response, token usage, and `thread_id`). Calls are async — the tool returns immediately with an execution ID.

::: tip Follow-up instructions
To send a follow-up from the calling agent, call `codex` again with `thread_id` set to the ID from the previous delivery. The prompt is queued as the next turn and errors if the thread is still processing — same contract as `delegate_agent(execution_id=…)`.
:::

## Troubleshooting

**Card shows <i class="codicon codicon-warning"></i> Not Found after install.** Hover the card for the exact message:

| Message                                         | Fix                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `@openai/codex-sdk not found`                   | Click **Install in Terminal** again, then **Recheck**.                            |
| `Codex SDK loaded but native binary not found`  | Reinstall — the platform binary didn't ship. On Windows, open TeXRA in WSL first. |
| `Platform not supported`                        | Unsupported OS/arch. Use WSL on Windows or a supported Linux/macOS host.          |

**Still Not Found after everything ran.** Reload the window (`Developer: Reload Window`) so the extension re-checks for the binary.

**`codex login` opens a terminal but nothing happens.** The button runs `codex login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

**Session stuck in WAITING after a reload.** TeXRA interrupts Codex threads when the extension reloads. Close the tab and start a new turn — pass the previous `thread_id` if you want to continue where you left off.

## Next Steps

- [Configuration](./configuration.md) — full Dashboard and settings reference
- [LaTeX Tools](./latex-tools.md) — other local tools TeXRA plugs into
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
