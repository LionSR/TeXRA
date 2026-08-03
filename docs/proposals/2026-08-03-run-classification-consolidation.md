# Run classification: six vocabularies to one

Status: proposed
Date: 2026-08-03

TeXRA has six overlapping ways to say "what kind of thing is running". Three of
them are false at most of their write sites, one is an untyped persisted string,
and the two hosts disagree about the taxonomy, so each rebuilds it at render
time. This proposal collapses them to a single discriminated union, gives every
field one writer, and makes both hosts render from one declared shape.

The trigger was a concrete failure: `delegate_multi_agents` cannot launch at all
on the `software-engineer` and `lean-project` teams, because a multi-agent script
run has to borrow a workflow agent's identity to describe itself, and those teams
declare `workflowAgents: []`.

## Problem

`AgentCategory` (`src/shared/schemas/agent.ts:10-16`) is a real and irreducible
fact about an _agent_: it is `AgentConfigSchema`'s persisted discriminant
(`src/agent/core/definition/AgentConfig.ts:67-70`). It is not a fact about a
_run_. A stream can carry a native agent, an external agent CLI, a background
bash process, or a deterministic multi-agent script, and only the first two are
agents at all.

`RunKind` (`src/shared/schemas/runDescriptor.ts:8`) is the correct axis and
already exists with the right three members. The problem is that nothing treats
it as authoritative.

