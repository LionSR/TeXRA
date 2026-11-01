---
created: 2026-11-01
status: proposed
---

# The tool layer: one catalog, one step pin, one tool contract

Measured 2026-11-01 at `origin/main` `143735cd8d`. Paths are relative to
`packages/harness/src` unless they start with `packages/`, `src/` or
`config/`; line counts are `.ts` files, tests excluded; a consumer count is
the number of files that name the identifier (word match) under
`packages/*/src` and `src/test-kernel`. This note is the general-package
design's lane 4b
([harness general-package design](./2026-10-21-harness-general-package-design.md),
"Plugin contract" and "Lane 4b therefore starts with the fence itself") and
the seventh problem of the peer comparison
([harness design by Ousterhout's criteria](../../implemented/architecture/2026-10-30-harness-design-against-pi-durable-and-deepseek.md),
"Already designed elsewhere"; its evidence note
[texra.md](../../evidence/2026-10-30-harness-design-against-pi-durable-and-deepseek/texra.md),
item 7, and the dsh note
[deepseek.md](../../evidence/2026-10-30-harness-design-against-pi-durable-and-deepseek/deepseek.md),
8.4). Both bind unless the code refutes them; where it does, this note says
so, in "What the code refutes" at the end of section 3.

## Summary

The tool layer is four values of three lifetimes and one type alias: the
plugin table (`ToolRegistry`, process, static), the catalog over it
(`ToolCatalog`: the switches and the plugins' process layers), one session's
half of it (`SessionTools`: the plugins' session layers and the project's
MCP servers), and the step's pin (`StepTools`); `RuntimeToolRegistry` is the
type of the pin's map. Three lifetimes are what the plugin contract promises
(`processLayer`, `sessionLayer`, a pin per step), and dsh keeps the same four
stages (a global layer, an agent layer, `resolve()` per step, `executable()`
per call). What is duplicated is not a layer but the contracts: a second tool
type (`RuntimeTool`, whose only difference from `ITool` is `Runs` in its
requirement), a second plugin constructor (`defineBuiltinPlugin`, the same
cast as `definePlugin`), two public names for one services union
(`CallServices`, `PluginToolServices`), and a cast from the public run to the
engine's (`sessionOf`). The second call contract, `RunCall`, is not
duplication: eight of the fourteen built-in tools are engine code that reads
the session, the runs, the open step or the script door through it, and the
app's tools read none of it (0 of 98 files under `packages/texra/src/tools`
import a harness internal).

The recommended design (B in section 4) deletes the pass-through contracts,
moves `Runs` behind the engine door so one tool type serves every tool, and
keeps `RunCall` as that door, the three lifetimes as they are, and no
`builtins/` directory. It removes about 30 source lines and 6 ratchet or
report rows in one PR, far below the framing notes' estimates, which counted
moved code as deleted. Design A, the evidence note's sketch (one process
`Catalog`, `RunCall` as a field of `ToolContext.env`), is measured and
refused: its catalog merge is a rename on an edge the layer-names ratchet
freezes and would serve every run the switch door; its door move is the
hand-provided null the Effect rules forbid, for about 20 lines.

The decision asked of the owner: approve design B as one PR (decisions 1 to
3 in section 7), and decide whether the `builtins/` fence is built now at its
measured cost (decision 4; recommended: no).

## What gets deleted

Counted only where the code vanishes; code that changes module or name is
"moves, 0".

