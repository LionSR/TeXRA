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

Both integrations follow the same setup flow from the TeXRA Dashboard.

1. Open **TeXRA: Show Dashboard** (`Ctrl+Shift+P`) → **Integrations** tab (<wa-icon library="texra" name="robot"></wa-icon>).
2. Find the **OpenAI Codex CLI** or **Claude Code CLI** card. When it's **Not Found**, the setup actions expand automatically.
3. Click <wa-icon library="texra" name="terminal"></wa-icon> **Install in Terminal**, then <wa-icon library="texra" name="sign-in"></wa-icon> **Sign in** to OAuth in your browser.
4. Click **Recheck**. The status flips to <wa-icon library="texra" name="check"></wa-icon> **Available**.

Each integration's options live on its card and are scoped to the current workspace. Per-call approval prompts are governed by the global **Require approval for shell commands & agent sessions** switch under **Dashboard → Tools → Approval & Safety** (on by default); turn it off to let agents call Codex or Claude Code without confirming each time.

::: warning Windows
TeXRA spawns each CLI binary directly in the same environment as the extension host and skips `.cmd` / PowerShell shims, so an npm wrapper alone is not enough.

- **WSL Remote** — open TeXRA inside the WSL window before installing.
- **Native Windows** — install the CLI on Windows so the real binary is on PATH.
  :::

## OpenAI Codex

### Install and Authenticate

- **Install** with `npm install -g @openai/codex`, or use the official installer linked from [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli).
- **Sign in** with `codex login` to use ChatGPT Plus / Pro — or set `OPENAI_API_KEY` in the shell you launch VS Code from to bill against an API account.

### Settings

| Setting              | Options                                                                     | Default           | What it controls                                                           |
| -------------------- | --------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| **Sandbox mode**     | `read-only`, `workspace-write`, `danger-full-access`                        | `workspace-write` | File-system access. Agents may override per call via `sandbox_mode`.       |
| **Reasoning effort** | `low`, `medium`, `high`, `xhigh`                                            | `high`            | How deeply Codex deliberates. `xhigh` is capped to `high` before hand-off. |
| **Approval policy**  | `auto approve`, `ask when requested`, `ask for untrusted`, `ask on failure` | `auto approve`    | When the Codex child process may stop to ask before running commands.      |

TeXRA pins Codex to the `gpt-5.5` model. Providers, MCP servers, and custom instructions come from Codex's own `~/.codex/config.toml`.

### Follow-ups

To send a follow-up from the calling agent, call `codex` again with `thread_id`
set to the ID from the previous delivery. The prompt is queued as the next turn
and errors if the thread is still processing — same contract as
`delegate_agent(execution_id=…)`.

## Claude Code

### Install and Authenticate

- **Install** with `npm install -g @anthropic-ai/claude-code` — or `brew install --cask claude-code` (macOS), `winget install Anthropic.ClaudeCode` (Windows), or the native installer at [claude.com/code](https://claude.com/code).
- **Sign in** with `claude login` to use Claude Pro / Max — or set `ANTHROPIC_API_KEY` (Dashboard → Models → Anthropic, or the environment), or run `claude setup-token` to set `CLAUDE_CODE_OAUTH_TOKEN`. With none of these set, the CLI falls back to any existing `claude login` session.

### Settings

| Setting              | Options                                                                                            | Default             | What it controls                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| **Model**            | `Sonnet 4.6`, `Opus 4.7`, `Haiku 4.5`                                                              | `Sonnet 4.6`        | Which Claude model the delegated agent runs on. Agents may override per call. |
| **Permission mode**  | `Prompt for risky actions`, `Auto-accept edits`, `Bypass all (dangerous)`, `Plan only (read-only)` | `Auto-accept edits` | How much the Claude Code child process may do before stopping to ask.         |
| **Reasoning effort** | `Low`, `Medium`, `High`, `Extra high`, `Maximum`                                                   | `High`              | How deeply Claude deliberates before acting.                                  |

MCP servers, custom instructions, and hooks come from Claude Code's own configuration.

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

1. A child stream tab opens on the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>) — `codex@codex-sdk` for Codex, `claude@agent-sdk` for Claude Code.
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

| Message                                                     | Fix                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk not found`                  | Reinstall TeXRA, or run `npm install @anthropic-ai/claude-agent-sdk`, then **Recheck**.                               |
| `Claude Code SDK loaded but native claude binary not found` | Run `npm install -g @anthropic-ai/claude-code` in the same environment as the extension host (inside WSL on Windows). |

**`claude login` opens a terminal but nothing happens.** The button runs `claude login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

### Either Integration

**Still Not Found after everything ran.** Reload the window (`Developer: Reload Window`) so the extension re-checks for the binary.

## Next Steps

- [Configuration](./configuration.md) — full Dashboard and settings reference
- [LaTeX Tools](./latex-tools.md) — other local tools TeXRA plugs into
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
