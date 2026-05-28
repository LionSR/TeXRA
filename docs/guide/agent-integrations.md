# Agent Integrations

TeXRA can hand off work to two external coding agents that run locally on your
machine:

- **OpenAI Codex** — a sandboxed coding agent backed by your ChatGPT Plus / Pro
  plan or an OpenAI API key. Exposed to TeXRA as the `codex` tool.
- **Claude Code** — Anthropic's agentic coding CLI, backed by your Claude
  Pro / Max plan or an Anthropic API key. Exposed to TeXRA as the `claude_code`
  tool.

Each integration is configured from its own card in **Dashboard → Integrations**,
and any TeXRA tool-use agent with the tool enabled can delegate to it. Calls are
async — the tool returns an execution ID immediately, and each turn arrives as a
follow-up to the calling agent.

## Quick Start

Both integrations share the same setup flow. Do it from the TeXRA Dashboard —
no terminal copy-paste.

1. Open **TeXRA: Show Dashboard** (`Ctrl+Shift+P`) → **Integrations** tab (<wa-icon library="texra" name="robot"></wa-icon>).
2. Find the card (**OpenAI Codex CLI** or **Claude Code CLI**). When it's **Not Found**, the setup actions expand automatically.
3. Click the buttons in order:
   - <wa-icon library="texra" name="terminal"></wa-icon> **Install in Terminal** — opens an integrated terminal and runs the CLI's install command.
   - <wa-icon library="texra" name="sign-in"></wa-icon> **Sign in** — runs the CLI's OAuth login in your browser.
4. Click **Recheck**. The status flips to <wa-icon library="texra" name="check"></wa-icon> **Available** and the tool is ready.

::: warning Windows
TeXRA looks up each CLI binary in the same environment as the VS Code extension
host, so install it there:

- **WSL Remote** — open TeXRA inside the WSL window before clicking **Install in Terminal**.
- **Native Windows** — install the CLI on Windows so the real binary is on PATH. TeXRA spawns the binary directly and skips `.cmd` / PowerShell shims, so an npm wrapper alone won't be found.
  :::

## OpenAI Codex

### Install and Authenticate

| Step    | Command                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| Install | `npm install -g @openai/codex` (or the official installer from [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli)) |
| Sign in | `codex login` — OAuth with ChatGPT Plus / Pro                                                                        |
| Or      | Set `OPENAI_API_KEY` in the shell you launch VS Code from to bill against your API account instead.                  |

### Settings

All Codex options live on the Codex card in **Dashboard → Integrations** and are scoped to the current workspace.

| Setting              | Options                                                                                | Default           | What it controls                                                           |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| **Sandbox mode**     | `read-only`, `workspace-write`, `danger-full-access`                                   | `workspace-write` | File-system access. Agents may override per call via `sandbox_mode`.       |
| **Reasoning effort** | `low`, `medium`, `high`, `xhigh`                                                       | `high`            | How deeply Codex deliberates. `xhigh` is capped to `high` before hand-off. |
| **Approval policy**  | `auto approve`, `ask when requested`, `ask for untrusted`, `ask on failure`            | `auto approve`    | When the Codex child process may stop to ask before running commands.      |
| **Require approval** | checkbox under _Approval & Safety_ (<wa-icon library="texra" name="shield"></wa-icon>) | on                | Show a confirmation prompt before every Codex call.                        |

TeXRA always drives Codex with the short model name `gpt-5.5` — OpenAI's latest flagship, well-suited to the planning, tool use, and multi-step execution Codex relies on. Everything else (providers, MCP servers, custom instructions) comes from Codex's own `~/.codex/config.toml`.

### Follow-ups

To send a follow-up from the calling agent, call `codex` again with `thread_id`
set to the ID from the previous delivery. The prompt is queued as the next turn
and errors if the thread is still processing — same contract as
`delegate_agent(execution_id=…)`.

## Claude Code

### Install and Authenticate

