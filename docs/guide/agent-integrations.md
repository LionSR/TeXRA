<script setup>
import IntegrationCard from '../.vitepress/components/IntegrationCard.vue';
import DelegatedStreamHero from '../.vitepress/components/DelegatedStreamHero.vue';
import CliToolsLifecycleHero from '../.vitepress/components/CliToolsLifecycleHero.vue';
</script>

# Agent Integrations

TeXRA can hand off a task to a second coding agent that runs on your machine
alongside it. Two are supported today:

- **OpenAI Codex** — a sandboxed coding agent on your ChatGPT Plus / Pro plan
  (or an OpenAI API key). TeXRA agents reach it through the `codex` tool.
- **Claude Code** — Anthropic's coding agent on your Claude Pro / Max plan
  (or an Anthropic API key). TeXRA agents reach it through the `claude_code`
  tool.

Each one is set up from its own card on **Dashboard → Integrations**. When a
TeXRA agent uses the tool, the work runs in a side panel on the ProgressBoard
that you can watch live and reply to — TeXRA carries on while the side agent
does its thing.

## Quick Start

Both integrations follow the same setup flow from the TeXRA Dashboard.

1. Open **TeXRA: Show Settings Dashboard** (`Ctrl+Shift+P`) → **Integrations** tab (<wa-icon library="texra" name="link"></wa-icon>).
2. Find the **OpenAI Codex CLI** or **Claude Code CLI** card. When it's **Not Found**, the setup actions expand automatically.
3. Click <wa-icon library="texra" name="terminal"></wa-icon> **Install in Terminal**, then <wa-icon library="texra" name="right-to-bracket"></wa-icon> **Sign in** to OAuth in your browser.
4. Reopen the dashboard (or click **Re-check** on the **Tools** tab). The status flips to <wa-icon library="texra" name="check"></wa-icon> **Available** once TeXRA detects the install.

<IntegrationCard />
<p class="hero-caption">Each integration has its own card: a <strong>Not Found</strong> card expands its setup actions, and <strong>Re-check</strong> flips it to <strong>Available</strong> with a settings summary.</p>

The same flow runs beat for beat in a terminal — detect, install, sign in,
recheck:

<CliToolsLifecycleHero />

<p class="hero-caption"><code>texra tools</code> drives the full lifecycle: <code>status</code> reports the registered install and auth commands, <code>install --run</code> executes the installer after printing it, and <code>auth</code> hands off to the tool's own sign-in.</p>

Each integration's options live on its card and are scoped to the current workspace. Per-call approval prompts are governed by the global **Approve shell commands** switch under **Dashboard → Tools → Approval & safety** (on by default); turn it off to let agents call Codex or Claude Code without confirming each time.

Both CLIs are installed once per machine and shared by every TeXRA surface — the VS Code extension, the desktop app, and the terminal client all detect the same installation. Neither ships inside TeXRA: each one is a 250-410 MB native binary that Anthropic and OpenAI update on their own schedule, so TeXRA looks for whichever version you have rather than freezing a copy into every release.

::: warning Windows
TeXRA spawns each CLI binary directly in the same environment as the extension host, so it needs a real `.exe` — not one of the `claude` / `.cmd` / `.ps1` shims that a global npm install leaves behind. Claude Code is therefore installed with `winget` (or its native installer) on Windows, which is what **Install in Terminal** offers there. Codex is unaffected: TeXRA resolves its `codex.exe` inside the npm package itself.

- **WSL Remote** — open TeXRA inside the WSL window before installing.
- **Native Windows** — install the CLI on Windows so the real binary is on PATH.
  :::

## OpenAI Codex

### Install and Authenticate

- **Install** with `npm install -g @openai/codex` — or `brew install codex` (macOS), or the official installer linked from [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli). **Install in Terminal** picks Homebrew automatically when you have it, so the button works without a Node install.
- **Sign in** with `codex login` to use ChatGPT Plus / Pro — or set `OPENAI_API_KEY` in the shell you launch VS Code from to bill against an API account.

