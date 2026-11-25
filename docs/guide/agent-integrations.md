# Agent integrations

TeXRA's assistant can hand a programming task (a numerical check, a figure script, a second opinion on code) to a coding agent you already have on your machine, and it can call local MCP servers.

## Codex and Claude Code

TeXRA has no dedicated tool for either. The assistant runs their command lines through its shell tool, the way you would in a terminal: `codex exec` for [OpenAI Codex](https://developers.openai.com/codex/cli) and `claude -p` for [Claude Code](https://code.claude.com/docs/en/setup). Ask for one by name:

> Use Codex to sketch a minimal FastAPI server that returns a JSON healthcheck.

> Ask Claude Code to add a `--dry-run` flag to the build script and update its tests.

What you need:

- **The CLI installed and signed in.** Install it with its own installer and sign in with `codex login` or `claude login` in a terminal. A command the assistant runs does not see the API keys you saved in TeXRA, and provider key variables such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are removed from its environment, so each CLI uses its own login.
- **Skills on, for the exact flags.** The bundled `coding-agents` skill tells the assistant how to run each CLI without a terminal: where the prompt goes, how to pick the directory, model, effort and permissions, and how to continue an earlier thread. The assistant reads it only while **Enable skills for agents** is on (**Settings → Agents → Skills**, or `texra.skills.enabled`; off by default). Without it the assistant works from the CLI's `--help`.

How a turn runs:

- The command is an ordinary shell command, so it follows **Settings → General → Approval** like any other: under **Ask** you approve the command line, which shows the permissions the assistant chose for the other agent.
- A long turn runs as a background command (up to 6 hours). It shows as a background task whose output you can read while it runs, and its result returns to the assistant as a message when it ends. A one-shot run such as `texra run` has no later turn to take that message, so there the command runs in the foreground, for at most 10 minutes.
- Neither CLI can stop to ask you something: there is no terminal for its prompt. The assistant picks the sandbox or permission mode up front.
- The other agent's steps are not shown as cards of their own; you see the command and what it printed.
- To continue an earlier turn, the assistant passes the thread or session id the first turn printed.

## GitHub activity

The assistant follows a pull request's reviews and CI, an issue or a repository with the [`gh` command line](https://cli.github.com) in its shell, and comes back to check again by scheduling itself a later turn. The bundled `github` skill has the commands (with skills on, as above).

- Sign in with `gh auth login` in a terminal, or start TeXRA with `GH_TOKEN` set. TeXRA stores no GitHub token of its own.
- Nothing polls in the background: each look is a turn the assistant scheduled, at least a minute after the last. A scheduled turn is kept by the running TeXRA process; if TeXRA is closed when one is due, it runs once, late, the next time the project is opened. Stopping the task cancels what it scheduled.
- A one-shot run such as `texra run` cannot be continued later, so it can check once (or wait on `gh pr checks --watch`) but not follow over time.

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

## Next steps

- [Configuration](./configuration.md): full Settings reference
- [LaTeX tools](./latex-tools.md): other local tools TeXRA plugs into
- [Research tools](./research-tools.md): arXiv, Zotero, and web search
