---
created: 2026-09-24
status: implemented — #13083, #13084, #13088, #13089, #13090, #13092, #13093, #13094, #13111, #13114
---

# The plugin architecture: plugins as data, a pinned composition per run

This note describes how plugins work on `main` as of 2026-09-24. It is the
owner of the topic; the rulings it relies on are in the
[architecture rulings ledger](./2026-08-01-architecture-rulings-ledger.md), and
the [Effect-native runtime system design](../../proposed/architecture/2026-09-10-effect-native-runtime-system-design.md)
records how this departs from the `ToolRegistry` it proposed.

## Owner rulings

Four owner decisions (2026-09-23 and 2026-09-24) frame the work:

- **Everything is a plugin.** Each extensible subsystem gets a typed
  contribution list keyed by a stable plugin id, installed by code at
  startup. The rulings ledger records this in the amendment to "`defineTool`'s
  default `R` is frozen SDK surface", which also opened the SDK tool contract
  to change.
- **No new formats.** Plugins are TypeScript data in the tree, not a manifest
  file format. The one user-authored input, MCP servers, reuses Claude Code's
  `.mcp.json` shape. Agents stay YAML, skills stay `SKILL.md`.
- **Effect unstable modules are allowed** for this work. The MCP client spawns
  servers through `effect/unstable/process` (`src/tools/mcp/mcpServer.ts`).
