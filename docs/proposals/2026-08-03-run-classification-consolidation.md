# One authoritative run identity, with typed projections

Status: proposed
Date: 2026-08-03
Revision: 4 (choke-point compatibility, executable PR plan)

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

Revision 4 sharpens two things revision 3 got structurally wrong, and replaces
the stage sketch with an executable PR-by-PR plan:

- **Compatibility is confined to one choke point, not spread across readers.**
  "Readers treat `identity == null` as legacy" (revision 3) means every reader
  branches — compatibility leaking into code structure, which is exactly the
  long-term maintenance cost to refuse. The rule is now: the disk schema keeps
  `identity` optional, the in-memory type has it **required**, and one function
  at the store boundary derives it for pre-identity rows. No consumer above the
  store ever sees an identity-less row. Compatibility is a data problem solved
  at the edge; the moment it shapes downstream code it is in the wrong place.
- **The "provisional category hint" is withdrawn.** A field whose contract is
  "don't trust me" is bad structure. Because `normalizeWriterCategory` is
  deleted (PR 4) before the descriptor is recut (PR 5), `config.json`'s
  category has a single writer by then, and a descriptor copy written at birth
  from that same config is correct by construction — a plain denormalization
  with one writer, not a hint. It gets a real name and no apology.
- **The CLI needs no new event.** `run.start` already emits the full descriptor
  on the trace wire (`childStream.ts:135` `emit({type: 'run.start', descriptor})`);
  the CLI simply never projects it. The TUI fix is wiring, not vocabulary.

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
category before the config snapshot resolves is served by a display-only
denormalized copy on the descriptor wrapper (below), single-writer and
correct by construction.

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

The recut descriptor is:

```ts
const RunDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(2),
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema,
  identity: RunIdentitySchema,
  /** Birth-time copy of config.agentCategory; present iff kind === 'agent'.
   *  Single-writer: valid only because normalizeWriterCategory is deleted
   *  before this shape exists (PR 4 < PR 5). Display-only by contract. */
  agentCategory: AgentCategorySchema.optional(),
});
```

`agentCategory` here is not a hint and not provisional: it is a denormalized
copy written once at birth from the same `config.agentCategory` that
`registerExecution` persists, and by the time this shape exists that config
field has exactly one writer (PR 4 deletes `normalizeWriterCategory` first).
Its consumers are display-only — the pre-config tab render
(`streamTabInfo.ts:34-38` documents the window) and the webview's
`StreamState` arm selection (`streamLifecycleSlice.ts:108`), which self-corrects
on kind change (`streamStateMerge.ts:40-45`). Runtime code reads category from
config, never from the descriptor — that rule is what PR 4's
`ExecutionHandle.category` re-sourcing establishes and what review enforces
thereafter.

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
   re-sourced from the config (PR 4).
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
   birth rather than reconciling it later. PR 4 adds a fixture test pinning
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

Zero dated readers. One permanent obligation, served at one choke point.

**Disk optional, memory required, one derivation function.** The persisted
`ExecutionMeta` schema keeps `identity` optional — old agent rows must parse
forever. The in-memory type has `identity` **required**. The two are bridged by
a single function at the store boundary:

```ts
/** The only place in the tree allowed to see an identity-less row. */
function resolveRunIdentity(
  meta: PersistedExecutionMeta,
  config: AgentConfig | null,
): RunIdentity {
  if (meta.identity) return meta.identity;
  // Pre-identity row. Agent rows (the protected cohort) resolve exactly;
  // process/script rows (breakable) degrade to their historical reading.
  if (meta.category === 'process') return { kind: 'process', tool: config?.agent ?? 'bash' };
  return { kind: 'agent', agent: config?.agent ?? 'unknown' };
}
```

