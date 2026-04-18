# Connecting to the Codex CLI

TeXRA can spin off an [OpenAI Codex](https://developers.openai.com/codex/cli) agent as a local tool. Codex is a sandboxed coding agent that reads files, runs commands, and edits code inside your workspace. Once connected, any TeXRA tool-use agent can delegate work to it via the `codex` tool — useful for long-running code tasks, scripted verifications, or offloading heavy reasoning to a ChatGPT subscription.

## Why Use Codex From TeXRA?

- **Subscription reuse:** Codex authenticates with your ChatGPT Plus / Pro account, so the compute is covered by your existing plan instead of per-token API billing.
- **Sandboxed execution:** Commands and file writes happen under Codex's sandbox — you pick the access level.
- **Multi-turn threads:** Each Codex run opens a dedicated stream tab. You can send follow-ups without starting a new session, and the agent can resume a thread by ID.
- **Background mode:** Launch Codex asynchronously; TeXRA delivers the result back to the parent agent when the turn completes.

## Prerequisites

- Node.js and `npm` on your PATH (used by the Codex CLI installer).
- A ChatGPT account (Plus or Pro recommended) **or** an `OPENAI_API_KEY` with Codex access.
- TeXRA installed in VS Code ([Installation Guide](./installation.md)).

## 1. Install the Codex CLI

Pick whichever installer fits your platform. TeXRA's `codex` tool uses the binary from `@openai/codex` via the `@openai/codex-sdk` Node package.

::: code-group

```bash [npm (all platforms)]
npm install -g @openai/codex
```

```bash [Homebrew (macOS)]
brew install codex
```

```bash [Windows / WSL]
# Install inside the WSL environment, not on the Windows side.
wsl
npm install -g @openai/codex
```

:::

Verify the install:

```bash
codex --version
```

::: warning Windows users
Codex does not ship a native Windows binary. Install it inside **WSL** (and run VS Code's WSL remote) or use the standalone Codex desktop app. TeXRA discovers the binary via the SDK's platform-specific package, so a Windows-side install will not be detected.
:::

## 2. Authenticate

Choose one of the following.

### Option A — ChatGPT login (recommended)

```bash
codex login
```

This opens a browser window and stores credentials at `~/.codex/auth.json`. It is the right choice if you already pay for ChatGPT Plus / Pro.

### Option B — API key

Export an API key with Codex access:

```bash
export OPENAI_API_KEY="sk-..."
```

Add it to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) so VS Code inherits the variable. On Windows + WSL, export inside the WSL shell that launches `code .`.

::: tip
Codex manages its own auth state — TeXRA never reads or stores your ChatGPT credentials. You can switch accounts any time with `codex logout` followed by `codex login`.
:::

## 3. Verify the Connection in TeXRA

1. Open the TeXRA Dashboard: `Ctrl+Shift+P` → **TeXRA: Show Dashboard**.
2. Go to the **Tools** tab.
3. Under **Computation**, find the **OpenAI Codex CLI** card.

If the card shows a green check, the SDK loaded and the Codex binary was discovered. If it shows an error, hover for the detail message:

| Detail message                                                     | What to do                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@openai/codex-sdk not found`                                      | Run `npm install -g @openai/codex` and reload VS Code.                                            |
| `Codex SDK loaded but native binary not found`                     | The SDK installed without its platform binary — reinstall with `npm install -g @openai/codex`.    |
| `Platform not supported`                                           | You're on an unsupported OS/arch. Use WSL on Windows or a supported Linux/macOS host.             |
| `Codex CLI ready. Binary: /…/codex`                                | All set.                                                                                          |

## 4. Configure Codex

Codex-specific settings live directly on the Codex card in **Dashboard → Tools**. They are scoped to the current workspace.

### Sandbox mode

| Mode                 | What Codex can do                                                                     |
| -------------------- | ------------------------------------------------------------------------------------- |
| `read-only`          | Read files and run read-only commands. No writes, no network side effects.            |
| `workspace-write`    | Read + write inside the workspace directory. **Default.**                             |
| `danger-full-access` | No sandbox — Codex can touch anything the user can. Use only when you trust the task. |

The orchestrating agent may override this per call via the tool's `sandbox_mode` parameter, but the dashboard value is the default.

### Reasoning effort

Controls how much the model deliberates before responding.

| Effort   | Behavior                                                                 |
| -------- | ------------------------------------------------------------------------ |
| `low`    | Fast, shallow.                                                           |
| `medium` | Balanced.                                                                |
| `high`   | Deeper reasoning. **Default.**                                           |
| `xhigh`  | TeXRA-only UI tier. Capped to `high` when handed to the Codex CLI.       |

TeXRA drives Codex with the short model name `gpt-5.4`; it is not a dropdown because the Codex CLI selects its own model family internally.

### Approval prompts

The **Require approval for shell commands & Codex sessions** checkbox (same **Tools** tab, under *Approval & Safety*) applies to every Codex invocation. With it enabled, TeXRA shows a confirmation prompt before each Codex call and includes the prompt preview plus the sandbox mode. Disable it only for trusted autonomous flows.

## 5. Run Your First Codex Turn

Any tool-use agent with `codex` in its allowed tools can delegate to Codex. The built-in `plan`, `draft`, and `code` agents include it by default. Try:

```
Use codex to sketch a minimal FastAPI server that returns a JSON healthcheck.
```

What to expect:

1. A child stream tab opens with the prefix `codex@codex-sdk`.
2. The stream shows Codex's reasoning, command executions, file diffs, web searches, and todo list in real time.
3. When the turn finishes, the tab stays in **WAITING** state — type a follow-up in the tab's input to keep the same thread going.
4. The agent that invoked Codex receives a compact result with the final response, token usage, and a `thread_id` it can pass back to resume the conversation later.

### Background mode

Agents can pass `run_in_background: true` when they don't need to block on the result. TeXRA immediately returns the execution ID and stream tab, then delivers the completed output as a follow-up message once Codex finishes. Handy for long refactors while the parent agent keeps working.

## Troubleshooting

**Codex card stays red after installing.** Reload the VS Code window (`Developer: Reload Window`) so the extension re-checks for the binary.

**Authentication prompts keep appearing.** Run `codex login` in the terminal VS Code is launched from — environment variables set in a GUI session may not reach the Codex binary. On macOS, make sure you're not launching VS Code from Finder with a clean environment.

**`codex login` fails in WSL.** Make sure the WSL distro can open URLs in your host browser (`wslu` or `wslview`). Alternatively, copy the login URL and paste it into a browser manually.

**The session is stuck in WAITING after a reload.** TeXRA interrupts Codex threads on extension reload. Close the stream tab and start a new turn — threads are cached to disk, so pass the previous `thread_id` if you want to continue where you left off.

**Custom Codex config.** Codex reads its own config from `~/.codex/config.toml`. TeXRA only overrides `model`, `modelReasoningEffort`, `sandboxMode`, and the workspace directories — everything else (providers, MCP servers, custom instructions) comes from Codex's config and is respected as-is.

## Next Steps

- [Configuration](./configuration.md) — full Dashboard and settings reference
- [LaTeX Tools](./latex-tools.md) — other local tools TeXRA plugs into
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