| Vocabulary                                      | file:line                                                         | What it actually discriminates                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunKind` `{agent, process, workflowScript}`    | `runDescriptor.ts:8`                                              | What owns the stream. Correct, but module-private.                                                                                                                              |
| `RunDescriptor.agent` + `.category`             | `runDescriptor.ts:21-22`                                          | Nothing, for 2 of 3 kinds. `z.strictObject` demands both beside `kind`, so process and script runs fabricate them.                                                              |
| `RunConfigReferenceSchema`                      | `runDescriptor.ts:11-15`                                          | Nothing. Three persisted fields for one reachable value; `path` is hardcoded at `:47`.                                                                                          |
| `CreateChildStreamOptions.streamCategory`       | `src/tools/delegation/childStream.ts:27`                          | Nothing. False at 2 of 3 writers: `bash.ts:428` passes `ToolUse` beside `runKind: 'process'`; `WorkflowScriptTool.ts:426` passes `Workflow` beside `runKind: 'workflowScript'`. |
| `ExecutionMeta.category: z.string().optional()` | `src/shared/schemas/stream.ts:86`                                 | Mixes `'process'` (a RunKind) with `'toolUse'`/`'workflow'` (an AgentCategory) in one untyped persisted string.                                                                 |
| `StreamTabInfo.kind`                            | `stream.ts:300-317`                                               | The same three literals declared a second time, while the shared base still requires `agentCategory` on all three arms (`stream.ts:280`).                                       |
| `ProgressStreamRunDetails.kind`                 | `src/controllers/progressView/backend/ProgressViewState.ts:49-69` | The same three literals a third time, with correct per-arm payloads. This one is right; it is just downstream and host-local.                                                   |
| `StreamState.kind: AgentCategory`               | `src/shared/schemas/streamState.ts:206-209`                       | A field named `kind` carrying the other axis. `createStreamState` files everything non-ToolUse as Workflow (`:229-243`).                                                        |
| `isProcessAgent` over `Set(['bash'])`           | `src/shared/streams/agentKind.ts:14-18`                           | RunKind recovered by string-matching an agent name. Five production call sites.                                                                                                 |
| `resolveExecutionDisplayCategory`               | `src/tools/executionFormatters.ts:13-20`                          | A sixth spelling of the same decision.                                                                                                                                          |
| `DELEGATION_AVAILABILITY_CATEGORY`              | `src/shared/constants/delegationTools.ts:37-42`                   | `DELEGATION_TOOL_CATEGORY` plus one fabricated row mapping `delegate_multi_agents` to `Workflow`. This row is the admission gate that breaks the two code teams.                |
| CLI `StreamSlice.category`                      | `packages/cli/src/chat/tui/state/cliState.ts:188-191`             | The CLI's entire model. Cannot express process or workflowScript, so the TUI re-derives kind from a stream-id regex, a tool name, and transcript entry roles.                   |

Three consequences follow.

**Fabricated identity.** `bash.ts:409-413` invents an `AgentConfig` with
`agent: 'bash', agentCategory: ToolUse`. `WorkflowScriptTool.ts:353-356` borrows
a real workflow agent's name and source for the script run itself, which is why
`:287` requires a visible workflow agent and why the two code teams cannot use
the tool.

**Render-time reconstruction.** `ProgressViewState.ts:320-323` recovers the run
kind by calling `isProcessAgent(config.agent)`, and therefore can never yield
`workflowScript`. This is the "never compensate for a data-model problem at
render time" rule in CLAUDE.md, violated at the source of the progress model.

**Hosts disagree.** The extension models three kinds; the CLI models two and
gates workflow affordances on `AgentCategory.Workflow`
(`appInteractionPolicy.ts:286-288`, `App.tsx:310-313`). Each host, plus the
trace viewer, computes its own labels and icons.

### Two prior beliefs that did not survive checking

Recorded because both were load-bearing in earlier analysis.

- `texra.enabledAgents` and `texra.enabledToolUseAgents` have **no production
  reader**; the only hit in the tree is `src/test-kernel/common/WorktreeMemento.vitest.ts:34`.
  The live key is `texra.agentRosterSelection` (`src/shared/state/stateKeys.ts:21`).
  Any diagnosis resting on those two keys is unfounded. What is established is
  that the workflow roster resolves empty on these teams; the mechanism is not.
- `packages/trace-viewer/src/traceDataSchema.ts` does **not** hand-mirror
  `ExecutionMeta`. It is 38 lines that import `TraceDocumentSchema` from
  `@transcript`. The `_IsExact` breakage hazard is stale for that file.

## Non-goals

- **The roster `workflowAgents`/`toolUseAgents` pair collapse.** Roughly 25 field
  pairs and a genuine reduction, but it is the AgentCategory axis over
  _selectable agents_, a different problem needing a three-host wire change.
  Deferred to its own lane.
- **Making `config.json` a kind-union.** That would remove the last fabricated
  records but breaks every exported trace. Left open.
- **The five liveness enums and the `EXECUTION_STATUS`/`RUN_OUTCOME` bijection.**
  Untouched.

## Proposal

### One discriminant

New `src/shared/schemas/runIdentity.ts`. Each arm carries exactly the identity
that arm has.

```ts
export const RunIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    agent: AgentNameSchema,
    /** The only run-side survivor of AgentCategory, and true here. */
    category: AgentCategorySchema,
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

/** Display name for any kind. The one place a name is chosen. */
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

`RunDescriptor` becomes the wrapper, and `RunConfigReferenceSchema` collapses to
a derived path helper:

```ts
export const RUN_DESCRIPTOR_SCHEMA_VERSION = 2;

export const PersistedRunDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(RUN_DESCRIPTOR_SCHEMA_VERSION),
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema,
  identity: RunIdentitySchema,
});
```

### One chrome key, derived rather than enumerated

`src/shared/streams/runSurface.ts` replaces `agentKind.ts`. `RunSurface` is a
type-level composition, never persisted, so it is not a seventh vocabulary:
every member is an existing literal, and adding a `RunKind` or `AgentCategory`
member becomes a compile error at `RUN_SURFACE` rather than a silent
fallthrough.

```ts
export type RunSurface = Exclude<RunKind, 'agent'> | AgentCategory;

export const runSurface = (id: RunIdentity): RunSurface =>
  id.kind === 'agent' ? id.category : id.kind;

export interface RunSurfaceChrome {
  readonly icon: string;
  readonly label: string;
  readonly pane: 'outputs' | 'workPlan' | 'terminal' | 'phases';
  readonly resume: 'session' | 'relaunch' | 'none';
  readonly fileActions: boolean;
  readonly showsModel: boolean;
  readonly fullChildLog: boolean;
}

export const RUN_SURFACE: Readonly<Record<RunSurface, RunSurfaceChrome>>;
```

