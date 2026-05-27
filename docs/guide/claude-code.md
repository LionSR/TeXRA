# Connecting to Claude Code

TeXRA can hand off tasks to [Claude Code](https://claude.com/code) — Anthropic's
agentic coding CLI that runs locally, reads files, runs commands, edits code, and
searches the web. Once connected, any TeXRA tool-use agent can delegate to it via
the `claude_code` tool, using your Claude Pro / Max subscription or an Anthropic
API key.

## Quick Start

Set everything up from the TeXRA Dashboard — no terminal copy-paste.

1. Open **TeXRA: Show Dashboard** (`Ctrl+Shift+P`) → **Integrations** tab (<wa-icon library="texra" name="robot"></wa-icon>).
2. Find the **Claude Code CLI** card. When it's **Not Found**, the setup actions expand automatically.
3. Click the buttons in order:
   - <wa-icon library="texra" name="terminal"></wa-icon> **Install in Terminal** — opens an integrated terminal and runs `npm install -g @anthropic-ai/claude-code`.
   - <wa-icon library="texra" name="sign-in"></wa-icon> **Sign in** — runs `claude login`, which completes the OAuth flow in your browser using your Claude Pro / Max account.
4. After both finish, click the card's **Recheck** action. The status flips to <wa-icon library="texra" name="check"></wa-icon> **Available** and the `claude_code` tool is ready.

That's it — any tool-use agent with the `claude_code` tool enabled can now delegate to Claude Code.

::: tip Other install methods
Besides npm, you can install the CLI with `brew install --cask claude-code` (macOS), `winget install Anthropic.ClaudeCode` (Windows), or the native installer from [claude.com/code](https://claude.com/code). The card's <wa-icon library="texra" name="link-external"></wa-icon> **Open Install Page** button links to the official [setup guide](https://code.claude.com/docs/en/setup).
:::

## Authentication

Claude Code accepts any one of these (checked in this order):

- **Anthropic API key** — set it in **Dashboard → Models → Anthropic**, or export `ANTHROPIC_API_KEY` in the shell you launch VS Code from.
- **OAuth sign-in** — `claude login` with a Claude Pro / Max subscription (the **Sign in** button runs this).
- **Long-lived token** — `claude setup-token`, which sets `CLAUDE_CODE_OAUTH_TOKEN`.

If none are detected, Claude Code falls back to whatever `claude login` session already exists on your machine.

## Settings

All Claude Code options live on the **Claude Code CLI** card in **Dashboard → Integrations** and are scoped to the current workspace.

| Setting              | Options                                                                                  | Default              | What it controls                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| **Model**            | `Sonnet 4.6`, `Opus 4.7`, `Haiku 4.5`                                                    | `Sonnet 4.6`         | Which Claude model the delegated agent runs on. Agents may override per call. |
| **Permission mode**  | `Prompt for risky actions`, `Auto-accept edits`, `Bypass all (dangerous)`, `Plan only (read-only)` | `Auto-accept edits`  | How much the Claude Code child process may do before stopping to ask.         |
| **Reasoning effort** | `Low`, `Medium`, `High`, `Extra high`, `Maximum`                                         | `High`               | How deeply Claude deliberates before acting.                                  |

Everything else (MCP servers, custom instructions, hooks) comes from Claude Code's own configuration.

## Running Claude Code

Check which agents have the `claude_code` tool enabled on the **Agents** tab (<wa-icon library="texra" name="sparkle"></wa-icon>), then prompt one of them:

> Use claude_code to add a `--dry-run` flag to the build script and update its tests.

When it fires:

1. A child stream tab for the Claude Code agent opens on the ProgressBoard (<wa-icon library="texra" name="type-hierarchy"></wa-icon>).
2. Reasoning, commands, file diffs, and web searches (<wa-icon library="texra" name="globe"></wa-icon>) stream in live.
3. When the turn ends, the tab sits in **WAITING**. Type a follow-up to continue the thread, or press <wa-icon library="texra" name="debug-stop"></wa-icon> **Stop** to end it.
4. Every turn is delivered to the calling agent as a follow-up message (final response, token usage, and `session_id`). Calls are async — the tool returns immediately with an execution ID.

::: tip Follow-up instructions
To continue a session from the calling agent, call `claude_code` again with `session_id` set to the ID from the previous delivery. The prompt is enqueued as the session's next turn; if the session is still processing, it waits in the queue.
:::

::: warning Windows
TeXRA looks up the `claude` binary in the same environment as the VS Code extension host, so install it there:

- **WSL Remote** — open TeXRA inside the WSL window before clicking **Install in Terminal**.
- **Native Windows** — install Claude Code on Windows so a real `claude` binary is on PATH.
  :::

## Troubleshooting

**Card shows <wa-icon library="texra" name="warning"></wa-icon> Not Found after install.** Hover the card for the exact message:

| Message                                              | Fix                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/claude-agent-sdk not found`           | Reinstall TeXRA, or run `npm install @anthropic-ai/claude-agent-sdk`, then **Recheck**.                            |
| `Claude Code SDK loaded but native claude binary not found` | Run `npm install -g @anthropic-ai/claude-code` in the same environment as the extension host (inside WSL on Windows). |

**Still Not Found after everything ran.** Reload the window (`Developer: Reload Window`) so the extension re-checks for the binary.

**`claude login` opens a terminal but nothing happens.** The button runs `claude login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

## Next Steps

- [Connecting to the Codex CLI](./codex-cli.md) — delegate to OpenAI Codex instead
- [Configuration](./configuration.md) — full Dashboard and settings reference
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