- **LOC is not the gate.** Several PRs in this line net-add lines (#13089 +76,
  #13093 +179, #13094 +52); each states what it removed instead.

## Plugins are data with stable ids

`src/tools/plugins.ts` holds `TOOL_PLUGINS`, one list of
`{ id, toolNames, name, category, description, availability?, injectedWhen?, layer?, skills?, ... }`
(#13084). It imports no tool implementation. Every tool belongs to exactly
one plugin; two hidden plugins, `core` and `setup`, own the tools no dashboard
card lists. The ids are the persisted toggle keys. From this one list the
tree derives the dashboard items for all three hosts, the probe set
(`src/tools/pluginAvailability.ts`, `src/tools/toolProbes.ts`), first-install
toggle seeding, install and auth actions, and the `texra tools` guides.

Tools themselves are plain values (#13083): `defineTool` returns an object
with `definition`, execution flags, `guard` and `call`. `BaseTool` is deleted,
and the SDK exports `DefinedTool`.

`src/tools/registry.ts` maps plugin id to `{ toolName: tool }` and builds
`TOOL_TABLE` from it. `satisfies` checks against the manifest make these type
errors: a missing or extra tool name, an unknown or duplicate plugin id, a
tool name claimed by two plugins, empty `toolNames`, and a toggleable plugin
without `availability`.

## The live catalog and the step

Superseded on 2026-09-27: the owner ruled that setup changes apply live at
every step boundary and are recorded
([core concepts](../../proposed/architecture/2026-09-26-core-concepts.md),
"Central primitives" and invariants 6 and 7). The `Composition` value, the
`Compositions` `LayerMap` and the run-lifetime pin are deleted; tools are the
first kind on the two central primitives.

- **Registry** (`src/tools/liveRegistry.ts`). A generic generational
  catalog: `contribute(owner, entries)` adds entries until the caller's
  scope closes, every change rebuilds one immutable generation published on
  `current` (a `SubscriptionRef`), a name another owner holds is refused
  with `RegistryConflict`, and an owner's later contribution supersedes its
  earlier one while both are open. `pin` holds a generation for the
  caller's scope; generations are refcounted by digest in an `RcMap`, so a
  generation no one pins drains even after `current` moved on.
- **The tool catalog** (`LiveTools`, `src/tools/liveTools.ts`). Each
  built-in plugin contributes its manifest table while its switch is on;
  `sync(disabled)` opens or closes those contributions, so toggling a plugin
  changes `current`. Each loaded MCP server contributes the tools it listed
  while some run holds it (`hold`, refcounted per spec and revision, so runs
  naming one server share one process). Every entry carries its identity:
  the sha256 of its definition as the model is shown it (name, description,
  schema) and its plugin's revision (a digest of the plugin's tools for a
  built-in, the keyed env revision for MCP). Plugin layers are built per
  pinned generation through one `MemoMap`, so generations that share a
  plugin share one build of its layer.
- **Step** (`src/agent/runtime/loop/step.ts`). Every model request opens a
  step: it syncs the switches from the run's global state, pins the current
  generation (hand over hand: the previous step's pin closes once the new
  one holds), and resolves the offered tools from it
  (`resolveStepTools`, `src/agent/runtime/agentToolResolution.ts`: declared
  tools, MCP expansion, probes, host and approval gates, injections,
  delegation annotation, the run's own tools). When the offered set differs
  from the run's last record, the step returns a `tools.offered` row (each
  tool's name, digest, plugin and revision), which the loop appends through
  `RunHistory.appendBatch` before the request. A fresh run records its first
  set in its opening batch.
- **Stale calls.** A response's calls run against the step that offered
  them, restricted to the tools whose identity still matches the latest
  `tools.offered` row. A call to a tool that left or changed settles as
  `tool_unavailable` and the turn continues.
- **Resume.** The first step a resumed activation opens offers the recorded
  tools that are still in the catalog as the same tool, in recorded order,
  and names each one gone or changed (warn log and transcript). Later steps
  are live again. A missing tool is still a loud warning, not a blocked run.
- **Children.** A delegated child receives what its parent's step offered
  (`ToolPolicy.parentOffered`) and is narrowed to those names with the same
  identity, on the same catalog; a child naming an MCP server none of whose
  tools its parent was offered is refused before it starts
  (`childToolRefusal`). A resumed child is held to its own record.
- **Round mode.** A workflow agent's rounds open no step and offer no tools.

The continuation policy is still chosen once, when the loop is set up, from
the plugins switched on then.

**Ruled 2026-09-30 (ledger, "Plugin gating, presets..." and "SDK and typed
RPC"):** the extension mechanism is hooks and data plugins. Typed-RPC code
plugins, `History.writer`, an open schema registry and a `PluginModule`
interface are not built until a named plugin cannot be MCP + hooks + data.

## Loadable plugins: MCP servers

Local stdio MCP servers from `~/.texra/mcp.json` are the first loadable plugin
kind (#13092). `src/tools/mcp/mcpConfig.ts` validates the file with Zod; an
invalid entry is skipped and the resolving run's transcript says why. Each
server becomes a `LoadedPlugin` with id `mcp:<name>`, a `spec` and an
`acquire`, loaded through `mcpPluginLoader` in `src/tools/registry.ts`.

- An agent gets a server's tools by naming `mcp__<server>__<tool>` or
  `mcp__<server>__*` in its YAML `tools:`. A run that names no MCP tool reads
  no file and starts no server.
- A hold is keyed by the spec (command, args, env names) and a revision: an
  HMAC of env values under a per-process key, so values never enter a row
  but an edit still yields a new revision. Open runs keep the old server;
  runs naming the same spec and revision share one process, which stops
  with the last run holding it.
- The client is the repo's Effect JSON-RPC connection (`src/tools/jsonRpc.ts`,
  moved from the Lean code, with newline framing and a `ping` answer).
- Every MCP call goes through the one approval authority: the tool declares a
  `guard.bash` string, so `guardedToolCall`
  (`src/agent/runtime/loop/toolGuard.ts`) routes it to `requestBashApproval`
  (`src/tools/approval/bashApproval.ts`). MCP tools require approval, are
  `slow`, and are not `parallelSafe`.
- A server that fails to start yields no tools and a transcript warning; the
  run still opens.

Deferred: project-level `.texra/mcp.json` (needs a content-hash trust prompt),
HTTP/SSE transports, `tools/list_changed`, resources/prompts/sampling, and a
dashboard card for servers.

## Other contribution lists

The same rule (static data, stable id, installed once, no runtime register or
unregister) now covers:

- **Model providers** (#13094). `MODEL_PROVIDER_PLUGINS` in
  `src/shared/constants/modelProviderPlugins.ts` merges seven per-provider
  tables into one descriptor per provider. Compile-time checks fail the build
  when an llm-zoo provider lacks a `compatibilityKey` or a stated `baseUrl`.
  Wire protocols, key redaction patterns and state keys stay core.
- **CLI slash commands** (#13093). `installSlashCommands` in
  `packages/cli/src/chat/tui/commands/slashRegistry.ts` installs the
  contributions built in `registerBuiltins.tsx` and throws on a duplicate id,
  name or alias.
- **Skill sources** (#13114). `src/skills/skillSources.ts` folds
  `SkillSourceContribution`s by tier from a fixed table; the fold stamps the
  scope, so a contribution cannot choose one. `ToolPlugin.skills: true` lets a
  tool plugin ship skills: lean4's five Lean skills live in
  `packages/extension/resources/plugins/lean4/skills/`, passed to
  `hostSkillContributions` from `src/platform/defaults/nodeHost.ts`. Ruled
  2026-09-30 (D9): plugin skills and agents are gated by the plugin's switch;
  until that lands, they are not.
- **Bundled agent directories.** `ToolPlugin.agents: true` lets a tool plugin
  ship bundled tool-use agents: lean4's five Lean agents live in
  `packages/extension/resources/plugins/lean4/agents/`. The host bootstrap
  installs those directories with `installPluginAgentDirectories`
  (`src/agent/index/BundledAgentDirectories.ts`), and the `builtInToolUse`
  scan pools them with the core directory. They are the same YAML in the same
  persisted source, so agent keys do not change and no agent source is added.

- **Continuation at idle.** `ToolPlugin.continuation: true` declares that a
  plugin decides what a parked tool-use run does next; `PLUGIN_CONTINUATIONS`
  in `src/tools/registry.ts` holds its policy, and a `satisfies` check keeps
  the table and the manifest flags in step. A step pins the continuation of
  the plugins it found switched on (#13387), so a switched-off plugin applies
  at the next step; with none on, the run parks. The `goal` plugin (the `plan`
  tool) is the one contributor. The loop still owns the queue, the child
  check and `stopAfterCycle`; the policy only answers "another turn, or
  park?".
- **Prompt sections** (amended 2026-09-28, ledger "Plugins own typed tables at
  their seams"). `ToolPlugin.promptSection: true` lets a plugin add one
  `(ctx) => string` section to a request's system text, from
  `PLUGIN_PROMPT_SECTIONS`, consulted only for plugins the step pinned.
  `memory-workflow` is the one contributor.
- **Process and session layers.** `processLayer: true` (one entry in
  `PLUGIN_PROCESS_LAYERS`, GitHub subscriptions and their delivery drain),
  `sessionLayer: true` (`PLUGIN_SESSION_LAYERS`, the Codex and Claude session
  registries, one per open session) and `hostLayer: true` (the VS Code
  host's Copilot tools) declare the plugin's resources. Each is up while the
  plugin is switched on or a step pins it.
- **Event arms.** `rows: true` declares row kinds of its own: an arm in
  `PLUGIN_EVENT_ARMS` (`src/tools/pluginArms.ts`), written as a `plugin.fact`
  through the one publisher (goal state is the one contributor). The store
  checks each row against its arm and keeps a row whose arm this build lacks
  unread.

## What is deliberately core

These are not plugin surfaces, and a proposal to open one needs its own owner
decision:

- **Agent sources.** Agents are one unified YAML format loaded by
  `src/agent/runtime/agentLoad.ts` from its fixed sources (bundled
  `packages/extension/resources/agents/`, user, remote). A plugin-contributed agent kind would be a second
  format and a second loader for the same thing. A plugin's bundled agents
  (above) add directories to the existing `builtInToolUse` source, not a
  source or a kind.
- **The rest of the system prompt.** `src/agent/prompt/PromptBuilder.ts` owns
  it, and a plugin's section (above) is consulted only for the plugins the
  step pinned, so what a request sends follows the offered set the step
  records.
- **The run loop.** `src/agent/runtime/loop/toolUse.ts` is the only run
  program (workflow agents run it in round mode since the one-run-program
  series). v1 plugins have no task kinds, so a plugin cannot add a step, a
  node or a wait; its one loop input is the continuation table.
- **The run history.** `appendBatch` on the run history
  (`src/shared/session/runHistory.ts`) is the one writer of run rows, and the
  session's one publisher (`SessionEvents`) the one writer of every other
  row. A plugin owns no second channel: its own rows are typed `plugin.fact`
  arms in the one closed schema (amended 2026-09-28), and the offered-tool
  record is the `tools.offered` row.
- **Approval authority.** One approval queue and policy, pinned by
  `src/test-kernel/architecture/approvalPolicyAuthorityRatchet.vitest.ts`.
  Plugin tools, MCP included, request approval through it rather than
  carrying their own.

## Prior art: what was adopted and what was rejected

Adopted from pi Pico5:

- stable plugin ids, used as persisted keys;
- tool names unique across plugins, a clash failing loudly (here at compile
  time for the static table, at startup for slash commands and skill sources);
- code re-registers everything at startup, and contribution registries are
  rebuilt rather than mutated;
- the run pins its composition, a child joins its parent's, and a changed
  composition builds beside the old one with refcounted revisions;
- resume offers what was recorded and is still available, loudly naming what
  is gone (adapted in #13088 to a model-visible error result).

TeXRA's own ruling, not taken from Pico5: no task kinds, and plugin state
only as typed arms of the one event schema. Pico5 has task kinds, hooks per
kind, and Documents. The v1 "no hooks" half is superseded: a third-party code
plugin's command hooks run out of process over the Claude Code hooks protocol
(#13481, `2026-09-28-code-plugins-hooks-v1.md`), and the 2026-09-30 ruling
(D11) makes hooks and data plugins the extension mechanism. That is not a
task-kind mechanism or per-kind hooks, which stay refused, and `toolUse.ts`
stays the only run program. The continuation policy and the documents
plugin's after-turn handler are single-contributor hooks in Pico's terms.

Adopted from deepseek-harness: presets reduced to data (the `Composition`
value, so a named preset can later be a stored composition) and the
`mcp__<server>__<tool>` naming scheme.

Rejected:

- `Composition.skills`, a `SkillSources` service, and select-only/except
  grouping of skill roots (#13114); claiming Lean skills by name in the shared
  bundled root instead of moving them;
- the Lean pool as a plugin layer (#13090);
- an idle TTL on the `Compositions` map, `Layer.fresh` on plugin layers, and
  per-composition plugin layers;
- `@modelcontextprotocol/sdk` (a Promise client inside an Effect layer) and
  `McpSchema` with `RpcClient` (needs a custom stdio protocol and still does
  not answer server requests) for the MCP client (#13092);
- a manifest file format and runtime register/unregister.

Gating plugin skills and agents, left open here as a separate owner decision,
is ruled (D9, 2026-09-30): they are gated by the plugin's switch, not by a
run-pinned composition (which #13364 deleted).