Structure comes from `kind`; chrome comes from `surface`. No host computes a
label, icon, toolbar, or pane.

## Ownership

| Concept                             | Single owner                                           | Permitted writer                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run identity                        | `runIdentity.ts`                                       | `buildRunDescriptor`, from exactly two sites (`childStream.ts:127`, `AgentRunLifecycle.ts:422`). Immutable after.                                                                                                                                                                                         |
| Config path for a run               | `runConfigPath(executionId)`                           | Nobody. Derived.                                                                                                                                                                                                                                                                                          |
| AgentCategory of an agent run       | `executions/{id}/config.json`                          | Agent resolution, once. **Today has two writers**: `normalizeWriterCategory` (`executionLifecycle.ts:50-63`) mutates persisted bytes at write time and no-ops when `!isAgentRegistryReady()` (`:55`), so the same bash run persists different bytes on different launches. That second writer is deleted. |
| Persisted run kind (execution)      | `ExecutionMeta.runKind`                                | `registerExecution` only, at birth. **Today four of six call sites omit `category`** (`agentCliShared.ts:197`, `subagentExecution.ts:165`, `WorkflowScriptTool.ts:371`, `inBandSubagentExecution.ts:446`), which is why no execution on disk is ever tagged `workflowScript`. Becomes required.           |
| Persisted run kind (stream)         | `streamData/{id}/meta.json` `.identity`                | `StreamSnapshotStore.writeMeta`. `descriptorFromConfig` stops being a writer.                                                                                                                                                                                                                             |
| Spawning tool                       | `RunIdentity.tool`                                     | The launcher, at construction. **Today `handle.toolName` (`ExecutionHandle.ts:112`) is a mutable slot assigned after publish** (`childStream.ts:166`). Deleted.                                                                                                                                           |
| Display naming, icon, label         | `buildStreamTabInfo` (`streamTabInfo.ts:28`)           | One producer; hosts consume verbatim. **Today the extension frontend, the CLI TUI and the trace viewer each compute their own.**                                                                                                                                                                          |
| Chrome tables                       | `RUN_SURFACE`                                          | Static. No fallback arm.                                                                                                                                                                                                                                                                                  |
| Terminal outcome                    | `finalizeRunTerminal` (`AgentRunLifecycle.ts:171-188`) | One, gated by `claimTerminalFinalize`. Unchanged.                                                                                                                                                                                                                                                         |
| Roster membership                   | `AgentRosterController` / `texra.agentRosterSelection` | Unchanged. Genuinely the AgentCategory axis.                                                                                                                                                                                                                                                              |
| Workflow-script checkpoint identity | `deriveWorkflowScriptCheckpointId`                     | `WorkflowScriptTool.ts:299-303`. Salt pinned to the resolved entry name.                                                                                                                                                                                                                                  |

## Declarative UI

Both hosts render from one shape (`StreamTabInfo`) and index one table
(`RUN_SURFACE`) by `surface`.

```ts
// StreamTabs.ts:129-134 — the only expression reading both axes at once
- info.kind === 'workflowScript' ? AGENT_DECORATORS.streamKinds.workflowScript
-                                : getAgentCategoryDecorator(info.agentCategory)
+ info.surface && RUN_SURFACE[info.surface]

// StreamHeader.ts:342-344
- TOOLBAR_BUTTONS[this.stream.agentCategory] ?? TOOLBAR_BUTTONS.workflow
+ TOOLBAR_BUTTONS[surface]                     // total Record, no fallback

// ProgressFactApplier.ts:639-693
- const kind = getStreamCategory(stream) ?? existingState?.kind ?? AgentCategory.Workflow;
+ switch (state.surface) { workflow | toolUse | process | workflowScript }
```

