---
created: 2026-09-24
status: implemented
---

# The plugin architecture: plugins as values, tools pinned per step

This note describes how plugins work on `main`. It is the owner of the topic;
the rulings it relies on are in the
[architecture rulings ledger](./2026-08-01-architecture-rulings-ledger.md),
and the step boundary is the one the
[core concepts](./2026-09-26-core-concepts.md) note
names (invariants 6 and 7).

## Owner rulings

- **Everything is a plugin.** Each extensible subsystem is contributed by a
  `Plugin` value keyed by a stable id. The harness's built-ins are plugins,
  and the app (TeXRA) is built from its own plugins beside them.
- **No new formats.** Plugins are TypeScript values, not a manifest format
  of our own. User-authored inputs reuse existing shapes: MCP servers use
  Claude Code's `.mcp.json` shape, installed plugins are Claude Code or Codex
  plugin directories, agents stay YAML and skills stay `SKILL.md`.
- **Hooks and data plugins are the extension mechanism** (ledger, "SDK and
  typed-RPC deferral (D11)"). Typed-RPC code plugins, `History.writer`, an
  open schema registry and a `PluginModule` interface are not built until a
  named plugin cannot be MCP + hooks + data.
- **A plugin's switch gates everything it contributes** (ledger, D9): its
  tools, its bundled skills and its bundled agents.

## A plugin is a value

`Plugin` (`packages/harness/src/tools/plugins.ts`) is one record:

| Field          | What it contributes                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | Stable, persisted: the switch key, the plugin an offered tool records, and the `resources/plugins/<id>/` directory. Never reused.    |
| `tools`        | Its tools by registered name. Each tool belongs to exactly one plugin.                                                               |
| `availability` | The probe of an external dependency; its tools are withheld while the dependency is missing.                                         |
| `toggle`       | A user switch and its first-install position. A switched plugin must have `availability` (`ALWAYS_AVAILABLE` when nothing to probe). |
| `injectedWhen` | Tools offered to every agent with tools while the plugin (and an optional boolean setting) is on.                                    |
| `continuation` | What a parked run does next (built-ins only, `defineBuiltinPlugin`). At most one plugin in a list continues parked runs.             |
| `prompt`       | One `PromptSection` of each request's system text.                                                                                   |
| `processLayer` | Process-lifetime services, up while the plugin is on or a step pins it; its `drain` runs in the shutdown protocol.                   |
| `sessionLayer` | Session-lifetime services, one build per open session; work that outlives its step holds it with `PluginHold`.                       |
| `decision`     | Its side of a decision on a pending request of the kind it owns (`RequestDecisionHook`).                                             |
| `arms`         | The row kinds it owns, written as `plugin.fact` through the one publisher.                                                           |
| `agentBlock`   | The one top-level block of an agent file it owns (`AgentBlock`).                                                                     |

Tools are plain values: `defineTool` (`packages/harness/src/tools/core/definition.ts`)
returns a `DefinedTool` with its definition, execution flags, `guard` and
`call`. An app writes a plugin with `definePlugin`, which checks at compile
time that a tool needing a service is served by one of its plugin's own
layers, then erases that type. Authors import all of this from
`@texra-ai/harness/plugins` (`packages/harness/src/plugins.ts`).

`toolTable` (`packages/harness/src/tools/toolTable.ts`) builds the process's
`ToolTable` from the ordered plugin list and refuses a defective list when it
is built: a malformed or repeated id, a tool name claimed twice, two
continuations, two decision hooks for one request kind, an agent-file key
owned twice or equal to a persona key, or a switch without a probe. The
`ToolRegistry` service holds the table; `pluginCatalogLayer`
(`packages/harness/src/tools/pluginCatalog.ts`) builds it, and the tool
catalog over it, from the list an entry passes to `processLayer`.

How a host shows a plugin is not on the value. TeXRA keeps its dashboard copy
by id in `TEXRA_PLUGIN_CARDS` (`packages/texra/src/tools/pluginCards.ts`),
which the settings view's Plugins page reads.

## Harness built-ins and the app's plugins

`packages/harness/src/tools/builtinPlugins.ts` defines the built-ins and
exports `harnessBuiltins`:

- `file-ops`: `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
  (an app passes the `WriteFilter` that `write_file` applies);
- `web`: `web_search`, `web_fetch`;
- `memory-workflow`: `memory` (injected while memory is on) and
  `executions`, with a prompt section;
- `goal`: the `plan` tool, the parked-run continuation, and the `goal/state`
  arm;
- `multi-agent`: the `agent` tool, which runs a named agent as a child run;
- `codemode`: the `script` tool, whose session layer is the QuickJS code
  sandbox the scripts run in.

TeXRA's list is `texraPlugins` (`packages/texra/src/tools/registry.ts`): the
built-ins with TeXRA's options beside the app's own plugins (LaTeX, arXiv,
Wolfram, Zotero, Lean 4, GitHub subscriptions, external inquiry, Codex,
Claude agent, `core`, `setup`, `copilot`, `documents`), in dashboard order.
Nothing in the harness names an app plugin; `pluginBoundaryRatchet`
(`src/test-kernel/architecture/pluginBoundaryRatchet.vitest.ts`) holds that
line. The VS Code host passes `copilot` its process layer, which exposes the
research tools of the plugins that are on to Copilot.

## Agent-file blocks

A plugin may own one top-level block of an agent file (`Plugin.agentBlock`:
a `key`, a Zod `schema`, and an optional `result` describing how its runs
read to whoever launched them). The catalog scan checks the block against the
schema and keeps the parsed value on the entry (`AgentEntry.blocks`); a file
whose block fails, or that carries a key no listed plugin owns, is refused
like any other invalid definition. The plugin reads a block with
`agentBlockOf`. An agent carrying a block is a task: it declares no tools and
runs only through a launch its plugin builds (a `script` of kind `recipe`).
The harness reads nothing inside the block. The one owner today is the
documents plugin's `task:` block (`DOCUMENT_TASK_BLOCK`).

## The tool catalog and the step

- **The catalog** (`ToolCatalog`, `packages/harness/src/tools/liveTools.ts`).
  Built-in plugins are on while their switch is (one with no switch always
  is); the switches live in the global state store and reach the catalog as
  a stream, so a flip in any process sharing that state applies at once. A
  plugin's `processLayer` is up once per process while it is on or a step
  uses it. Every resource is an `RcMap` entry in its lifetime's scope.
- **A session's catalog** (`sessionTools`,
  `packages/harness/src/tools/sessionTools.ts`), one per project in that
  session's scope, owns the project's plugin session layers and its MCP
  servers, and pins each step's tools.
- **The step** (`packages/harness/src/agent/runtime/loop/step.ts`). Each model
  request opens a step, and so does a park. It applies the switches and the
  enabled, trusted installed plugins, pins the current generation, and
  resolves the offered tools (`resolveStepTools`,
  `packages/harness/src/agent/runtime/agentToolResolution.ts`), the
  continuation, the hooks and the prompt sections of the plugins it pinned.
  The pin is held hand over hand, so a response's calls run against the tools
  its request offered. When the offered set, continuation, hooks or rendered
  context differ from the run's last record, the step returns a
  `tools.offered` row (each tool's name, digest, plugin and revision), which
  the loop appends through the run's one writer before the request.
- **Stale calls.** A call to a tool that left or changed since its request
  settles as `tool_unavailable` and the turn continues.
- **Resume.** A resumed run's first step offers the recorded tools that are
  still in the catalog with the same identity (digest of name and input
  schema, plugin id and revision) and names each one gone or changed. Later
  steps are live again. A description change is recorded as a new offered set
  and is not part of identity.
- **Children.** A child launched by the `agent` tool is narrowed to what its
  parent's step offered (`parentOffered`), with the same identity; a child
  naming an MCP server none of whose tools its parent was offered is refused
  before it starts (`childToolRefusal`).
- **Resume blockers.** A run whose agent is missing, or whose agent comes
  from an installed plugin that is off or untrusted, stays interrupted with a
  `ResumeBlocker` of kind `agentMissing`, `pluginOff` or `pluginUntrusted`
  (`packages/harness/src/agent/runtime/resumeBlocker.ts`) and resumes when the
  catalog has it back. A switched-off tool plugin is not a blocker; its tools
  are withheld.

## MCP servers

The user's stdio servers come from `~/.texra/mcp.json` in the `.mcp.json`
shape (`packages/harness/src/tools/mcp/mcpConfig.ts`, parsed by
`packages/harness/src/common/plugins/mcpServers.ts`). An entry that does not
validate is skipped and the resolving run's transcript says why.

- An agent gets a server's tools by naming `mcp__<server>__<tool>` or
  `mcp__<server>__*` in its `tools:`. A run that names none reads no file and
  starts no server. Each server is plugin `mcp:<server>`.
- A server process is keyed by its spec (command, args, env names), a keyed
  digest of its env values (so values never enter a row but an edit is a new
  revision), and the project's `.env`. It runs in its project's session pool
  (`projectServers`), shared by that project's runs, kept 30 minutes past its
  last holder and stopped with the session; no server is shared across
  projects.
- The client is the harness's Effect JSON-RPC connection
  (`packages/harness/src/tools/jsonRpc.ts`, newline framing), spawned through
  `effect/process` (`packages/harness/src/tools/mcp/mcpServer.ts`).
- Every MCP call goes through the one approval authority: the loop's guard
  (`guardedToolCall`, `packages/harness/src/agent/runtime/loop/toolGuard.ts`)
  routes it to `requestBashApproval`. MCP tools are never parallel-safe, and
  are replay-safe only when the server marks them read-only or idempotent.
- A server that fails to start yields no tools and a transcript warning; the
  run still opens.

Not read: a project-level `.texra/mcp.json` (a checked-in file that spawns
processes needs a trust prompt first). Remote MCP transports are not built
(owner: stdio only for now).

## Installed plugins

Claude Code and Codex plugin directories (`.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, with `skills/`, `commands/`, `agents/`,
`.mcp.json` beside them) install from git, a local path or a marketplace
(`packages/harness/src/common/plugins/`). Enabling one asks the user to trust
it as it is: the decision covers its version and a digest of every file it
ships, each MCP server's spec and env values, and the scripts its hooks run
(`pluginTrust.ts`, `pluginDigest.ts`); a changed digest asks again. An
enabled, trusted plugin contributes its MCP servers, skills and agents
(source `plugin`, named `<plugin>:<name>`). Its Claude Code command hooks run
out of process, never in the harness process (`pluginHooks.ts`), at the run
loop's points (`packages/harness/src/agent/runtime/loop/hooks.ts`), and each
outcome is a `hook.outcome` row ([code plugins and hooks](./2026-09-28-code-plugins-hooks-v1.md)).
A plugin with LSP servers is refused.