A pure schema-transform legacy arm (revision 2's mechanism) cannot do this:
`ExecutionMeta` does not carry an agent name (`stream.ts:77-96`), so the
derivation needs the config join, which the store already performs at the
listing boundary (`executionListing.ts:142-158`) and the resume boundary
(`SessionResumeRetrieval.ts:111`). The choke point lives where that join
already happens. **No consumer above the store branches on identity presence,
ever** — that is the structural payoff: compatibility exists as five lines at
one edge, not as a shape every reader must remember. No `workflow-script#`
stream-id sniffing is built; that recovery would only serve a breakable
cohort, which degrades to `agent` exactly as it reads today.

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
it. Stage labels map onto the executable plan: **A = PRs 1–3** (ephemeral),
**B = PR 4** (durable authority), **C = PR 5** (descriptor + trace). Deletions
ship in the same PR as their replacement's adoption — no re-export shims, no
orphaned exports (`npm run check:dead-code-ratchet` enforces the latter).

### Shared schemas and types

| Removed                                                       | Location                          | Replaced by                                                            | Stage |
| ------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ----- |
| `CreateChildStreamOptions.streamCategory`, `.runKind`, `.agentName`, `.toolName` (four overlapping identity fields) | `childStream.ts:27-34` | single `run: RunIdentity` field; the three launch sites pass the truth | A     |
| `RunKind` as an independent enum declaration                  | `runDescriptor.ts:8-9`            | `RunIdentity['kind']` derived type                                     | A     |
| `RunDescriptor.agent` + `.category` (fabricated for 2 kinds)  | `runDescriptor.ts:21-22`          | `RunDescriptor.identity` + display-only `agentCategory` copy (see Target model)   | C     |
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
| `ActiveChildInfo.kind` `{subagent, process}`               | `streamState.ts:62-71` — no `workflowScript` member; a script child's kind still leaks via `workflowPhase`. Follow-up on the same axis after PRs 1-3 prove the identity fact.            |

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

## Executable plan

Six PRs. Every PR builds, type-checks (`npm run typecheck` — builds alone do
not), passes `npm test` and `npm run check:dead-code-ratchet`, and is
independently revertable. Deletions ship in the same PR as their replacement's
adoption. Each PR lists **Add**, **Delete**, **Tests**, and a grep-able
**Acceptance** line; the deletes are the point.

### PR 1 — `RunIdentity` exists and the launch sites speak it

_Ephemeral. No persisted bytes, no wire shapes, no UI change._

**Add**
- `src/shared/schemas/runIdentity.ts`: `RunIdentitySchema`, `RunIdentity`,
  `RunKind = RunIdentity['kind']`, `runIdentityName()`.
- `CreateChildStreamOptions.run: RunIdentity` (`childStream.ts`). The three
  launch sites pass the truth: `bash.ts` → `{kind:'process', tool:'bash'}`;
  `WorkflowScriptTool.ts` → `{kind:'workflowScript', workflowName: meta.name}`;
  agent-CLI/subagent paths → `{kind:'agent', agent, tool?}`.
- `buildRunDescriptor` takes `identity` and derives the v1 persisted fields
  from it (`agent: runIdentityName(identity)`, `kind: identity.kind`) so the
  on-disk shape is untouched in this PR.

**Delete**
- `CreateChildStreamOptions.streamCategory`, `.runKind`, `.agentName`, and
  `.toolName` (`childStream.ts:27-34`) — four overlapping identity fields
  collapse into `run`. The icon selection `toolName` served moves to a
  projection of `identity`.
- `RunKind` as an independent enum declaration (`runDescriptor.ts:8`) — the
  type re-exports the derived form.

**Tests** — unit: `runIdentityName` over all arms; the three launch sites emit
the expected identity on `run.start`.

**Acceptance** — `rg -c 'streamCategory' src/` → 0.

### PR 2 — extension + desktop UI reads identity

_Ephemeral. Recuts the Lit stack; desktop comes along for free._

**Add**
- `ProgressFactApplier` consumes the `run.start` descriptor's identity so
  `ProgressStreamMetadata.identity` is set at stream birth, before any config
  snapshot resolves.
- `StreamTabInfo` recut: per-arm payloads; `agentCategory` only on the `agent`
  arm (`stream.ts:280` base requirement removed).
- Explicit category naming on the recut `StreamMetadata` / `SYNC_STREAM_CONTENT`
  fields (the `kind`-carries-category trap, `streamState.ts:143`,
  `progressView/outbound.ts:314,325`).

**Delete**
- `ProgressStreamRunDetails` (`ProgressViewState.ts:49-69`) → replaced by
  `identity` on `ProgressStreamMetadata`.
- The `streamId.split('@')[0]` name-parse fallback and the `isProcessAgent`
  call in `buildStreamTabInfo` (`streamTabInfo.ts:38-49`).
- `metadata.agentCategory ?? AgentCategory.Workflow` (`streamTabInfo.ts:32`)
  and `runningCategory ?? getStreamCategory(streamId) ?? Workflow`
  (`ProgressFactApplier.ts:756-757`) — absent renders as pending, never as
  Workflow.
- `isProcessAgent` call at `ProgressViewState.ts:320-323`.

**Tests** — existing `src/test-kernel/progressView/*` suites recut; a fixture
asserting a process stream and a workflow-script stream classify correctly at
first render, before config resolution.

**Acceptance** — `rg -c 'isProcessAgent' src/controllers/` → 0;
`rg -c '\?\? AgentCategory.Workflow' src/controllers/` → 0.

### PR 3 — CLI recut, atomic

_Ephemeral. Both ends of this wire ship in one binary. This PR delivers the
TUI workflow-display and workflow-script fixes._

**Add**
- `projectCliRunFact` projects `run.start`'s identity
  (`sessionProgressSubscription.ts:74-83`); `TUI_RUN_FACT_HANDLERS` gains the
  handler (`subscribeRuntimeHost.ts:144`); `StreamSlice.identity: RunIdentity`.

**Delete** (all nine reconstructions, one PR)
- `StreamSlice.category` (`cliState.ts:188-191`).
- `isFullLogChildStream` and its four-prefix regex
  (`subscribeStreamLog.ts:138-142`; consumers `:184`, `:758-760` switch to
  `identity.kind`).
- Workflow-root detection via category + entry roles (`App.tsx:310-313`) and
  its byte-duplicate (`panes/SubagentList.tsx:728-732`) →
  `identity.kind === 'workflowScript'`.
- `toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME`
  (`StaticConversationTranscript.tsx:104-108`).
- `session.toolName !== 'bash'` model suppression
  (`panes/SubagentList.tsx:176-180`) → `identity.kind !== 'process'`.
- Two-hop AgentCategory walk (`appInteractionPolicy.ts:286-288`) → one-hop
  `parent.identity.kind`.
- `category === ToolUse` resume-hint filter (`resumeHint.ts:151`) → identity
  predicate.
- `SetActiveStreamPayload.agentCategory` (`progressEvents.ts:29-31`) — both
  stacks now read identity; the payload field has no consumer left.

**Tests** — TUI snapshot tests for a workflow-script child pane and a process
stream; headless `texra run` / `--print` parity per the `texra-cli` skill.

**Acceptance** — `rg -c 'StreamSlice.*category|isFullLogChildStream' packages/cli/` → 0.

### PR 4 — the durable authority

_Touches `executions/*/meta.json` writers and `config.json` readers. The one
protected obligation lives here, at one choke point._

**Add**
- `ExecutionMeta.identity: RunIdentitySchema.optional()` on the persisted
  schema; **required** on the in-memory type; `resolveRunIdentity(meta, config)`
  as the single derivation point at the store boundary (see Compatibility).
- `registerExecution` requires `identity` at all six call sites
  (`agentCliShared.ts:197`, `subagentExecution.ts:165`,
  `WorkflowScriptTool.ts:371`, `inBandSubagentExecution.ts:446`, `bash.ts:415`,
  `runAgent.ts:102`), written inside the fresh-lease scope.

**Delete**
- `ExecutionMeta.category` writes (the untyped string, `stream.ts:86` — the
  field remains readable on old rows via the optional persisted schema, but no
  writer remains).
- `normalizeWriterCategory` (`executionLifecycle.ts:50-63`) and its
  application at `:140-143` — `loadHistoryDefaults` (`chatDefaults.ts:108-114`)
  and `isUserVisibleExecution` (`executionListing.ts:76-81`) filter on
  `identity.kind` instead.
- `runtimeCategory` (`executionListing.ts:146,157` and readers
  `executionFormatters.ts:32,43-44`, `history.ts:508`) — the demotion it hides
  no longer happens.
- The `meta.category === 'process'` sniff (`executionListing.ts:149`) →
  `identity.kind`.
- `resolveExecutionDisplayCategory` (`executionFormatters.ts:13-20`).
- `handle.toolName` mutable slot; `ExecutionHandle.category` re-sourced from
  config (behavioral consumers `waitCoordination.ts:43-50`,
  `summaryFormat.ts:46,118`, `ExecutionHandle.ts:211` now read the config's
  category, per the Responsibilities ruling).
- `getAvailablePaths` category-string switch (`executionFormatters.ts:50-72`)
  → keyed on `identity.kind` + config category.

**Tests** — fixtures: an identity-less agent row (pre-migration bytes) lists,
formats, and resumes identically; an identity-less `category:'process'` row
degrades to its historical reading; a parentless synthetic-config run does not
poison `loadHistoryDefaults`; the `runExecution.ts:115-120` destructive path is
pinned.

**Acceptance** — `rg -c 'normalizeWriterCategory|runtimeCategory|resolveExecutionDisplayCategory' src/` → 0;
`rg -c "category: '(process|toolUse|workflow)'" src/agent/storage/` → 0 outside
the legacy read fixture. Fixes live defect 2.

### PR 5 — descriptor v2 and trace

_Touches `streamData/*/meta.json` (breakable-durable) and the trace exporter._

**Add**
- Split `STREAM_TAB_META_SCHEMA_VERSION` from `RUN_DESCRIPTOR_SCHEMA_VERSION`
  (`streamData.ts:38-40` shares it today), keep the former at 1, bump the
  latter to 2 with the recut shape (`identity` + display-only `agentCategory`,
  see Target model). No legacy arm: v1 rows fail parse and rebuild via
  `descriptorFromConfig` (`StreamSnapshotStore.ts:232-241`).
- `TraceDocument.identity` (optional), written by the exporter from
  `ExecutionMeta`; `replayTrace` prefers it.

**Delete**
- `RunDescriptor.agent` + `.category` as fabricated required fields
  (`runDescriptor.ts:21-22`).
- `RunConfigReferenceSchema` (`runDescriptor.ts:11-15`) → `runConfigPath()`.
- `replayTrace.ts:159`'s `isProcessAgent` re-derivation → `trace.identity`
  with the config-derived fallback for old exports.
- `agentKind.ts` / `isProcessAgent` entirely — this PR removes the last
  consumer.

**Tests** — descriptor v1 → rebuild fixture; old exported trace (no
`identity`) replays; new trace round-trips. Run the trace-viewer tsc, which
the root typecheck does not cover.

**Acceptance** — `rg -c 'isProcessAgent' .` → 0 (production tree); subsumes
live defect 1.

### PR 6 — ratchet and docs

Shrink `config/ratchets/knip-baseline.json` entries freed by the deletions
(never widen); confirm no new `@agent/*` deep-import specifier entered any
host (host-agent-import ratchet); update `src/agent/core/README.md` and this
proposal's status. **Acceptance** — all ratchet checks pass with smaller
baselines; `rg -c 'AgentCategory' packages/cli/src/chat/tui/` reports only
`StreamState`-arm usages.

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

- **The descriptor's `agentCategory` copy must stay display-only.** The
  failure mode this proposal corrects — behavior reading a display copy
  (`ExecutionHandle.category`) — will recur if a new runtime reader adopts the
  descriptor copy. Guard: the PR-4-before-PR-5 ordering makes the copy
  correct by construction (single config writer), and its reader set is
  checked at PR 5 review; any behavioral reader is a review-blocking defect.
- **Deleting `normalizeWriterCategory` rests on one traced consumer.**
  `chatDefaults.loadHistoryDefaults` filters `isUserVisibleExecution` before
  reading `agentConfig.agentCategory`. Residual exposure is a parentless
  synthetic-config run. Grep for other readers of `config.agentCategory` on
  non-agent executions before PR 4, and keep the parentless-row fixture.
- **Historical workflow-script executions read as `agent` forever.** Accepted:
  that cohort is breakable, and it is today's behavior. No stream-id sniffing
  is built to heal it.
- **`descriptorFromConfig` rebuild quality.** After the PR 5 version bump,
  all v1 descriptors rebuild from config; a fabricated config yields a
  fabricated-looking label for old process/script rows. Accepted for breakable
  cohorts; agent rows rebuild faithfully because their configs are real.
- **Disk-scale numbers are not cited in this revision.** Revision 1 quoted 142
  of 478 descriptors affected by defect 1, from a measurement pass that was not
  re-run. Withdrawn pending measurement; nothing in the design depends on them.