Re-keying `StreamState` is what makes `ProgressFactApplier.ts:642`'s
`?? AgentCategory.Workflow` genuinely deletable. Leaving `StreamState` on
AgentCategory makes that deletion impossible, because `getOrCreateStreamState`
still takes an AgentCategory and `ProgressViewState.ts:439-449` destroys
`conversationProgress` and the subagent roster on a category mismatch.

On the CLI side, `StreamSlice.category` becomes `identity: RunIdentity`. This
requires **adding** a run-identity fact to the NDJSON progress vocabulary:
`projectCliRunFact` returns `undefined` for `run.start`
(`sessionProgressSubscription.ts:74-83`) and `TUI_RUN_FACT_HANDLERS`
(`subscribeRuntimeHost.ts:144`) has no `run.start` key. The CLI does not receive
this today. Once it does, six reconstructions collapse:

| CLI reconstruction today                                                                                                               | Becomes                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `isFullLogChildStream` regex over four hardcoded prefixes (`subscribeStreamLog.ts:138-142`)                                            | `RUN_SURFACE[surface].fullChildLog`                                                         |
| `category === Workflow && entries.some(role === 'workflowTask')` (`App.tsx:310-313` and its byte-duplicate `SubagentList.tsx:727-731`) | `identity.kind === 'workflowScript'`                                                        |
| `view.toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME` (`StaticConversationTranscript.tsx:104-108`)                                       | `RUN_SURFACE[surface].label`                                                                |
| `session.toolName !== 'bash'` model suppression (`SubagentList.tsx:176-180`)                                                           | `RUN_SURFACE[surface].showsModel`                                                           |
| Two-hop AgentCategory walk (`appInteractionPolicy.ts:286-288`)                                                                         | `parent.identity.kind === 'workflowScript'`, one hop and correct                            |
| `category === ToolUse` offers resume (`resumeHint.ts:151`)                                                                             | `RUN_SURFACE[surface].resume === 'session'`, stops offering bash children as resume targets |

## Element count

Counting method: an element is one named declaration (schema, type, enum, table,
exported function, schema field, interface member) cited by `file:line`. Renames
and retypes count zero. Relocations from a union base onto an arm count zero on
both sides. Branch sites are counted separately.

- Deleted: **30 elements**
- Added: **14 elements**, 3 of them dated temporaries
- Net: **-16 now, -19 at legacy retirement**. One file deleted
  (`agentKind.ts`), two added; net files +1.
- Branch sites collapsed, counted separately: **22** render-time reconstructions
  plus **6** silent `?? Workflow` defaults.
- Vocabularies for "what is running": **6 to 1**. `StreamTabInfo.kind` and
  `ExecutionListingEntry.kind` remain as typed projections of
  `RunIdentity['kind']`, not independent declarations.

## Build order

**PR 1. Unblock `delegate_multi_agents`. No persisted-shape change.**
`WorkflowScriptToolInputSchema.agent` becomes `.nullish()`; `requireVisibleAgent`
becomes conditional; `runConfigPayload.agent` falls back to `meta.name`; a file
call that omits `agentName` with no default fails loudly; delete
`DELEGATION_AVAILABILITY_CATEGORY`. Ships with a fixture test pinning a known
`(meta.name, resolved agent name, parentExecutionId)` triple to its current
32-hex digest, plus a test that a source-qualified `input.agent` hashes
identically to its bare form. Fixes `software-engineer` and `lean-project`.

**PR 2. `RunIdentity` in the schema layer. Touches `streamData/meta.json`.**
Add `runIdentity.ts`; `RunDescriptor` carries `identity`; split
`STREAM_TAB_META_SCHEMA_VERSION` before bumping `RUN_DESCRIPTOR_SCHEMA_VERSION`
to 2; add the legacy arm at the existing read boundary
(`streamSnapshotRead.ts:105-113`). Collapse `CreateChildStreamOptions` to `run`;
the three launch sites pass the truth; delete `agentKind.ts`.

This PR also fixes a live defect: `kind` was added at `runDescriptor.ts:24`
without bumping the version at `:6`, so descriptors written before that change
fail the `z.strictObject` and are warn-and-dropped today. A sampled developer
bucket showed 142 of 478 affected.