| What goes                                                                                               | Where                                                                             | Lines    | Consumers                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `RuntimeTool` alias (`ITool` with `R = ToolServices`)                                                   | `agent/runtime/ToolServices.ts:168`                                               | 1        | 9 harness files, 4 test files, retyped to `ITool<Error, PluginToolServices>`                                      |
| `RuntimeToolRegistry` alias                                                                             | `ToolServices.ts:169-170`                                                         | 2        | `agentToolResolution.ts:45,335`, `agent/runtime/run/tools.ts:10,65,134`; 1 test                                   |
| `ToolServices` union (`PluginToolServices \| Runs`)                                                     | `ToolServices.ts:165-167`                                                         | 3        | `toolGuard.ts:51,160`, `RunCall.ts:44,217`, `tools/plugins.ts:27,178`, `tools/memory/MemoryTool.ts`; 4 test files |
| `CallServices` as a second public name for `PluginToolServices`                                         | `ToolServices.ts:43-49` (the body moves), `packages/harness/src/plugins.ts:143`   | 4        | `ToolServices.ts:64,163`; the app names only `PluginToolServices` (3 files)                                       |
| `defineBuiltinPlugin` and the `C` parameter of `PluginDefinition`                                       | `tools/plugins.ts:155,159,176-179`                                                | 5        | `tools/builtinPlugins.ts:24,48`; `src/test-kernel/support/setupPlatform.ts:39,91`                                 |
| the `builtin` alias of it                                                                               | `tools/builtinPlugins.ts:43-48`                                                   | 6        | 6 plugin values in the same file                                                                                  |
| `sessionOf` (a cast from `ToolRun` to the engine's run)                                                 | `agent/runtime/RunCall.ts:231-237`                                                | 7        | `tools/approval/bashApproval.ts:40`, `toolEditApproval.ts:85`, `agent/runtime/loop/toolGuard.ts:230`              |
| the three `yield* Runs` in a tool body                                                                  | `tools/ExecutionsTool.ts:349,418,443`                                             | 3        | replaced by reads of the door's `runs`                                                                            |
| the `Runs` re-provision inside the child door                                                           | `ToolServices.ts:133,136-137`                                                     | 3        | the door reads `runs` off the call                                                                                |
| the child-door test layer over `Runs`                                                                   | `src/test-kernel/support/nativeToolTestLayer.ts:126-132`                          | 4        | becomes `Layer.succeed(ChildRuns)(childRuns(runCall))`                                                            |
| `tools->agent` names `runRegistry#Runs`, `ToolServices#{PluginToolServices, RuntimeTool, ToolServices}` | `config/ratchets/harness-layer-names-baseline.json`                               | 4 rows   | shrunk with `-u` in the same PR                                                                                   |
| `ToolServices.ts: 1` (the undocumented `RuntimeTool`)                                                   | `config/ratchets/core-quality/undocumented-exports.json:26`                       | 1 row    | `--update`                                                                                                        |
| `CallServices` line; `definePlugin` and `PluginDefinition` signatures simplify                          | `config/api-reports/harness.plugins.api.md:24,34,70`                              | 1 line   | `--update`; `packages/harness/docs/api/plugins.md` regenerates                                                    |
| `RunCallShape` and its fields                                                                           | `RunCall.ts:191-221`                                                              | moves, 0 | gains `runs`                                                                                                      |
| `ToolServices.ts` as a file (`ChildRuns`, `childRuns`, `RunServices` stay)                              | `ToolServices.ts`                                                                 | moves, 0 | the evidence note counted its 129 lines (now 170) as a deletion                                                   |
| `agentToolResolution.ts` (nothing in it is a layer; see section 3)                                      | `agent/runtime/agentToolResolution.ts`                                            | 0        | the evidence note's "part of `agentToolResolution`"                                                               |
| `ProcessCatalog`, `ToolStep`, `ResolvedTools`, `OpenStep`                                               | `tools/sessionTools.ts:42-99`, `step.ts:86-102`, `agentToolResolution.ts:332-338` | 0        | kept; section 6 says why                                                                                          |

Vanishing: 38 source and test lines, 6 ratchet or report rows. Added by the
same PR: the `runs` field on `RunCallShape` with its comment (3 lines) and a
`Runs` provision from the door at the four engine launch sites that reach a
launch internal which still reads `Runs` from context (`tools/bash.ts:494`,
`tools/codemode/SelfTool.ts:215`, `tools/codemode/backgroundScript.ts:101`, and the
script door hand-off at `agent/runtime/loop/toolUseDispatch.ts:1072`; 4 lines). Net about
−30 lines.

## The current shape, measured

### The tool-set layers

| Layer                                                          | Module                                                                  | Lines | Exported names                                                                                                                                                                                                                          | Consumers                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolRegistry`: the process's plugin table, static             | `tools/toolTable.ts:262`                                                | 264   | 13: `toolTable`, `ToolTable`, `ToolRegistry`, `PluginHold`, `AgentBlock`, `AgentBlockResult`, `agentBlockOf`, `RecipeChange`, `PromptSection`, `RequestDecisionHook`, `PluginLayerServices`, `ProcessPluginLayer`, `SessionPluginLayer` | named in 20 harness files, 2 app files and 1 host file; read at 9 sites: `agentToolResolution.ts:121`, `AgentLaunchContext.ts:138`, `agent/runtime/loop/toolUseDispatch.ts:544`, `recipeResult.ts:41`, `agent/index/agentYamlScanner.ts:86`, `tools/toolAvailability.ts:142`, `controllers/session/sessionLayer.ts:156`, `Database.ts:257,1045` |
| `ToolCatalog` and `ToolCatalogOwner`: switches, process layers | `tools/liveTools.ts:89,101`, layer `:119`                               | 236   | 4: `ToolCatalog`, `ToolCatalogShape`, `ToolCatalogOwner`, `toolCatalogLayer`                                                                                                                                                            | `ToolCatalog` in 14 harness files, 3 app controllers and `packages/cli/src/runtime/tools.ts:18` (the host door: `processServices`, `setEnabled`, `disabled`); `ToolCatalogOwner` in `liveTools.ts`, `sessionLayer.ts:175,631` and one test support file                                                                                         |
| `SessionTools`: one project's session layers and MCP servers   | `tools/sessionTools.ts:66`, `pinStep` `:174`, `sessionTools` `:266`     | 309   | 7: `ToolStep`, `SessionTools`, `ProcessCatalog`, `buildPluginLayer`, `follow`, `NONE`, `sessionTools`                                                                                                                                   | `SessionTools` 4 files; `ToolStep` 2 (`agent/runtime/loop/step.ts`, `requestPolicy.ts:211`); `ProcessCatalog` 2 (`liveTools.ts:181`, `sessionTools.ts`)                                                                                                                                                                                         |
| `StepTools` and `OpenStep`: the step's pin                     | `agent/runtime/loop/step.ts:74,90`, `openStep` `:184`, `stepFor` `:421` | 479   | 5: `StepTools`, `OpenStep`, `stepFor`, `offeredBy`, `resolveActivations`                                                                                                                                                                | `StepTools` in `agent/runtime/loop/toolUseDispatch.ts:127,1031`, `agent/runtime/loop/hooks.ts:395`, `agent/runtime/delegation/delegationAvailability.ts:57`; `run.steps` read at `ModelInvoker.ts:349`, `agent/runtime/loop/rows.ts:168`, `agent/runtime/loop/hooks.ts:280`                                                                     |
| `RuntimeToolRegistry`: the type of the pin's map               | `agent/runtime/ToolServices.ts:170`                                     | 170   | 9 in the file: `RunServices`, `CallServices`, `ChildRunsShape`, `ChildRuns`, `childRuns`, `PluginToolServices`, `ToolServices`, `RuntimeTool`, `RuntimeToolRegistry`                                                                    | the alias: `agentToolResolution.ts:335` (`ResolvedTools.registry`), `agent/runtime/run/tools.ts:65,134`; `RuntimeTool`: 9 harness files, 4 tests                                                                                                                                                                                                |

Beside them: `agent/runtime/agentToolResolution.ts` (376 lines; below) and
`tools/catalogEntries.ts` (193: `ToolEntry`, `entriesOf`, `mergeEntries`,
`toolDigests`, `toolDefinitionsFor`, `sentDefinitions`, `HeldPlugins`). The
seven modules are 2,027 lines.

The evidence note's "five tool-set layers" counts one static table, one
process catalog served under two tags, one session catalog, one step pin and
one type alias. The first four hold resources of three lifetimes, which is
the minimum for the lifetimes `Plugin` promises (`processLayer`,
`tools/plugins.ts:132`; `sessionLayer`, `:135`; the per-step pin,
`agent/runtime/loop/step.ts:1-15`). The dsh note (8.4) describes the same count: a global
layer, an agent layer, a frozen set per step, a lookup per call.

### The two contracts

**`ITool` against `RuntimeTool`.** `ITool<E = Error, R = never>` is the
contract (`agent/core/tools/ToolTypes.ts:78-155`, 11 members).
`RuntimeTool<E = Error, R = ToolServices> = ITool<E, R>`
(`ToolServices.ts:168`) changes only the default requirement:
`ToolServices = PluginToolServices | Runs` (`:167`),
`PluginToolServices = CallServices` (`:163`),
`CallServices = RunServices | ToolContext | WorkspaceFs | StorageFs | Scope.Scope`
(`:48-49`). So the whole difference between a built-in's tool and a plugin's
is `Runs`. Who reads it: the compiler, at `Plugin.tools?: readonly ITool<Error, PluginToolServices>[]`
(`tools/plugins.ts:109`) against `defineBuiltinPlugin`'s
`PluginDefinition<ROut, ToolServices>` (`:177-179`); both constructors are the
one cast `erase` (`:168-169`). The table's `get` returns the plugin type
(`toolTable.ts:191`) while the catalog, the step and the loop name
`RuntimeTool` (`catalogEntries.ts:11`, `structuredOutput.ts:11`,
`tools/mcp/mcpConfig.ts:41`, `tools/mcp/mcpServer.ts:25`, `agentToolResolution.ts:44`,
`agent/runtime/run/AgentRun.ts:13`, `executeAgent.ts:14`, `agent/runtime/loop/toolGuard.ts:51`): the loop
assumes any tool may need `Runs` and provides it (`agent/runtime/loop/toolUseDispatch.ts:369`).
Two tools read `Runs` from context: `executions`
(`tools/ExecutionsTool.ts:349,418,443`) and `agent`
(`AgentToolServices = AgentRunServices | ToolContext`,
`agent/runtime/delegation/AgentTool.ts:150`; `AgentRunServices = RunServices | Runs`,
`runRegistry.ts:692`). Two launch internals read it too and run inside a
tool's call: `agent/runtime/delegation/inBandSubagentRun.ts:362` and
`nativeSubagentStrategy.ts:112`; the public door already provides it to them
(`childRuns`, `ToolServices.ts:133`).

**`ToolContext` against `RunCall`.** `ToolContext` is the public contract
(`ToolTypes.ts:224`): `ToolContextShape` has 4 members (`callId`, `env`,
`requests?`, `emit`), `ToolEnv` 4 (`roots`, `workingDirectory?`,
`stepRoots?`, `run?`), `ToolRun` 1 declared plus 8 the runtime adds by module
augmentation (`RunCall.ts:154-164`: `toolPolicy`, `config`, `model`, `scope`,
`opening`, `logger`, `parentStage`, `fileService`), `CallRequests` 2 plus 2
added (`post`, `present`, `:165-183`). `RunCall` is a `Context.Reference`
with a null default (`RunCall.ts:226`); `RunCallShape` (`:191-221`) adds, per
field and reader:

| Field                                          | What it adds                                                                     | Readers                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run: ToolRun & { session, steps, callbacks }` | the session, the open step, the host callbacks                                   | `sessionOf` at `bashApproval.ts:40`, `toolEditApproval.ts:85`, `toolGuard.ts:230`; `AgentTool.ts:268-269`; `agentChild.ts:95,272,300`; `ExecutionsTool.ts` (its `context.session`); `PlanTool.ts:96,227,281` (`config.script`, `callbacks.onProgress`) |
| `responseId`, `attempt`                        | the call's coordinates: a child run's id is derived from them                    | `agentChild.ts:80-95`, `AgentTool.ts:200`, `tools/executions/scriptCallsView.ts:46`                                                                                                                                                                    |
| `logId`                                        | the call's card, which a launched run names as `parent.call.card`                | `SelfTool.ts:182`, `backgroundScript.ts:112`, `subagentRun.ts:131`, `AgentTool.ts:535`                                                                                                                                                                 |
| `instruction`                                  | the user instruction the response answers                                        | `AgentTool.ts:387,476,484`                                                                                                                                                                                                                             |
| `facts` (#14491)                               | a live read of the run's rows, so a resumed run counts the reads its rows record | `requireFileReadForEdit`, `RunCall.ts:302`, called from `tools/fileEditFlow.ts` and `tools/memory/MemoryTool.ts`                                                                                                                                       |
| `script`                                       | the issuing script                                                               | `AgentTool.ts:324`, `SelfTool.ts:211`, `childRunBudget.ts`                                                                                                                                                                                             |
| `scriptCalls`                                  | the script door the loop builds                                                  | `ScriptTool.ts:184`                                                                                                                                                                                                                                    |
| `hook?`                                        | the `PreToolUse` answer, written by the guard (`toolGuard.ts:268`)               | `toolEditApproval.ts:89`, `proposalFlow.ts:153`, `AgentTool.ts:227`, `requestPolicy.ts:344`                                                                                                                                                            |

`RunCall` is named in 23 harness files and 0 app files. What keeps it out of
an app's tool is that `packages/harness/src/plugins.ts` does not export it and the
deep-import baseline for `texra` is empty
(`config/ratchets/harness-deep-import-baseline.json`, `hosts.texra: []`),
which `src/test-kernel/architecture/pluginBoundaryRatchet.vitest.ts:271-291`
states and probes.

**`definePlugin` against `defineBuiltinPlugin`.** Both are `erase`
(`tools/plugins.ts:168-179`). The difference is the second type argument of
`PluginDefinition<ROut, C>` (`:155`), which only the two constructors pass.
`definePlugin` is named in 11 files (5 app plugin modules); `defineBuiltinPlugin`
in `tools/builtinPlugins.ts` (through the `builtin` alias, `:48`) and one test
support file.

### `agentToolResolution.ts` by responsibility

| Lines   | Responsibility                                                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 69-72   | `asksApproval`: whether a tool may ask a person                                                                                                                                                                                                                                    |
| 80-83   | `HostCapabilities`: the service a plugin's process layer serves to say what the host can show (public on `./plugins`)                                                                                                                                                              |
| 87-108  | `StepToolInputs`: what a step resolves from, fixed at the run's open except two live flags                                                                                                                                                                                         |
| 111-114 | `declaredToolNames`                                                                                                                                                                                                                                                                |
| 117-329 | `resolveStepTools`: injected tools from settings (124-138), the probe gate (141-152), the host-capability and approval gates (170-190), MCP name expansion (195-232), the offer order (236-275), the run's own tools laid over (277-287), `sent` under script-only tools (289-321) |
| 332-338 | `ResolvedTools`: definitions, the offered map, the offered identities                                                                                                                                                                                                              |
| 342-376 | `heldToRecord`: a resumed step offers only the identities it recorded, and names the rest                                                                                                                                                                                          |

Nothing in the file is a layer or a pass-through: it is the resolution policy
and its resume rule. Its one `max-lines-per-function` row
(`config/ratchets/core-quality/max-lines-per-function.json:3`) is the
212-line `resolveStepTools`; the root `AGENTS.md` refuses a mechanical split.

### One tool call, from the offered set to the body

`runTurn` opens the step: `stepFor` (`agent/runtime/loop/step.ts:421`; a dispatch reuses
the open step, `:428-430`) → `openStep` (`:184`) → `SessionTools.pin` →
`pinStep` (`tools/sessionTools.ts:174`: built-in entries, then installed
plugins' servers, then the run's held servers, `mergeEntries` `:207-226`) →
`resolveStepTools` (`agentToolResolution.ts:117`) → `heldToRecord` (`:342`,
on a resumed activation's first step) → `describedAtFreeze`
(`agent/runtime/loop/step.ts:120`) → `pinned.services(used)` (`:227`) → the pin replaces
the previous one in `run.steps` (`:317-324`) → the `tools.offered` row when
the set changed (`:378-399`). The dispatch: `dispatchPendingResponse`
(`agent/runtime/loop/toolUseDispatch.ts:1029`, taking `step: StepTools`) → `groupsOf` →
`finishCall` (`:362`) → `step.registry.get(fact.toolName)` (`:418`) →
`callRequests` (`agent/runtime/loop/toolGuard.ts:284`) → `preToolUse` (`agent/runtime/loop/hooks.ts`) →
`guardedToolCall` (`toolGuard.ts:252`) → `answerOf` → `rejection` (`:155`:
paths, command approval through `requireRun` and `sessionOf`, `:229-234`) →
`bodyStarts` commits `tool.intent` (`toolUseDispatch.ts:459-481`) →
`tool.call(input)` (`toolGuard.ts:267`) under `ToolContext`, `ChildRuns`,
`RunCall` and the step's plugin services (`toolUseDispatch.ts:497-510`) →
`defineTool`'s `call` (`tools/core/definition.ts:99-131`: validation, error
normalization) → `execute`.

Pass-throughs (they forward only): `RuntimeTool`, `RuntimeToolRegistry`,
`PluginToolServices = CallServices`, `defineBuiltinPlugin` (an identity cast,
as `definePlugin` is), `ProcessCatalog` (eight values copied from
`toolCatalogLayer` into `sessionTools`, `liveTools.ts:181-193`), the second
tag over the one catalog object (`liveTools.ts:228-231`), `requireToolRun`
(`requireRun` plus the reference, `RunCall.ts:277-287`), `callerRun` (three
lines over `env.run`), `sessionOf` (a cast). Decisions: `toolTable` (the
list's validity, `toolTable.ts:208-259`); `toolCatalogLayer` (which plugins
are on, `onOf` and `follow`; a process layer's lifetime as an `RcMap` entry);
`pinStep` (the merge order; which layers a step builds); `resolveStepTools`
(the gates, the injection, the expansion, the overlay, `sent`); `heldToRecord`;
`describedAtFreeze`; `openStep` (when a row is recorded; the hand-over-hand
pin; the withheld warning); `stepFor` (a dispatch reuses the open step);
`childRuns` (a plugin's tool launches children of its own run and nothing
else); `guardedToolCall` (hooks, guard, approval, then the body; the `hook`
answer); `defineTool.call`.

### What the code refutes in the two framing notes

- "`Continuation` takes a public `RunPark` instead of `SessionHandle`" and
  the `continuation` row of the plugin-architecture note
  ([plugin architecture](../../implemented/architecture/2026-09-24-plugin-architecture.md),
  the `Plugin` field table and the `goal` bullet): `Plugin` has no such field
  (`tools/plugins.ts:102-146`), and no `Continuation` or `RunPark` exists in
  the harness. Both lines are stale.
- "`toolUseHelpers.ts` is deleted": already done (no such file; the lane 4
  re-check records the move into `TraceEmitter.openToolCard`).
- "The same fence on `packages/texra/src/tools` drives that count to zero":
  already zero. 0 of the 98 files there import a harness internal; 77 import
  `@texra-ai/harness` entries. The deep-import baseline holds it
  (`hosts.texra: []`).
- "Deletes `ToolServices.ts` (129)": the file is 170 lines, 100 of them the
  public child door (`ChildRunsShape`, `ChildRuns`, `childRuns`,
  `:51-157`), which stays. The deletable part is 10 lines.
- "`RunCall` goes": eight of fourteen built-in tools need what it carries
  (section 4, the fence measurement). The root `AGENTS.md` names `RunCall`
  as the example of a `Context.Reference` with a default, "never a
  hand-provided null".
- "Part of `agentToolResolution`": nothing there is a layer (above).
- "Every other built-in is a `definePlugin` value in `builtins/`, which a lint
  fence restricts to public entries": a built-in that imports
  `@texra-ai/harness/plugins` closes a runtime import cycle, since
  `packages/harness/src/plugins.ts` re-exports `harnessBuiltins` from `tools/builtinPlugins.ts`,
  which lists the built-ins. No harness file imports a `@texra-ai/harness`
  entry today, and import cycles are a zero rule
  (`scripts/core-quality-measure.mjs:83-84`, `scripts/ratchet-zero-rules.mjs:15`).
  The built-in list would need its own entry.
- "`./host` is host composition only": 50 of the 98 app tool files import
  `@texra-ai/harness/host` (60 import statements), for `withLogChannel`,
  `Settings`, `withPerKeyLane`, `WorkspaceFs` and path helpers. The authoring
  closure spans `./plugins` (81 statements), `./host` (60), `./schemas` (49),
  the root (38), `./transcript` (20) and `./node` (15). A fence "to public
  entries" must count all six.

## Two designs compared

**The fence measurement both designs rest on.** For every file under
`tools/` and the `agent` tool, the (module, name) pairs imported from a
harness-internal alias that no entry file re-exports (method in "Verified"):

| Tool                      | Pairs no entry exports | What they are                                                                                                                                                                           |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grep`                    | 0                      |                                                                                                                                                                                         |
| `web_search`, `web_fetch` | 1, 3                   | `toFetchToolError`, `undiciFetchThrough`, `createHtmlToMarkdown`                                                                                                                        |
| `glob`                    | 2                      | `toPosixPath` (on `./host`), `globEscape`                                                                                                                                               |
| `read_file`               | 11                     | its own view, attachment, EML and MIME helpers (`formatFileView`, `buildBytesAttachment`, `parseEml`, `getMimeType`, ...)                                                               |
| `memory`                  | 22                     | `agent/memory/*` (its own 219 lines), `StorageFs` (on `./host`), `WORKSPACE_STORAGE_LAYOUT`, and `requireFileReadForEdit` from `RunCall`                                                |
| `edit_file`, `write_file` | 6, 6                   | `fileEditFlow.ts` (`applyApprovedFileEdit`, `resolveWritableTarget`), which reads `requireFileReadForEdit`, the approval modules and `reloadAgentCatalog`; `AgentCatalog`, `AppSignals` |
| `plan`                    | 8                      | `requireToolRun`, `goalGrant`, `launchBackgroundScript` (which reads `startDetachedChildRunLoop`, `prepareAgentDefinition`, `createScriptRunStrategy`, `offeredBy`)                     |
| `bash`                    | 19                     | `requireToolRun`, `registerRun`, `SessionHandle`, `createChildRun`, `startDetachedChildRunLoop` (#14492), `bashDelivery`                                                                |
| `executions`              | 13                     | `Runs`, `SessionHandle`, `getRunRecords`, `scriptRunCalls`, `historyQuery`, `completedRunArchive`; its ten `tools/executions/` helpers name `SessionHandle` in six                      |
| `script`, `self`          | 9, 15                  | the script door, `CodeSandbox`, `forkSeed`, `executeSubagentInBand`, `agentChildRunId`                                                                                                  |
| `agent`                   | 17                     | `Runs` (through `AgentRunServices`), `RunCall`, `getRunRecords`, `attemptRequests`, `callRequestId`                                                                                     |

Five tools are app-shaped (`grep`, `glob`, `read_file`, `web_search`,
`web_fetch`): 16 helper names stand between them and a public-only import
list, 3 of which (`hasExtension`, `OFFICE_EXTENSIONS`, `toPosixPath`) are on
`./host` under another module. One (`memory`) is engine-coupled by the
read-before-edit rule alone. Eight are engine code: `agent`, `script`,
`self`, `bash`, `executions`, `plan`, `edit_file`, `write_file`. The risk the
evidence note named ("the fence may show the `agent` tool is engine code")
is confirmed and wider than named. The design doc allows it: "Such a tool is
engine code: it moves to `tools/`", which is where all of them are. Four of
the six built-in plugins hold at least one engine tool, and `file-ops` holds
three app-shaped and three engine tools, so a `builtins/` directory would
split a plugin whose id is persisted (`tools.offered.plugin`, the switch
key).

| Axis                             | A: one `Catalog`, the door as a field of `ToolContext.env`, `RunCall` deleted                                                                                                                                                                                                                                                                                                                                                                                                                                  | B: one tool type, `Runs` behind the door, `RunCall` kept                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deletes                          | everything B deletes; the `RunCall` reference (`RunCall.ts:223-229`), `requireToolRun` and `RunToolCall` (`:271-287`), the second `provideService` (`toolUseDispatch.ts:509`), the test layer's `RunCall` provision (`nativeToolTestLayer.ts:191`): about 20 lines more. The catalog merge deletes the `ToolRegistry` tag (`toolTable.ts:261-264`) and `ToolCatalogOwner` (`liveTools.ts:93-110`): 22 lines                                                                                                    | the table in section 2: about 30 lines net                                                                                                                                                                                                                                                             |
| Adds                             | an engine slot on the loop's `ToolContext` value, a narrowing function that fails with the `requireRun` wording when the slot is absent, and a `runs` field on it (about 25 lines); `RunServices` names the merged catalog, so every run program is served `setEnabled`, which `ToolServices.ts:29-34` keeps from runs on purpose; the `./host` view of the catalog grows by `entries`, `get`, `decisions`, `blocks`, `drain`, `session`                                                                       | `runs` on `RunCallShape` (3 lines); four `Runs` provisions from the door at the engine launch sites (4 lines); `launchProcessChild` takes `runs` from the call (0)                                                                                                                                     |
| Ratchets and API reports         | `harness-layer-names-baseline.json`: nine `yield* ToolRegistry` sites in `agent/`, `controllers/` and `tools/` would import a new name on frozen edges (`agent->tools` lists `toolTable#ToolRegistry`); a rename is a new name, and the file only shrinks. `shallow-modules.json` (`ToolTypes.ts: 36`) rises if the slot is declared there. `harness.host.api.md:117,139,169-170` and `harness.plugins.api.md:128,130` change; `harness.plugins.api.md:24,34,70,74` and `undocumented-exports.json:26` as in B | `harness-layer-names-baseline.json` −4 names; `undocumented-exports.json` −1 row; `harness.plugins.api.md:24` goes, `:34,70` simplify; `harness.api.md:30` (`Plugin.tools`) retypes; `packages/harness/docs/api/plugins.md` regenerates; `pluginBoundaryRatchet.vitest.ts:281,301` retype their probes |
| Plugin authors                   | `PluginToolServices` keeps its name; `definePlugin` loses the type argument nobody passes; `ToolContext` carries a slot they cannot read without an internal import. The app: 0 source changes                                                                                                                                                                                                                                                                                                                 | the same, without the slot. The app: 0 source changes                                                                                                                                                                                                                                                  |
| The three hosts                  | `ToolCatalog` readers change an import and see a wider type: `packages/texra/src/controllers/settingsView/{ToolDashboardData,settingsToolCommands,githubSubscriptions}.ts`, `packages/cli/src/runtime/tools.ts`; `packages/{extension,desktop}/src` pass `texraPlugins` and change nothing                                                                                                                                                                                                                     | nothing                                                                                                                                                                                                                                                                                                |
| The risk the evidence note named | confirmed above: the door stays whatever its shape; A renames it from a reference to a field                                                                                                                                                                                                                                                                                                                                                                                                                   | confirmed above; B keeps the door and names what passes through it                                                                                                                                                                                                                                     |

**Recommendation: B.** Three reasons. First, the root `AGENTS.md` Effect
rule ("A service with a sensible default is a `Context.Reference`, never a
hand-provided null (`RunCall`, `ChildRuns`)") names `RunCall` as the pattern;
A's slot on `ToolContext.env`, absent for a host's standalone call, is the
hand-provided null, and it changes nothing about what engine code can reach.
Second, A's catalog merge is a rename on edges the layer-names ratchet
freezes, serves every run the switch door, and widens the host's view with
the owner's `drain` and `session` against the one shutdown protocol
(core-concepts invariant 10); the two tags are a narrow view per consumer
over one object, not a pass-through. Third, the measured duplication is the
type-level pair (`RuntimeTool`, `defineBuiltinPlugin`, the second union
name, the cast), and B deletes exactly that: after it, `Plugin.tools`, the
table, the catalog, the step's map and the loop name one tool type,
`ITool<Error, PluginToolServices>`, and the only thing a built-in has that a
plugin lacks is the engine door, read by name.

The "one process `Catalog`" and "one `Step` pin" of the evidence note's
sketch are, measured, the shape the code already has: one catalog object
(under a host view and an owner view), one session half of it, one pin per
step reused by the dispatch. B changes none of them.

## Lanes

### Lane 1: one tool contract (the whole of B, one PR)

Files: `agent/runtime/ToolServices.ts`, `RunCall.ts`, `tools/plugins.ts`,
`tools/builtinPlugins.ts`, `tools/ExecutionsTool.ts`,
`agent/runtime/delegation/AgentTool.ts`, `agent/runtime/delegation/detachedChildRun.ts`,
`agent/runtime/loop/toolUseDispatch.ts`, `agent/runtime/loop/toolGuard.ts`, `agent/runtime/run/AgentRun.ts`,
`agent/runtime/run/tools.ts`, `executeAgent.ts`, `agentToolResolution.ts`,
`tools/catalogEntries.ts`, `tools/structuredOutput.ts`, `tools/mcp/mcpConfig.ts`,
`tools/mcp/mcpServer.ts`, `tools/memory/MemoryTool.ts`, `tools/bash.ts`,
`tools/codemode/SelfTool.ts`, `tools/codemode/backgroundScript.ts`,
`tools/approval/bashApproval.ts`, `tools/approval/toolEditApproval.ts`,
`packages/harness/src/plugins.ts`; tests: `src/test-kernel/support/nativeToolTestLayer.ts`,
`support/setupPlatform.ts`, `architecture/pluginBoundaryRatchet.vitest.ts`,
`agent/ToolUseDispatchParallel.vitest.ts`, `tools/GlobTool.vitest.ts`,
`tools/ToolAvailabilityAppSignals.vitest.ts`,
`tools/ToolEditApprovalGate.vitest.ts`. About 25 source files retyped, 7
test files, 0 files moved.

The moves: `PluginToolServices` takes `CallServices`'s definition and
`CallServices` goes; `RuntimeTool`, `RuntimeToolRegistry` and `ToolServices`
go, their sites typed `ITool<Error, PluginToolServices>` and
`ResolvedTools['registry']`; `RunCallShape` gains `runs: Runs['Service']`,
set where the loop builds the call (`toolUseDispatch.ts:483-491`, which
already yields `Runs` at `:508`); `childRuns(call)` reads `call.runs`;
`ExecutionsTool` reads `call.runs`; `agentTool`, `SelfTool`, `bash` and
`launchBackgroundScript` provide `Runs` from the door to the launch internal
they call; the script door is handed over with `Runs` provided, so
`scriptCalls` requires `PluginToolServices`; `defineBuiltinPlugin` and the
`builtin` alias go, the six built-ins are `definePlugin` values; `sessionOf`
goes, its three callers read `run.session` off `requireToolRun`; the two
`PluginDefinition` type arguments become one. The stale `continuation` row
and bullet of the plugin-architecture note are deleted in the same PR.

Invariants kept: the five write points move nowhere (the only loop edit is
the `runs` field and the door's provision at `toolUseDispatch.ts:508-509`);
per-step pinning is untouched (`agent/runtime/loop/step.ts` is not in the lane); request
kinds stay closed (no kind is added); the `Effect.run*` entry allowlist is
untouched (no runtime entry changes); no row kind or version changes.

Gate: `npm run typecheck`; `npm run test:pure` (the ratchets:
`pluginBoundaryRatchet`, `subsystemEdgeRatchet` with its four-name shrink
through `-u`, `refutedCandidatesRatchet`, `sharedSchemasDeepImportRatchet`);
`npm run test:changed` (the five suites above and
`tools/NativeSubagentProductionPath.vitest.ts`);
`npm run check:core-quality -- --update` (the `undocumented-exports` row, the
API reports, `packages/harness/docs/api/plugins.md`);
`npm run check:dead-code-ratchet`; `npm run gate`. Zero new tests.

Net: about −30 source lines, 6 ratchet or report rows.

### Lane 2, conditional on decision 4: the five app-shaped built-ins behind a fence

Files: `tools/{ReadTool,glob,grep}.ts`, `tools/web/{WebSearchTool,WebFetchTool}.ts`
and their helpers (`attachments.ts`, `formatting.ts`, `emlParser.ts`,
`timeouts.ts`, `gitignore.ts`) to `builtins/`; `packages/harness/src/plugins.ts` gains the 13
helper names no entry exports; `harnessBuiltins` and the six plugin values
move to an entry of their own (a `./builtins` subpath in
`packages/harness/package.json`) so that `builtins/` can import
`@texra-ai/harness/plugins` without closing a cycle through `packages/harness/src/plugins.ts`;
`eslint.config.mjs` gains a `no-restricted-imports` block for
`packages/harness/src/builtins/**`; `HARNESS_LAYERS` in
`src/test-kernel/architecture/subsystemEdgeRatchet.vitest.ts:429-440` and the
layer order in `packages/harness/AGENTS.md` gain the directory;
`config/ratchets/architecture-edges-baseline.json` gains `tools->builtins`
(the `file-ops` and `web` values import the moved tools).

Invariants kept: the same as lane 1; no tool's identity digest changes
(`catalogEntries.ts:136-147` digests name and schema only), so no
`tools.offered` record changes.

Gate: `npm run gate`, `npm run test:pure`, `check:core-quality -- --update`
for the API reports, `check:dead-code-ratchet` (13 new exports each with the
moved tool as consumer).

Net: about +70 lines (13 export statements, the ESLint block, the entry file,
the layer row); 0 lines vanish. It is not net-negative because it publishes
surface and moves code; what it buys is the proof that five of fourteen
built-ins can be written on the public surface, which the app's 98 tool files
already prove for the app. Recommended: not now (decision 4).

Order: lane 1 alone, or lane 1 then lane 2.

## Refused alternatives

`config/ratchets/refuted-candidates.json` holds eleven entries
(`EFF-ADOPT-config-provider`, `EFF-ADOPT-per-key-lane-semaphore`,
`EFF-ADOPT-retry-gate-schedule`, `EFF-ADOPT-retry-gate-circuit-breaker`,
`EFF-ADOPT-timeouts-already-effect`, `EFF-ADOPT-jitter-helper-stays`,
`EFF-ADOPT-mcp-client`, `RT-execute-command-lift`,
`RT-install-cli-process-runtime`, `RT-desktop-pty-host-effect`,
`SCOPE-external-roots-standalone-service`); none concerns the tool layer's
contracts or catalogs. Three pin modules the lanes touch nothing in
(`tools/timeouts.ts`, `tools/mcp/mcpServer.ts`, `withPerKeyLane` under
`tools/approval/approvedWrite.ts`): lane 2 would move `timeouts.ts` whole,
leaving its pinned signatures as they are. Nothing here re-proposes a refuted
shape.

Refused by this note, with the evidence:

- **Merging `ToolRegistry` into `ToolCatalog`.** `RunServices` names the table
  and not the catalog so that no run program is served the switches
  (`ToolServices.ts:29-34`); the nine `yield* ToolRegistry` sites would import
  a renamed tag on frozen edges (`harness-layer-names-baseline.json`,
  `agent->tools` lists `toolTable#ToolRegistry`); the table's module imports
  no layer on purpose so a reader of the tag loads none (`toolTable.ts:1-7`).
- **Merging `ToolCatalog` and `ToolCatalogOwner`.** The host's view must not
  carry `drain` and `session` (invariant 10, one shutdown protocol owned by
  core); the two tags are one object (`liveTools.ts:228-231`), 18 lines for a
  narrow view per consumer.
- **`RunCall` as a field of `ToolContext.env`** (design A): the Effect rule
  above; about 20 lines for a rename of the door; reach unchanged.
- **A process-keyed session half** (one `RcMap` keyed by project instead of
  `SessionTools`): a session's close must close its MCP servers and sandbox
  ("never past the session's close", `sessionTools.ts:1-11`); an idle-time
  release is not a close.
- **One record for the step** (`ToolStep`, `ResolvedTools`, `StepTools`,
  `OpenStep` merged): the four nest by what each stage adds (the pin's
  resources; the resolved definitions and map; services, roots, hooks and
  modules; the scope, the withheld tools, the skills and the hold), 17 fields
  together, a wide record; `openStep` already builds them in one function
  (`agent/runtime/loop/step.ts:184-406`).
- **Deleting `ProcessCatalog` by merging `liveTools.ts` and `sessionTools.ts`**:
  `pinStep` would take the same eight values as parameters; the type moves,
  nothing vanishes, and `toolCatalogLayer` would grow past the 150-line
  function cap.
- **Publishing `requireFileReadForEdit` so `memory` can move**: the
  read-before-edit rule reads the run's facts through the engine door
  (`RunCall.ts:294-313`, #14491); publishing it ties the public surface to
  the door the fence exists to keep private.
- **Splitting `resolveStepTools`** to clear its `max-lines-per-function` row:
  the root `AGENTS.md` refuses a mechanical split; the function is one policy
  read top to bottom.
- **A `builtins/` directory now** (lane 2): the cycle through `packages/harness/src/plugins.ts`,
  13 new public names, five tools moved, and a persisted plugin split for
  `file-ops` unless its value stays in `tools/` and imports the moved tools;
  the count it exists to drive to zero is already zero for the app.

## Owner decisions

1. **One tool type.** Type `Plugin.tools`, the table, the catalog, the step
   and the loop with `ITool<Error, PluginToolServices>`, reach `Runs` through
   the engine door (`RunCallShape.runs`), and delete `RuntimeTool`,
   `RuntimeToolRegistry`, `ToolServices`, the `CallServices` name and
   `defineBuiltinPlugin`? _Recommend: yes; lane 1._
2. **`RunCall` stays the one engine door**, a `Context.Reference`, not a slot
   on `ToolContext.env`? _Recommend: yes; it is the pattern the root
   `AGENTS.md` names, and the alternative is a rename._
3. **The three lifetimes stay as they are**: `ToolRegistry` (the table, what a
   run is served), `ToolCatalog` under a host view and an owner view, one
   `SessionTools` per project, one pin per step? _Recommend: yes; nothing
   measured is a fourth copy._
4. **Build the `builtins/` fence now** for `grep`, `glob`, `read_file`,
   `web_search` and `web_fetch`, at 13 new public names, a `./builtins` entry
   and about +70 lines? _Recommend: no. Record this note's roster (five
   app-shaped, one engine-coupled, eight engine) as lane 4b's result, and
   build the fence when a named embedder cannot write a built-in it needs on
   the public surface, the same trigger the design doc gives the `./testing`
   export._
5. **Retire the refuted bullets** of the general-package design's "Plugin
   contract" (`Continuation`/`RunPark`, `toolUseHelpers.ts`, the app's fence
   count) and the plugin-architecture note's `continuation` row in lane 1's
   PR? _Recommend: yes._

## Verified

- Measured at `143735cd8d` (`origin/main`, 2026-11-01) in a clean worktree;
  no build, typecheck or test was run, since this note changes no code.
- Line counts: `wc -l` on every file named above (`toolTable.ts` 264,
  `liveTools.ts` 236, `sessionTools.ts` 309, `step.ts` 479,
  `ToolServices.ts` 170, `agentToolResolution.ts` 376, `catalogEntries.ts`
  193, `RunCall.ts` 313, `tools/plugins.ts` 361, `builtinPlugins.ts` 136,
  `toolUseDispatch.ts` 1,098, `toolGuard.ts` 383, `AgentTool.ts` 594,
  `ExecutionsTool.ts` 784, `bash.ts` 542, `agent/memory` 219, `tools/`
  6,766 flat and 5,708 in subdirectories, `agent/runtime/delegation/` 2,894).
- Consumer counts: `grep -rlw <name>` over `packages/{harness,texra,cli,desktop,extension,llm}/src`
  and `src/test-kernel` for each of 73 identifiers, split by `src/test-kernel`
  prefix; the per-field readers of `RunCallShape` by `grep -rn` over
  `tools/`, `agent/runtime/delegation/` and the loop for `requireToolRun`, `yield* RunCall`,
  `.scriptCalls`, `.responseId`, `.attempt`, `.logId`, `.instruction`,
  `.hook`, `.script`, `.facts` and `.run.{session,steps,callbacks}`;
  `yield* Runs` and `registryOf(` over the harness.
- The fence measurement: a script over every `.ts` file under `tools/` and
  `agent/runtime/delegation/AgentTool.ts` that parses `import ... from '@<alias>/...'`
  statements, drops comments, and keeps each (module, name) pair that no
  `export { ... } from` or `export * from` statement in `src/{index,plugins,schemas,node,transcriptEntry}.ts`
  covers; the 16 names of the five app-shaped tools were then checked by name
  against all six entry files (`grep -lw`), which found 3 on `host.ts`.
  The app's imports: `grep -rhoE "from '@texra-ai/harness(/[a-z]+)?'"` over
  `packages/texra/src/tools` (263 statements across the six entries), and
  `grep -rl "from '@(agent|tools|platform|shared|common|utils|controllers|skills|model|logger|transcript)/"`
  (0 files).
- Ratchets and reports read from disk: `config/ratchets/harness-deep-import-baseline.json`
  (`hosts.texra: []`), `harness-layer-names-baseline.json` (`tools->agent` 86
  names, `agent->tools` 27), `core-quality/{undocumented-exports,pass-through,shallow-modules,file-size,max-lines-per-function,complexity}.json`,
  `refuted-candidates.json` (11 ids), `config/api-reports/harness.{plugins,host}.api.md`
  and `harness.api.md` by `grep -n`; `HARNESS_LAYERS` at
  `subsystemEdgeRatchet.vitest.ts:429-440`; the cycle rule at
  `scripts/core-quality-measure.mjs:83-84` and `scripts/ratchet-zero-rules.mjs:15`;
  `grep -rln "from '@texra-ai/harness"` over `packages/harness/src` (0 files).
- Recent facts: #14491 (`d99b6f9283`) added `RunCallShape.facts` and
  `requireFileReadForEdit`'s read of it; #14492 (`234e7225a6`) moved the
  child's opening wait into `startDetachedChildRunLoop`, which `bash.ts:494`
  and `backgroundScript.ts:101` now call directly; M1 (#14446) made
  `finishCall` (`toolUseDispatch.ts:362`) the one per-call program. All three
  are read in the current tree, not from the framing notes' line numbers.
- `node scripts/check-guidance-refs.mjs` and
  `node scripts/check-proposal-status.mjs` pass on this note; the note is
  formatted with the repository's Prettier.
