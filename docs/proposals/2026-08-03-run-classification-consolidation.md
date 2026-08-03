# One authoritative run identity, with typed projections

Status: proposed
Date: 2026-08-03
Revision: 3 (compatibility classes, responsibility rulings, removal inventory)

TeXRA classifies "what kind of thing is running" in six places. Three of them
are false at most of their write sites, one is an untyped persisted string, and
no single one is authoritative, so each host reconstructs the fact at render
time.

This proposal establishes **one validated, durably owned run identity** in the
shared layer, and leaves presentation to each host. It does not claim to reduce
the taxonomy to a single element: `AgentCategory` remains, and several typed
projections of the identity remain by design. The honest statement of the result
is one authority plus derived projections, not "six vocabularies to one".

## Revision notes

Revision 1 proposed a shared `RUN_SURFACE` chrome table, a `surface` key on the
wire, and a five-PR programme whose first stage changed `delegate_multi_agents`
nullability. Review rejected that scope. Revision 2 narrowed to one authority
with host projections and dated every compatibility reader.

Revision 3 rests on a full audit of the surface areas (every wire and persisted
shape on all three hosts) and of every site where classification changes
runtime behavior rather than chrome. It changes four things:

- **Compatibility is classified by data class, not by reader.** The
  compatibility obligation collapses from three dated readers to one permanent
  absence-tolerant read path that already exists. Revision 2's dated
  `ExecutionMeta` reader would have broken pre-existing agent histories and —
  through `TraceDocumentSchema.meta` embedding `ExecutionMetaSchema`
  (`src/transcript/traceDocumentSchema.ts:10,20`) — previously exported traces,
  on a schedule. Withdrawn.
- **`identity.category` is removed from the model.** The behavior audit shows
  no runtime behavior legitimately consumes a category copy outside
  `config`/`setting`; the copy was a display snapshot living inside the shared
  identity — the mixed concern this proposal exists to remove. With it goes
  revision 2's most fragile dependency, the `normalizeWriterCategory` deletion
  sequencing.
- **A removal inventory.** Every element this proposal deletes is listed with
  its location, its replacement, and its stage, so the cleanup is auditable
  rather than implied. Deleted elements leave no re-export shims.
- **Stages are reordered ephemeral-first.** All fully breakable work (both UI
  stacks) lands before any persisted byte changes.

## Problem

`AgentCategory` (`src/shared/schemas/agent.ts:10-16`) is a real and irreducible
fact about an _agent_: it is `AgentConfigSchema`'s persisted discriminant
(`src/agent/core/definition/AgentConfig.ts:67-70`). It is not a fact about a
_run_. A stream can carry a native agent, an external agent CLI, a background
bash process, or a deterministic multi-agent script, and only the first two are
agents at all.

`RunKind` (`src/shared/schemas/runDescriptor.ts:8-9`) is the correct axis and
already exists with the right three members. Nothing treats it as
authoritative, and `RunKindSchema` itself stays unexported, so no boundary ever
validates a kind.