| Step    | Command                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Install | `npm install -g @anthropic-ai/claude-code` — or `brew install --cask claude-code` (macOS), `winget install Anthropic.ClaudeCode` (Windows), or the native installer from [claude.com/code](https://claude.com/code) |
| Sign in | `claude login` — OAuth with Claude Pro / Max                                                                                     |
| Or      | Set `ANTHROPIC_API_KEY` in **Dashboard → Models → Anthropic** or in the environment, or run `claude setup-token` to set `CLAUDE_CODE_OAUTH_TOKEN`. |

If none are detected, Claude Code falls back to whatever `claude login` session already exists on your machine.

### Settings

All Claude Code options live on the **Claude Code CLI** card in **Dashboard → Integrations** and are scoped to the current workspace.

| Setting              | Options                                                                                          | Default             | What it controls                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------- |
| **Model**            | `Sonnet 4.6`, `Opus 4.7`, `Haiku 4.5`                                                            | `Sonnet 4.6`        | Which Claude model the delegated agent runs on. Agents may override per call. |
| **Permission mode**  | `Prompt for risky actions`, `Auto-accept edits`, `Bypass all (dangerous)`, `Plan only (read-only)` | `Auto-accept edits` | How much the Claude Code child process may do before stopping to ask.         |
| **Reasoning effort** | `Low`, `Medium`, `High`, `Extra high`, `Maximum`                                                 | `High`              | How deeply Claude deliberates before acting.                                  |

Everything else (MCP servers, custom instructions, hooks) comes from Claude Code's own configuration.

### Follow-ups

To continue a session from the calling agent, call `claude_code` again with
`session_id` set to the ID from the previous delivery. The prompt is enqueued as
the session's next turn; if the session is still processing, it waits in the
queue.

## Running an Integration

Check which agents have the `codex` or `claude_code` tool enabled on the
**Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>), then prompt
one of them:

> Use codex to sketch a minimal FastAPI server that returns a JSON healthcheck.

> Use claude_code to add a `--dry-run` flag to the build script and update its tests.

When the tool fires:

1. A child stream tab opens on the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) — Codex labels its stream `codex@codex-sdk`; Claude Code labels its stream after the Claude Code agent.
2. Reasoning, commands, file diffs, web searches (<wa-icon library="texra" name="globe"></wa-icon>), and todos stream in live.
3. When the turn ends, the tab sits in **WAITING**. Type a follow-up to continue the thread, or press <wa-icon library="texra" name="debug-stop"></wa-icon> **Stop** to end it.
4. Each turn is delivered to the calling agent as a follow-up message (final response, token usage, and the thread or session id).

## Troubleshooting

Hover the card for the exact error message before applying a fix.

### OpenAI Codex

| Message                                        | Fix                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@openai/codex-sdk not found`                  | Click **Install in Terminal** again, then **Recheck**.                                                             |
| `Codex SDK loaded but native binary not found` | Reinstall in the same environment as the extension host. On Windows, see the **Windows** note above for the catch. |
| `Platform not supported`                       | Codex ships native binaries for Linux, macOS, and Windows (`x64` / `arm64`). On other hosts, fall back to WSL.     |

**`codex login` opens a terminal but nothing happens.** The button runs `codex login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

**Session stuck in WAITING after a reload.** TeXRA interrupts Codex threads when the extension reloads. Close the tab and start a new turn — pass the previous `thread_id` if you want to continue where you left off.

### Claude Code

| Message                                                     | Fix                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/claude-agent-sdk not found`                  | Reinstall TeXRA, or run `npm install @anthropic-ai/claude-agent-sdk`, then **Recheck**.                            |
| `Claude Code SDK loaded but native claude binary not found` | Run `npm install -g @anthropic-ai/claude-code` in the same environment as the extension host (inside WSL on Windows). |

**`claude login` opens a terminal but nothing happens.** The button runs `claude login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

### Either Integration

**Still Not Found after everything ran.** Reload the window (`Developer: Reload Window`) so the extension re-checks for the binary.

## Next Steps

- [Configuration](./configuration.md) — full Dashboard and settings reference
- [LaTeX Tools](./latex-tools.md) — other local tools TeXRA plugs into
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