**PR 3. `ExecutionMeta.runKind`. Touches `executions/*/meta.json`.**
Retype `category` to `runKind` with a v1 legacy arm (the legacy arm must still
declare `category`, or `z.object` strips it before the transform runs). Legacy
classification: `'process'` to process; `streamId` prefixed `workflow-script#`
to workflowScript; else agent. `registerExecution.runKind` required at all six
call sites. Delete `normalizeWriterCategory`, `runtimeCategory`,
`resolveExecutionDisplayCategory`. Add `TraceDocument.identity:
RunIdentitySchema.optional()`; optional is mandatory, because `parseTraceData`
throws and every previously exported `trace.json` lacks it. Run the trace-viewer
tsc, which the root typecheck does not cover.

**PR 4. Extension declares. No persisted data.**
`StreamTabInfo` arms plus `surface`; `RUN_SURFACE`; `StreamState` re-keyed to
four arms; delete both type guards, `StreamMetadataSchema.kind`, `streamKinds`,
`getAgentCategoryDecorator`, `ProgressStreamRunDetails`, and all six
`?? Workflow` defaults.

**PR 5. CLI wire. Sequence strictly: add before remove.**
Project a run-identity fact in `sessionProgressSubscription.ts` and handle it in
`subscribeRuntimeHost.ts`; add `StreamSlice.identity`; delete the five CLI
reconstructions. Only then, in a later PR, delete
`setActiveStream.agentCategory`. Check headless output parity per the
`texra-cli` skill. Import `RunIdentity` from `@shared/schemas/runIdentity`, never
a new `@agent/*` specifier (host-agent deep-import ratchet).

## Validation

- PR 1: the checkpoint-digest fixture test is the gate. Dogfood
  `delegate_multi_agents` on the `software-engineer` team with a structured-only
  script.
- PR 2 and 3: migration tests over legacy fixtures for both boundaries, asserting
  no `.catch` and loud failure on genuinely corrupt rows.
- PR 4 and 5: existing progress-view and TUI suites, plus headless parity.
- Whole change: `npm run typecheck` (builds do not type check) and the
  trace-viewer tsc.

## Risks and open questions

- **The checkpoint salt is load-bearing and invisible at review.** Making `agent`
  `.nullish()` makes it tempting to drop from the hash. That re-roots every
  checkpointId, executionId, executions directory, stream id and lease, and
  defeats the double-launch guard at `WorkflowScriptTool.ts:378`. The PR-1
  fixture test is not optional.
- **Deleting `normalizeWriterCategory` rests on one traced consumer.**
  `chatDefaults.loadHistoryDefaults` filters `isUserVisibleExecution` before
  reading `agentConfig.agentCategory`. Residual exposure is a parentless
  synthetic-config run. Grep for other readers of `config.agentCategory` on
  non-agent executions before PR 3, and add a test for a parentless row.
- **`config.json` keeps a fabricated record per non-agent run**
  (`bash.ts:409-413`, `codexConfig.ts:97`, `claudeAgentConfig.ts:248`). This
  design makes those non-authoritative but does not remove them.
- **Historical workflow-script executions.** The `workflow-script#` prefix
  recovery was verified from the write site, not by sampling a bucket. A cohort
  predating that write reads as `agent`, which is today's behavior, so not a
  regression, but the fix is forward-only.
- **`z.custom<RunSurface>()` on the wire** loses runtime validation of the
  surface key. The alternative is a hand-listed `z.enum`, which is exactly the
  extra vocabulary this proposal exists to avoid. Trade flagged, not hidden.
- **`ActiveChildInfo.kind` `{subagent, process}`** (`streamState.ts:62-71`)
  survives with no `workflowScript` member, so a script child's kind still leaks
  in through the optional `workflowPhase` field. A follow-up on the same axis.
- **Disk-scale numbers** (478 descriptors, 142 kind-less) come from one developer
  bucket in a prior measurement pass, not re-run for this proposal. They set
  migration expectations, not correctness; the legacy arms are total either way.