| Vocabulary                                      | file:line                                                         | What it actually discriminates                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunKind` `{agent, process, workflowScript}`    | `runDescriptor.ts:8-9`                                            | What owns the stream. The correct axis. The type is exported at `:9` and consumed at `childStream.ts:17,28`; only `RunKindSchema` stays unexported, so nothing validates a kind at a boundary. |
| `RunDescriptor.agent` + `.category`             | `runDescriptor.ts:21-22`                                          | Nothing, for 2 of 3 kinds. `z.strictObject` demands both beside `kind`, so process and script runs fabricate them.                                                                             |
| `RunConfigReferenceSchema`                      | `runDescriptor.ts:11-15`                                          | Nothing. Three persisted fields for one reachable value; `path` is hardcoded at `:47`.                                                                                                         |
| `CreateChildStreamOptions.streamCategory`       | `src/tools/delegation/childStream.ts:27`                          | Nothing. False at 2 of 3 writers: `bash.ts:428` passes `ToolUse` beside `runKind: 'process'`; `WorkflowScriptTool.ts:426` passes `Workflow` beside `runKind: 'workflowScript'`.                |
| `ExecutionMeta.category: z.string().optional()` | `src/shared/schemas/stream.ts:86`                                 | Mixes `'process'` (a RunKind) with `'toolUse'`/`'workflow'` (an AgentCategory) in one untyped persisted string.                                                                                |
| `StreamTabInfo.kind`                            | `stream.ts:300-317`                                               | The same three literals declared a second time, while the shared base still requires `agentCategory` on all three arms (`stream.ts:280`).                                                      |
| `ProgressStreamRunDetails.kind`                 | `src/controllers/progressView/backend/ProgressViewState.ts:49-69` | The same three literals a third time, with correct per-arm payloads.                                                                                                                           |
| `StreamState.kind: AgentCategory`               | `src/shared/schemas/streamState.ts:195` (union at `:206-209`)     | A field named `kind` carrying the other axis: `kind: z.literal(AgentCategory.Workflow)`. `createStreamState` files everything non-ToolUse as Workflow (`:229-243`).                            |
| `isProcessAgent` over `Set(['bash'])`           | `src/shared/streams/agentKind.ts:14-18`                           | RunKind recovered by string-matching an agent name. Five production call sites.                                                                                                                |
| `resolveExecutionDisplayCategory`               | `src/tools/executionFormatters.ts:13-20`                          | A sixth spelling of the same decision.                                                                                                                                                         |
| `DELEGATION_AVAILABILITY_CATEGORY`              | `src/shared/constants/delegationTools.ts:37-42`                   | `DELEGATION_TOOL_CATEGORY` plus one fabricated row mapping `delegate_multi_agents` to `Workflow`.                                                                                              |
| CLI `StreamSlice.category`                      | `packages/cli/src/chat/tui/state/cliState.ts:188-191`             | The CLI's entire model. Cannot express process or workflowScript, so the TUI re-derives kind from a stream-id regex, a tool name, and transcript entry roles.                                  |

Three consequences follow.

**Fabricated identity.** `bash.ts:409-413` invents an `AgentConfig` with
`agent: 'bash', agentCategory: ToolUse`. `WorkflowScriptTool.ts:353-356` borrows
a real workflow agent's name and source for the script run itself.

**Render-time reconstruction.** `ProgressViewState.ts:320-323` recovers the run
kind by calling `isProcessAgent(config.agent)`, and therefore can never yield
`workflowScript`. This violates the "never compensate for a data-model problem
at render time" rule in CLAUDE.md at the source of the progress model.

**Hosts disagree.** The extension models three kinds; the CLI models two and
gates workflow affordances on `AgentCategory.Workflow`
(`appInteractionPolicy.ts:286-288`, `App.tsx:310-313`).

### Two live defects

Both independently confirmed in review. Each is fixable on its own.

1. `kind` was added at `runDescriptor.ts:24` inside a `z.strictObject` without
   bumping the version at `:6`. Descriptors written before that change fail
   parsing and are warn-and-dropped today.
2. Four of six `registerExecution` call sites omit `category`. Full inventory:
   omitted at `agentCliShared.ts:197`, `subagentExecution.ts:165`,
   `WorkflowScriptTool.ts:371`, `inBandSubagentExecution.ts:446`; passed at
   `bash.ts:415` (`'process'`) and `runAgent.ts:102` (`config.agentCategory`).
   That is why no execution on disk is ever tagged `workflowScript`.

### Two prior beliefs that did not survive checking

- `texra.enabledAgents` and `texra.enabledToolUseAgents` have **no production
  reader**. `texra.enabledAgents` appears exactly once, in the test fixture
  `src/test-kernel/common/WorktreeMemento.vitest.ts:34`;
  `texra.enabledToolUseAgents` has **zero** hits anywhere in the tree. The live
  key is `texra.agentRosterSelection` (`src/shared/state/stateKeys.ts:21`).
  What is established is that the workflow roster resolves empty on the
  `software-engineer` and `lean-project` teams; the mechanism is not.
- `packages/trace-viewer/src/traceDataSchema.ts` does **not** hand-mirror
  `ExecutionMeta`. It is 38 lines that import `TraceDocumentSchema` from
  `@transcript`. The `_IsExact` breakage hazard is stale for that file.

## Compatibility classes

The compatibility obligation is not "the extension cannot break histories" in
general. The ruling is narrower: **native agent-run history in the VS Code
extension is inviolable; bash and workflow-script session history may break;
everything desktop-side and everything in the TUI may break.**

One structural fact shapes how that ruling applies: **all three hosts share the
same `~/.texra` store.** Desktop resolves `resolveDesktopDataRoot()` to
`DEFAULT_NODE_STORAGE_ROOT` (`packages/desktop/src/main/platform/paths.ts:45-52`,
`src/platform/defaults/nodeStorage.ts:15-18`); the extension migrates its
legacy `storageUri` data into that same root
(`packages/extension/src/frontend/vscode/sharedStorageRoot.ts`); the CLI uses it
too (`packages/agent/src/node.ts:109`); the subtree names are one frozen map
(`src/common/storage/storageLayout.ts:8-17`). So "desktop can break" cannot
mean "desktop's persisted formats can break" — the same bytes are the
extension's history. Breakability is a property of **row cohorts and surface
classes, not hosts**:

| Class                 | Members                                                                                                                                                                                                                                                                                                                                                                                              | Regime                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Protected durable** | `executions/*/meta.json` + `config.json` rows whose run is a native agent; exported traces of agent runs (`TraceDocumentSchema.meta` embeds `ExecutionMetaSchema`, `traceDocumentSchema.ts:20`, and replay stamps `StreamState.kind` from `trace.config.agentCategory` at `replayTrace.ts:169`, where the discriminated union fails hard on an unknown value)                                              | Must parse forever, or be migrated once. Never date-dropped. |
| **Breakable durable** | The same files' `process` and `workflowScript` rows; `streamData/*/meta.json` descriptors (rebuildable — the `descriptorFromConfig` fallback already exists, `StreamSnapshotStore.ts:232-241`); main-view `sessionType` webview state (`mainView/state.ts:151-171`)                                                                                                                                       | Version-bump freely; degradation acceptable.                 |
| **Ephemeral**         | Every UI wire shape on every host: `StreamTabInfo`, `StreamMetadata`, `SYNC_STREAM_CONTENT`, proposals, history messages, `StreamState` (frontend-only), `ProgressStreamRunDetails` (documented "not persisted", `ProgressViewState.ts:89,153-154`), CLI `StreamSlice` and the NDJSON progress facts, desktop IPC. Audited: no memento or localStorage stores a kind/category from any of these shapes. | Recut atomically. Zero compatibility machinery, ever.        |

A second structural fact keeps the ephemeral class small: **there are only two
UI stacks, not three.** Desktop reuses the extension's Lit frontends and the
identical `ProgressBackend`/`WebviewUpdater` wire
(`packages/desktop/src/renderer/main.ts:22-53`,
`desktopAgentExecution.ts:256-266`); only the transport differs (postMessage vs
Electron IPC, `packages/desktop/src/main/hostBridge.ts:39-52`). Recutting the
extension webview shapes recuts desktop for free. The other stack is the Ink
TUI, whose only external contract is headless output parity.

## Scope

**In scope.** One validated run identity in the shared layer, owned durably in
one place; deletion of the fabricated and reconstructed classifications the
identity replaces (see "Removals"); host-local projections; correction of the
three responsibility violations listed under "Responsibilities".

**Explicitly out of scope.**

- **A shared UI policy table.** Revision 1's `RUN_SURFACE` combined identity with
  pane, resume, file-action, model-display and child-log policy. Those are host
  decisions. Each host projects its own UI from the parsed identity.
- **A `surface` key on any wire or persisted shape.** Derive it locally after
  parsing `RunIdentity`.
- **The workflow-roster failure.** Handled separately, after causal
  reproduction. See "Separated work".
- **The roster `workflowAgents`/`toolUseAgents` pair collapse**, and making
  `config.json` a kind-union. Different axes.

## Target model

### One identity, run axis only

New `src/shared/schemas/runIdentity.ts`.

```ts
export const RunIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    agent: AgentNameSchema,
    /** External CLI driving this agent ("codex", "claude_code"); absent for native. */
    tool: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('process'), tool: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('workflowScript'),
    workflowName: z.string().min(1),
  }),
]);