### Settings

| Setting              | Options                                                                     | Default           | What it controls                                                           |
| -------------------- | --------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| **Sandbox mode**     | `read-only`, `workspace-write`, `danger-full-access`                        | `workspace-write` | File-system access. Agents may override per call via `sandbox_mode`.       |
| **Reasoning effort** | `low`, `medium`, `high`, `xhigh`                                            | `high`            | How deeply Codex deliberates. `xhigh` is capped to `high` before hand-off. |
| **Approval policy**  | `auto approve`, `ask when requested`, `ask for untrusted`, `ask on failure` | `auto approve`    | When the Codex child process may stop to ask before running commands.      |

TeXRA pins Codex to the `gpt-5.5` model. Providers, MCP servers, and custom instructions come from Codex's own `~/.codex/config.toml`.

### Follow-ups

To continue an earlier Codex turn instead of starting a fresh one, the calling
agent calls `codex` again with the `thread_id` it received in the previous
delivery. The new prompt joins that Codex session as the next turn.

## Claude Code

### Install and Authenticate

- **Install** with `npm install -g @anthropic-ai/claude-code` — or `brew install --cask claude-code` (macOS), `winget install Anthropic.ClaudeCode` (Windows), or the native installer at [claude.com/code](https://claude.com/code).
- **Sign in** with `claude login` to use Claude Pro / Max — or set `ANTHROPIC_API_KEY` (Dashboard → Models → Anthropic, or the environment), or run `claude setup-token` to set `CLAUDE_CODE_OAUTH_TOKEN`. With none of these set, the CLI falls back to any existing `claude login` session.

### Settings

| Setting              | Options                                                                                            | Default             | What it controls                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| **Model**            | `Sonnet 5`, `Fable 5`, `Opus 5`, `Haiku 4.5`                                                       | `Sonnet 5`          | Which Claude model the delegated agent runs on. Agents may override per call. |
| **Permission mode**  | `Prompt for risky actions`, `Auto-accept edits`, `Bypass all (dangerous)`, `Plan only (read-only)` | `Auto-accept edits` | How much the Claude Code child process may do before stopping to ask.         |
| **Reasoning effort** | `Low`, `Medium`, `High`, `Extra high`, `Maximum`                                                   | `High`              | How deeply Claude deliberates before acting.                                  |

MCP servers, custom instructions, and hooks come from Claude Code's own configuration.

### Follow-ups

To continue an earlier Claude Code session, the calling agent calls
`claude_code` again with the `session_id` from the previous delivery. The new
prompt joins that session as the next turn (and waits its turn in the queue if
the session is still working).

## Running an Integration

Check which agents have the `codex` or `claude_code` tool enabled on the
**Agents** tab (<wa-icon library="texra" name="robot"></wa-icon>), then prompt
one of them:

> Use codex to sketch a minimal FastAPI server that returns a JSON healthcheck.

> Use claude_code to add a `--dry-run` flag to the build script and update its tests.

When the tool fires:

1. A new stream tab opens on the ProgressBoard labelled `codex` or `claude_code`.
2. You see the side agent's reasoning, the commands it runs, the file changes it makes, and any web searches (<wa-icon library="texra" name="globe"></wa-icon>) and todos — all live.
3. When the turn ends, the tab shows **WAITING**. Type into it to send a follow-up, or press <wa-icon library="texra" name="circle-stop"></wa-icon> **Stop** to close the session.
4. The result (final message and token cost) is handed back to the TeXRA agent that asked for it, which then continues its own work.

<DelegatedStreamHero />
<p class="hero-caption">The delegated session streams live in its own ProgressBoard tab — reasoning, commands, file changes, web searches, and todos — then shows <strong>WAITING</strong> and hands its result back to the calling agent.</p>

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