## Other contribution lists

The same rule (static data, stable id, installed once, no runtime register or
unregister) covers:

- **Model providers.** `MODEL_PROVIDER_PLUGINS`
  (`packages/llm/src/providers/providerPlugins.ts`), one descriptor per
  provider.
- **CLI slash commands.** `installSlashCommands`
  (`packages/cli/src/chat/tui/commands/slashRegistry.ts`) installs the
  contributions built in `registerBuiltins.tsx` and throws on a duplicate
  plugin id, name or alias.
- **Skill sources.** `packages/harness/src/skills/skillSources.ts` folds
  `SkillSourceContribution`s by tier; a tool plugin's bundled skills are at
  `resources/plugins/<id>/skills` and its switch gates them.
- **Bundled agent directories.** A tool plugin's bundled agents are at
  `resources/plugins/<id>/agents`, installed by
  `installPluginAgentDirectories`
  (`packages/harness/src/agent/index/BundledAgentDirectories.ts`); they are
  `builtIn`-source agents in the same YAML, listed while the plugin is on.

## What is deliberately core

These are not plugin surfaces; opening one needs its own owner decision.

- **Agent sources.** The agent catalog
  (`packages/harness/src/agent/index/agentCatalog.ts`) scans the custom
  directory, the bundled directories and the loaded plugins, in one YAML
  format. A plugin adds directories or one owned block, not an agent kind or
  a second loader.
- **The run loop.** `packages/harness/src/agent/runtime/loop/toolUse.ts` is
  the only run program. A plugin adds no step, node, task kind or wait; its
  loop inputs are its continuation, prompt section and hooks.
- **The run history.** `RunCell.append` (from `RunHistory.open`,
  `packages/harness/src/shared/session/runHistory.ts`) is the one writer of a
  run's rows, and the session log's `transact` the door for every other row.
  A plugin's own rows are typed `plugin.fact` arms in the one closed schema;
  the store checks each row against its arm and keeps a row whose arm this
  build lacks unread.
- **Approval authority.** One approval queue and policy, pinned by
  `src/test-kernel/architecture/approvalPolicyAuthorityRatchet.vitest.ts`.
  Plugin tools, MCP included, request approval through it.

## Refused designs

- A manifest file format of our own, and runtime register/unregister.
- Task kinds and per-kind hooks; `toolUse.ts` stays the only run program.
- `@modelcontextprotocol/sdk` (a Promise client inside an Effect layer) and
  `McpSchema` with `RpcClient` as the MCP client.
- A `SkillSources` service and per-composition skill grouping.
- A run-pinned `Composition` and a `Compositions` map: setup changes apply at
  every step boundary and are recorded.