export type RunIdentity = z.infer<typeof RunIdentitySchema>;
export type RunKind = RunIdentity['kind']; // derived, not a parallel enum

export function runIdentityName(id: RunIdentity): string {
  switch (id.kind) {
    case 'agent':
      return id.agent;
    case 'process':
      return id.tool;
    case 'workflowScript':
      return id.workflowName;
  }
}
```

There is deliberately **no `category` field on the agent arm.** Revision 2
carried one, defended by a sequencing argument. The behavior audit (next
section) removes the need: category's authority chain is `setting → config`,
already enforced at launch, and no runtime behavior legitimately reads a
category copy from anywhere else. The one display-timing consumer that wants
category before the config snapshot resolves is served by a provisional hint on
the descriptor wrapper (below), explicitly non-behavioral.

`RunDescriptor` becomes the wrapper, and `RunConfigReferenceSchema` collapses to
a derived path helper (`runConfigPath(executionId)`), since it had three
persisted fields for one reachable value.

### One durable authority

The authority is **`ExecutionMeta.identity`**, written exactly once at birth by
`registerExecution` inside the fresh-lease scope, at all six call sites. Every
other appearance is a projection with a stated contract and an enforced
derivation:

| Appearance                             | Contract that makes it necessary                                                                                                                                                                                                              | Enforced derivation                                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionMeta.identity`               | The authority. Durable, written once at birth.                                                                                                                                                                                                | Sole writer is `registerExecution`, inside the lease.                                                                                                                      |
| `streamData/{id}/meta.json` descriptor | Display is keyed by stream id and renders before the run config snapshot resolves; the window is documented at `streamTabInfo.ts:34-38` and today filled by parsing the stream ID. The authority is keyed by execution id and not reachable there. | Constructed by `buildRunDescriptor` from the same `RunIdentity` value passed to `registerExecution`, at one call site (`childStream.ts:128`). Never independently authored. |
| `trace.json` `identity`                | An exported trace is a standalone artifact with no access to `~/.texra`.                                                                                                                                                                      | Written by the exporter, read from `ExecutionMeta` at export time. Optional in the schema; old exports lack it (see Compatibility).                                        |

