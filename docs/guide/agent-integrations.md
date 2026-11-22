<script setup>
import IntegrationCard from '../.vitepress/components/IntegrationCard.vue';
import DelegatedStreamHero from '../.vitepress/components/DelegatedStreamHero.vue';
</script>

# Agent integrations

TeXRA's assistant can delegate programming tasks—such as running numerical checks or writing figure scripts—to a local coding agent. Two integrations are supported:

- **OpenAI Codex**: a sandboxed coding agent on your ChatGPT Plus / Pro plan
  (or an OpenAI API key). The assistant reaches it through the `codex` tool.
  (ChatGPT Pro/Business plans also include monthly API credits for TeXRA's own
  OpenAI models; see [Getting API keys](./installation.md#setting-up-api-keys).)
- **Claude Code**: Anthropic's coding agent on your Claude Pro / Max plan
  (or an Anthropic API key). The assistant reaches it through the `claude_code`
  tool. (Claude Max/Team plans also include monthly API credits for TeXRA's own
  Anthropic models; see [Getting API keys](./installation.md#setting-up-api-keys).)

Each one is set up from its own row on **Settings → Plugins**. When the
assistant uses the tool, the work runs in a side panel on the Tasks view
that you can watch live. TeXRA carries on while the side agent
works.

## Quick start

Both integrations follow the same setup flow from the TeXRA Settings.

1. Open **TeXRA: Open Settings** (`Ctrl+Shift+P`) → **Plugins** (<wa-icon library="texra" name="cube"></wa-icon>).
2. Find the **OpenAI Codex CLI** or **Claude Code CLI** row and switch it on (both are off by default). When it shows **Needs setup**, the setup actions expand automatically.
3. Select <wa-icon library="texra" name="terminal"></wa-icon> **Install in terminal**, then <wa-icon library="texra" name="right-to-bracket"></wa-icon> **Sign in** to OAuth in your browser.
4. Reopen Settings (or select **Re-check** on the **Plugins** page). The status changes to a green <wa-icon library="texra" name="check"></wa-icon> check (tooltip **Ready**) once TeXRA detects the install.

<IntegrationCard />
<p class="hero-caption">Each integration has its own row: a <strong>Needs setup</strong> row expands its setup actions, and <strong>Re-check</strong> flips it to <strong>Ready</strong> with a settings summary.</p>

In the terminal client, `/plugins` lists the same integrations with their
state and switches each one on or off. Install and sign in to each CLI with its
own installer and sign-in command.

Each integration's options live on its row and are scoped to the current project. Per-call approval prompts follow **Settings → General → Approval**: **Auto-approve** (default), **Ask**, or **Block**. Choose **Ask** to review each launch, or approve all agent work for the task on its first request card. When you approve a single launch, Codex runs in `workspace-write` mode and Claude Code in `acceptEdits`; under **Auto-approve** (or an all-agent-work grant), both run with full permissions. Codex never stops to ask on its own.

Both CLIs are installed once per machine and shared by VS Code, the desktop app, and the CLI. Neither ships inside TeXRA, so TeXRA uses whichever version is installed on your machine.

::: warning Windows
TeXRA spawns each CLI binary directly in the same environment as the extension host, so it needs a real `.exe`, not one of the `claude` / `.cmd` / `.ps1` shims that a global npm install leaves behind. Claude Code is therefore installed with `winget` (or its native installer) on Windows, which is what **Install in terminal** offers there. For Codex, **Install in terminal** on Windows runs OpenAI's PowerShell installer (`irm https://chatgpt.com/codex/install.ps1 | iex`), which installs a native `codex.exe` that TeXRA finds without a restart. TeXRA looks for each CLI in the environment it runs in, so an install inside WSL is found only when TeXRA itself runs inside WSL (the **WSL Remote** case below), not from a native Windows window.

- **WSL Remote**: open TeXRA inside the WSL window before installing.
- **Native Windows**: install the CLI on Windows so the real binary is on PATH.
:::

## OpenAI Codex

### Install and authenticate

- **Install** with `npm install -g @openai/codex`, or `brew install codex` (macOS), or the official installer linked from [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli). **Install in terminal** picks Homebrew automatically when you have it, so the button works without a Node install; on Windows it runs OpenAI's PowerShell installer instead (see the Windows note above).
- **Sign in** with `codex login` to use ChatGPT Plus / Pro, or set `OPENAI_API_KEY` in the shell you launch VS Code from to bill against an API account.

### Settings

| Setting              | Options                                                      | Default       | What it controls                                                                                                                           |
| -------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model**            | the current OpenAI models your ChatGPT plan can use in Codex | `GPT-6.1 Sol` | Which model Codex runs.                                                                                                                    |
| **Reasoning effort** | `Low`, `Medium`, `High`, `Extra high`, `Maximum`             | `Medium`      | How deeply Codex deliberates. A level the model or your installed Codex lacks becomes the nearest one it has; older installs stop at High. |

Providers, MCP servers, and custom instructions come from Codex's own `~/.codex/config.toml`.

### Follow-ups

To continue an earlier Codex turn instead of starting a fresh one, the calling
agent calls `codex` again with the `thread_id` it received in the previous
delivery. The new prompt joins that Codex session as the next turn. A thread
whose turn is still running refuses another until that turn's result has been
delivered.

## Claude Code

### Install and authenticate

- **Install** with `npm install -g @anthropic-ai/claude-code`, or `brew install --cask claude-code` (macOS), `winget install Anthropic.ClaudeCode` (Windows), or the native installer at [claude.com/code](https://claude.com/code).
- **Sign in** with `claude login` to use Claude Pro / Max, or set `ANTHROPIC_API_KEY` (Settings → Models → API keys → Anthropic, or the environment), or run `claude setup-token` to set `CLAUDE_CODE_OAUTH_TOKEN`. With none of these set, the CLI falls back to any existing `claude login` session.

### Settings

| Setting              | Options                                          | Default      | What it controls                                                                                     |
| -------------------- | ------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------- |
| **Model**            | the current Claude models                        | `Sonnet 5.5` | Which Claude model the delegated agent runs on. Agents may override per call.                        |
| **Reasoning effort** | `Low`, `Medium`, `High`, `Extra high`, `Maximum` | `Medium`     | How deeply Claude deliberates before acting; a level the model lacks becomes the nearest one it has. |

MCP servers, custom instructions, and hooks come from Claude Code's own configuration.

### Follow-ups

To continue an earlier Claude Code session, the calling agent calls
`claude_code` again with the `session_id` from the previous delivery. The new
prompt joins that session as the next turn. A session whose turn is still
running refuses another until that turn's result has been delivered.

## Running an integration

Turn the integration on under **Settings → Plugins**, then ask the assistant:

> Use codex to sketch a minimal FastAPI server that returns a JSON healthcheck.

> Use claude_code to add a `--dry-run` flag to the build script and update its tests.

When the tool fires:

1. A new stream tab opens on the Tasks view labelled `codex` or `claude_code`.
2. You see the side agent's reasoning, the commands it runs, the file changes it makes, and any web searches (<wa-icon library="texra" name="globe"></wa-icon>), all live.
3. When the turn ends, the run shows **Completed**. Each call is one turn: to send a follow-up, the agent calls the tool again with the `thread_id` or `session_id` the result carried. Select <wa-icon library="texra" name="circle-stop"></wa-icon> **Stop** to end a turn early.
4. The result (final message and token cost) is handed back to the assistant (or helper agent) that asked for it, which then continues its own work.

Both tools deliver their result as a follow-up message, so they are not available in a one-shot run such as `texra run`; there the assistant delegates to a helper agent instead.

<DelegatedStreamHero />
<p class="hero-caption">The delegated session streams live in its own Tasks view tab (reasoning, commands, file changes, and web searches), then shows <strong>Completed</strong> and hands its result back to the calling agent.</p>

## MCP servers

TeXRA supports local stdio [Model Context Protocol](https://modelcontextprotocol.io) servers:

- **Plugin-bundled MCP servers** (recommended): any MCP servers included in an [installed plugin](./texra-cli.md#plugins) are automatically available to the assistant while that plugin is enabled.
- **Manual `~/.texra/mcp.json`**: open via **Settings → Plugins → Open mcp.json** (same format as Claude Code's `.mcp.json`). Note: servers listed _only_ in `~/.texra/mcp.json` are currently available only to custom runs/scripts that explicitly request `mcp__<server>__<tool>` (or `mcp__<server>__*`) — the default assistant does not automatically load them yet.

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "NOTION_TOKEN": "ntn_..." }
    }
  }
}
```

Server names may use letters, digits, `_`, and `-` (up to 32 characters, no `__`, not ending in `_`). Servers must support MCP revision `2025-11-25` (TypeScript SDK 1.25+); incompatible or failing servers are skipped with an explanation in the transcript.

- **Approval:** Every MCP tool call uses the same approval rules as shell commands (**Settings → General → Approval**). Headless runs require **Auto-approve** to call MCP tools.
- **Lifecycle:** A server starts on first use, is shared by tasks in the project, and stops 30 minutes after the last task finishes.
- **Environment:** Inherited environment variables containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` are stripped so provider keys are never leaked; pass required credentials explicitly in `env`.
- **Limits:** Calls time out after 60 seconds, and output over 200,000 characters is truncated in the middle.

Not yet supported: a project-level `.texra/mcp.json`, HTTP servers, servers
that change their tool list while running, and MCP resources and prompts.

## Troubleshooting

The exact error message is shown inline on the row, below its description. Read it before applying a fix.

### OpenAI Codex

| Message                                        | Fix                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@openai/codex-sdk package not found`          | Reinstall TeXRA (in a source checkout, run `corepack pnpm install`), then **Re-check**.                                                 |
| `Codex SDK loaded but native binary not found` | Run the install command the message names in the same environment as the extension host. On Windows, follow the **Windows** note above. |
| `Platform not supported`                       | Codex ships native binaries for Linux, macOS, and Windows (`x64` / `arm64`). On other hosts, use WSL.                                   |

**`codex login` opens a terminal but nothing happens.** The button runs `codex login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

**A turn interrupted by a reload.** TeXRA interrupts Codex turns when the extension reloads; the run shows Interrupted. Start a new turn, passing the previous `thread_id` to continue where you left off.

### Claude Code

| Message                                                         | Fix                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk package not found`              | Reinstall TeXRA (in a source checkout, run `corepack pnpm install`), then **Re-check**.                                                 |
| ``Claude Code SDK loaded but native `claude` binary not found`` | Run the install command the message names in the same environment as the extension host. On Windows, follow the **Windows** note above. |

**`claude login` opens a terminal but nothing happens.** The button runs `claude login` in a fresh integrated terminal. Focus the terminal and press **Enter** if the browser didn't open, or paste the login URL manually.

### Either integration

**Still Needs setup after everything ran.** Reload the window (`Developer: Reload Window`) so the extension re-checks for the binary.

## Next steps

- [Configuration](./configuration.md): full Settings reference
- [LaTeX tools](./latex-tools.md): other local tools TeXRA plugs into
- [Research tools](./research-tools.md): arXiv, Zotero, and web search