The descriptor may additionally carry a **provisional category hint** for the
pre-config render window. Its consumers are display-only: the tab label/model
line, and the webview's `StreamState` arm selection
(`streamLifecycleSlice.ts:108` → `createStreamState`), which self-corrects when
the resolved config disagrees (`streamStateMerge.ts:40-45` resets on kind
change). The hint is named as a hint, never read by runtime code, and never
written to `ExecutionMeta`. If implementation shows the window can render on
`{kind, name}` alone with category filled at config resolution, the hint is
dropped — that outcome is preferred, not resisted.

## Responsibilities

The audit of every classification-driven branch in the tree yields three
ownership rulings. These are the load-bearing content of this proposal; the
schema is just their expression.

**1. `AgentCategory` is an execution-mode fact owned by the agent definition.
Authority chain: `setting → config`, enforced at launch.** Every substantive
behavior branch already reads `config.agentCategory` or
`setting.agentCategory`: flow-engine selection (`executeAgent.ts:468`),
resume-type routing (`SessionResumeRetrieval.ts:111-124`,
`resolveAndResumeStream.ts:123`), structured-output tool injection
(`runToolUseFlow.ts:228-231`), model-handler mode and token safety buffers
(`ModelHandler.ts:325-335,1873`), background-mode eligibility
(`modelHandlerOpenAIResponse.ts:434`), skill-catalog loading
(`userVars.ts:192`), usage accounting (`UsageMonitor.ts:200`), helper-model
substitution refusal (`helperModelPreference.ts:37-42`), workflow-output
opening (`runAgent.ts:139-141`). `AgentLaunchContext.ts:276-293` already
enforces that the YAML wins and overwrites the config at launch, and
`deriveResumability` has no classification branch at all. **`RunIdentity` must
never become a second behavioral source for category.**

**2. `RunIdentity.kind` is a launch-site fact, persisted once by
`registerExecution`.** The three launch sites already know the truth and today
either fabricate configs around it (`bash.ts:409-413`,
`WorkflowScriptTool.ts:353-356`) or leak it through names. Every current
recovery of kind is name-parsing: `isProcessAgent` (5 sites), the CLI's
four-prefix stream-id regex (`subscribeStreamLog.ts:138-142`),
`meta.category === 'process'` string sniffing (`executionListing.ts:149`),
`replayTrace.ts:159`. These are exactly the sites `identity.kind` replaces.

**3. UI is a per-host projection of the parsed identity, ephemeral, with no
compatibility machinery.** Both UI stacks consume the same validated
`RunIdentity`; what each renders from it stays local.

### Three responsibility violations to correct

1. **Runtime semantics sourced from a display projection.**
   `AgentExecutionHandle.category` reads the *descriptor*
   (`ExecutionHandle.ts:159-161`), and real behavior keys on it:
   `executions action=wait` returns immediately for a WAITING tool-use child
   (`waitCoordination.ts:43-50`), auto-delivered report suppression
   (`summaryFormat.ts:46`), and the `attachToolFlow` guard
   (`ExecutionHandle.ts:211`). The descriptor exists for the render window;
   behavior reading it inverts the ownership. The handle's category is
   re-sourced from the config (Stage B).
2. **Write-time mutation serving a UI default.** `normalizeWriterCategory`
   (`src/agent/storage/executionLifecycle.ts:50-63`, applied at `:140-143`)
   rewrites persisted `config.json` bytes — and no-ops when
   `!isAgentRegistryReady()`, so the same bash run can persist different bytes
   on different launches — solely so `chatDefaults.loadHistoryDefaults`
   (`chatDefaults.ts:108-114`) won't adopt a background bash row's model as the
   chat default. Once listing filters on `identity.kind !== 'agent'`, the
   mutation's purpose evaporates; `runtimeCategory`, which exists purely to
   hide the demotion from the category column, goes with it.
3. **Mis-classification is destructive in one place.**
   `packages/cli/src/runtime/runExecution.ts:115-120`: a category mismatch
   marks the run ERROR **and deletes the flow record**, permanently killing
   resumability. The strongest argument in the tree for validating identity at
   birth rather than reconciling it later. Stage B adds a fixture test pinning
   this path.

## Host projections

**Extension + desktop (one Lit stack).** `buildStreamTabInfo` remains the one
producer of display naming. It reads `identity` instead of parsing
`streamId.split('@')[0]` and calling `isProcessAgent`. Pane selection, toolbar
contents and progress state keying stay in the stack. Desktop's command palette
(`desktopCommandPalette.ts:374-383`) consumes the same recut `StreamTabInfo`.
The naming trap dies here too: `StreamMetadataSchema.kind`,
`StreamState.kind`, and `SYNC_STREAM_CONTENT.kind` all carry *category* under
the name `kind` today; all three are ephemeral, so they are renamed/retyped in
place with no compatibility arm.

**CLI.** `StreamSlice.category: AgentCategory | undefined` becomes
`identity: RunIdentity | undefined`. This requires adding a run-identity fact to
the NDJSON progress vocabulary: `projectCliRunFact` returns `undefined` for
`run.start` (`sessionProgressSubscription.ts:74-83`) and
`TUI_RUN_FACT_HANDLERS` (`subscribeRuntimeHost.ts:144`) has no `run.start` key.
Once the fact exists, these local reconstructions collapse, each to CLI-local
logic:

| CLI reconstruction today                                                                                                                 | Replaced by                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `isFullLogChildStream` regex over four hardcoded stream prefixes (`subscribeStreamLog.ts:138-142`)                                       | a CLI predicate over `identity.kind`                 |
| `category === Workflow && entries.some(role === 'workflowTask')` (`App.tsx:310-313`, byte-duplicate at `panes/SubagentList.tsx:728-732`) | `identity.kind === 'workflowScript'`                 |
| `view.toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME` (`StaticConversationTranscript.tsx:104-108`)                                         | `identity.kind === 'workflowScript'`                 |
| `session.toolName !== 'bash'` model suppression (`SubagentList.tsx:176-180`)                                                             | `identity.kind !== 'process'`                        |
| Two-hop AgentCategory walk (`appInteractionPolicy.ts:286-288`)                                                                           | `parent.identity.kind === 'workflowScript'`, one hop |
| `category === ToolUse` offers resume (`resumeHint.ts:151`)                                                                               | a CLI resume predicate over `identity`               |

Both ends of the CLI wire ship in one binary; the recut is atomic, with no
add-before-remove staging. Headless `texra run` / `--print` output parity is
checked per the `texra-cli` skill.

## Compatibility

Zero dated readers. One permanent obligation, served by a read path that
already exists.

**`ExecutionMeta.identity` is required at write, optional at read.** A pure
schema-transform legacy arm (revision 2's mechanism) cannot work anyway:
`ExecutionMeta` does not carry an agent name (`stream.ts:77-96`), so a
`category → identity` transform cannot synthesize the agent arm. The join
already happens at the established normalization boundary —
`executionListing.ts:142-158` builds `ExecutionListingEntry.kind` from
`meta.category` plus config presence — and at the resume boundary, which reads
the config regardless (`SessionResumeRetrieval.ts:111`). So readers treat
`identity == null` as "pre-identity row, resolve from config": literally
today's code path, kept **permanently for agent rows** (the protected class)
and allowed to degrade for process and workflow-script rows (breakable class).
No `workflow-script#` stream-id sniffing is built; that recovery would only
serve a breakable cohort.

This permanence also covers the trace boundary for free:
`TraceDocumentSchema.meta` embeds `ExecutionMetaSchema`
(`traceDocumentSchema.ts:10,20`), so old exported agent traces keep parsing
because the embedded schema keeps accepting identity-less rows.
`TraceDocument.identity` is added as optional; `replayTrace` prefers it and
falls back to the config-derived classification for old exports — that
fallback is confined to the trace read boundary and is permanent by nature.

**The descriptor gets no legacy arm at all.** `RUN_DESCRIPTOR_SCHEMA_VERSION`
bumps to 2; v1 rows fail parse and fall through to the existing
`descriptorFromConfig` rebuild (`StreamSnapshotStore.ts:232-241`). The failure
mode is a degraded tab label on a rebuildable projection, and the cohorts that
most depend on `kind` are breakable. Live defect 1's warn-and-drop behavior for
pre-`kind` descriptors is thereby subsumed rather than patched: after the bump,
*all* v1 descriptors rebuild from config uniformly instead of some parsing and
some dropping.

## Removals

Additions are only half the proposal; the deletions are the point. Every row
lists the element, where it lives, what replaces it, and the stage that deletes
it. Deletions ship in the same PR as their replacement's adoption — no
re-export shims, no orphaned exports (`npm run check:dead-code-ratchet`
enforces the latter).

### Shared schemas and types

| Removed                                                       | Location                          | Replaced by                                                            | Stage |
| ------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ----- |
| `CreateChildStreamOptions.streamCategory` + `runKind` pair    | `childStream.ts:27`               | single `run: RunIdentity` field; the three launch sites pass the truth | A     |
| `RunKind` as an independent enum declaration                  | `runDescriptor.ts:8-9`            | `RunIdentity['kind']` derived type                                     | A     |
| `RunDescriptor.agent` + `.category` (fabricated for 2 kinds)  | `runDescriptor.ts:21-22`          | `RunDescriptor.identity` (+ optional display hint, see Target model)   | C     |
| `RunConfigReferenceSchema` (3 persisted fields, 1 value)      | `runDescriptor.ts:11-15`          | `runConfigPath(executionId)` helper                                    | C     |
| `ExecutionMeta.category` untyped string                       | `stream.ts:86`                    | `ExecutionMeta.identity: RunIdentitySchema.optional()` (required at write) | B     |
| `StreamMetadataSchema.kind` (category misnamed `kind`)        | `streamState.ts:143`              | renamed/retyped on the recut wire shape                                | A     |
| `SYNC_STREAM_CONTENT.kind` naming trap                        | `progressView/outbound.ts:314,325` | recut with explicit category naming (arms unchanged)                  | A     |
| `StreamTabInfo` base requiring `agentCategory` on all 3 arms  | `stream.ts:280`                   | per-arm payloads carrying only what the arm has                        | A     |
| `ProgressStreamRunDetails` (third declaration of the 3 kinds) | `ProgressViewState.ts:49-69`      | `ProgressStreamMetadata.identity: RunIdentity`                         | A     |

### Classification recovery helpers

| Removed                                                | Location                                        | Replaced by                                              | Stage |
| ------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------- | ----- |
| `isProcessAgent` + `agentKind.ts` (5 call sites)       | `src/shared/streams/agentKind.ts:14-18`         | `identity.kind === 'process'` at each consumer           | A/B   |
| `resolveExecutionDisplayCategory`                      | `executionFormatters.ts:13-20`                  | listing rows carry `identity`; formatter reads it        | B     |
| `getAvailablePaths` switching on category strings      | `executionFormatters.ts:50-72`                  | switch on `identity.kind` + config category              | B     |
| `normalizeWriterCategory` (write-time byte mutation)   | `src/agent/storage/executionLifecycle.ts:50-63` | `loadHistoryDefaults` filters on `identity.kind`         | B     |
| `runtimeCategory` (exists to hide the above demotion)  | `executionListing.ts:146,157` + readers         | nothing — the demotion it hides no longer happens        | B     |
| `meta.category === 'process'` string sniff in listing  | `executionListing.ts:149`                       | `meta.identity.kind`                                     | B     |
| `handle.toolName` mutable slot                         | `ExecutionHandle.ts`                            | `identity` on the handle, immutable                      | B     |
| `ExecutionHandle.category` sourced from descriptor     | `ExecutionHandle.ts:159-161`                    | sourced from config (behavior consumers: `waitCoordination.ts:43-50`, `summaryFormat.ts:46,118`, `ExecutionHandle.ts:211`) | B     |
| `replayTrace` re-deriving kind via `isProcessAgent`    | `replayTrace.ts:159`                            | `trace.identity`, config-derived fallback for old exports | C     |

### CLI reconstructions (all ephemeral, deleted atomically)

| Removed                                                     | Location                                            | Replaced by                              | Stage |
| ----------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- | ----- |
| `StreamSlice.category` as the model                         | `cliState.ts:188-191`                               | `StreamSlice.identity`                   | A     |
| `isFullLogChildStream` four-prefix regex                    | `subscribeStreamLog.ts:138-142` (consumers `:184,758-760`) | CLI predicate over `identity.kind` | A     |
| workflow-root detection via category + entry roles          | `App.tsx:310-313`                                   | `identity.kind === 'workflowScript'`     | A     |
| byte-duplicate of the same detection                        | `panes/SubagentList.tsx:728-732`                    | same predicate, one home                 | A     |
| `toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME` check        | `StaticConversationTranscript.tsx:104-108`          | `identity.kind === 'workflowScript'`     | A     |
| `session.toolName !== 'bash'` model suppression             | `panes/SubagentList.tsx:176-180`                    | `identity.kind !== 'process'`            | A     |
| two-hop AgentCategory walk for child controls               | `appInteractionPolicy.ts:286-288`                   | one-hop `parent.identity.kind` predicate | A     |
| `category === ToolUse` resume-hint filter                   | `resumeHint.ts:151`                                 | CLI resume predicate over `identity`     | A     |
| `setActiveStream.agentCategory` on the progress payload     | `progressEvents.ts:29-31`                           | identity fact; removed once both UI stacks read it (last A PR) | A     |

### Silent defaults (each a masked failure today)

| Removed                                          | Location                             | Replaced by                                        | Stage |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------------------- | ----- |
| `metadata.agentCategory ?? AgentCategory.Workflow` | `streamTabInfo.ts:32`              | validated identity; absent category renders as pending, not Workflow | A |
| `runningCategory ?? getStreamCategory(streamId) ?? Workflow` | `ProgressFactApplier.ts:756-757` | validated identity on the stream record       | A     |
| remaining `?? AgentCategory.Workflow` defaults (4 sites, grep at implementation) | various    | same treatment: absent ≠ Workflow                  | A/B   |

### Deferred removals (recorded here so they are not lost, not in scope)

| Element                                                    | Why deferred                                                                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELEGATION_AVAILABILITY_CATEGORY` fabricated row          | Its consumer `annotateDelegationTool` (`agentToolResolution.ts:223`) writes the model-facing tool description from it; removal requires giving `delegate_multi_agents` its own annotation path — that is roster-track work. |
| Fabricated `config.json` per non-agent run                 | `bash.ts:409-413`, `codexConfig.ts:97`, `claudeAgentConfig.ts:248`. This design makes them non-authoritative but does not remove them; removing them is the "config.json as kind-union" axis, out of scope. |
| `ActiveChildInfo.kind` `{subagent, process}`               | `streamState.ts:62-71` — no `workflowScript` member; a script child's kind still leaks via `workflowPhase`. Follow-up on the same axis after Stage A proves the identity fact.            |

## Result, stated honestly

**What becomes singular:** the run identity has one durable authority
(`ExecutionMeta.identity`) and one validated schema (`RunIdentitySchema`).
Today no declaration is authoritative and none is validated at a boundary.

**What remains, by design:** `AgentCategory`, unchanged, as an execution-mode
fact about agents with its `setting → config` authority chain;
`StreamTabInfo.kind` and `ExecutionListingEntry.kind` as typed projections of
`RunIdentity['kind']`; each host's presentation types.

**What is deleted:** the inventory above — one authority replaces six
independent declarations; five name-parsers, one write-time byte mutation, six
silent Workflow defaults, and nine CLI render-time reconstructions go with it.
Per-stage element deltas are counted against the tree at implementation time,
not projected here.

## Build order

**Stage A — ephemeral only. No persisted bytes change.** Add
`runIdentity.ts`. Thread `RunIdentity` in-memory from the three launch sites
through the progress facts (`run.start` gains the identity fact). Recut both UI
stacks atomically: the Lit shapes (`StreamTabInfo`, `StreamMetadata`,
`SYNC_STREAM_CONTENT`, `ProgressStreamRunDetails` → `identity`), which fixes
desktop simultaneously; then the CLI (`StreamSlice.identity`, delete the nine
reconstructions). Delete the UI-side name-parsers and silent defaults. This
stage delivers the TUI workflow-agent display and workflow-script rendering
fixes first, with zero persistence risk. Check headless output parity per the
`texra-cli` skill. Import from `@shared/schemas/runIdentity`, never a new
`@agent/*` specifier (host-agent deep-import ratchet).

**Stage B — durable, under the one protected obligation. Touches
`executions/*/meta.json` and `config.json` readers.** `registerExecution`
requires `identity` at all six call sites; `ExecutionMeta.identity` is written
inside the lease; readers treat absence as pre-identity-agent-row via the
existing listing/config join, permanently. Delete `normalizeWriterCategory`,
`runtimeCategory`, the `meta.category` string, `resolveExecutionDisplayCategory`,
and the `handle.toolName` slot. Re-source `ExecutionHandle.category` from
config. Filter `loadHistoryDefaults`/`isUserVisibleExecution` on
`identity.kind`. Fixture tests: an identity-less agent row keeps listing and
resuming; a parentless synthetic-config row (residual `normalizeWriterCategory`
exposure via `chatDefaults`) keeps correct defaults; the
`runExecution.ts:115-120` destructive path. Fixes live defect 2.

**Stage C — descriptor and trace.** Bump `RUN_DESCRIPTOR_SCHEMA_VERSION` to 2
(split `STREAM_TAB_META_SCHEMA_VERSION` first, keeping it at 1 —
`streamData.ts:38-40` shares it today). `RunDescriptor` carries `identity`; no
legacy arm — v1 rows rebuild via `descriptorFromConfig`. Delete
`RunConfigReferenceSchema`. Exporter writes `TraceDocument.identity`; replay
prefers it with the permanent config-derived fallback. Run the trace-viewer
tsc, which the root typecheck does not cover. Subsumes live defect 1.

## Separated work

**The workflow-roster failure is not part of this proposal.** What is
established is the symptom: the workflow roster resolves empty on the
`software-engineer` and `lean-project` teams, so `delegate_multi_agents` cannot
launch there. The mechanism is not established, and changing
`WorkflowScriptToolInputSchema.agent` nullability before reproducing the cause
is premature. The sequence, on its own track:

1. Reproduce the empty roster deterministically and identify the boundary that
   produces it, distinguishing roster selection resolution
   (`AgentRosterController`, `texra.agentRosterSelection`) from the admission
   gate (`WorkflowScriptTool.ts:287`, `DELEGATION_AVAILABILITY_CATEGORY`).
2. Fix at whichever boundary the reproduction implicates.
3. Only then decide whether nullability changes, and whether the checkpoint
   fixture test is needed.

That last point matters regardless of ordering:
`deriveWorkflowScriptCheckpointId` (`checkpointKey.ts:19-34`) salts on the
resolved agent name and feeds `deriveExecutionId`, hence the executions
directory, stream id, journal key and lease. Any change in that area that
alters the salt re-roots every checkpoint and defeats the double-launch guard
at `WorkflowScriptTool.ts:378-393`.

The `DELEGATION_AVAILABILITY_CATEGORY` fabricated-row removal is parked on this
track too (see Deferred removals).

## Risks and open questions

- **The provisional category hint must stay display-only.** The failure mode
  this proposal just corrected — behavior reading a display copy
  (`ExecutionHandle.category`) — will recur if the hint leaks into runtime
  code. Guard: the hint lives only on the descriptor wrapper, is named as a
  hint, and its reader set is checked at Stage C review.
- **Deleting `normalizeWriterCategory` rests on one traced consumer.**
  `chatDefaults.loadHistoryDefaults` filters `isUserVisibleExecution` before
  reading `agentConfig.agentCategory`. Residual exposure is a parentless
  synthetic-config run. Grep for other readers of `config.agentCategory` on
  non-agent executions before Stage B, and keep the parentless-row fixture.
- **Historical workflow-script executions read as `agent` forever.** Accepted:
  that cohort is breakable, and it is today's behavior. No stream-id sniffing
  is built to heal it.
- **`descriptorFromConfig` rebuild quality.** After the Stage C version bump,
  all v1 descriptors rebuild from config; a fabricated config yields a
  fabricated-looking label for old process/script rows. Accepted for breakable
  cohorts; agent rows rebuild faithfully because their configs are real.
- **Disk-scale numbers are not cited in this revision.** Revision 1 quoted 142
  of 478 descriptors affected by defect 1, from a measurement pass that was not
  re-run. Withdrawn pending measurement; nothing in the design depends on them.
