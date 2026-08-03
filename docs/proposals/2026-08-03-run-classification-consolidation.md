# One authoritative run identity, with typed projections

Status: proposed
Date: 2026-08-03
Revision: 2 (narrowed after review, 2026-08-03)

TeXRA classifies "what kind of thing is running" in six places. Three of them
are false at most of their write sites, one is an untyped persisted string, and
no single one is authoritative, so each host reconstructs the fact at render
time.

This proposal establishes **one validated, durably owned run identity** in the
shared layer, and leaves presentation to each host. It does not claim to reduce
the taxonomy to a single element: `AgentCategory` remains, and several typed
projections of the identity remain by design. The honest statement of the result
is one authority plus derived projections, not "six vocabularies to one".

## Revision note

Revision 1 proposed a shared `RUN_SURFACE` chrome table, a `surface` key on the
wire, and a five-PR programme whose first stage changed
`delegate_multi_agents` nullability. Review rejected that scope. This revision:

- keeps the shared layer to run identity only, and lets each host project its
  own UI policy;
- removes the weakly validated `surface` from anything persisted or transmitted;
- names one durable authority and gives every remaining copy a stated contract
  and an enforced derivation;
- dates every compatibility reader with an explicit retirement condition;
- removes the workflow-roster fix from this proposal entirely.

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

## Scope

**In scope.** One validated run identity in the shared layer, owned durably in
one place; one dated compatibility reader for the descriptor break; deletion of
the fabricated and reconstructed classifications that the identity replaces;
host-local projections.

**Explicitly out of scope.**

- **A shared UI policy table.** Revision 1's `RUN_SURFACE` combined identity with
  pane, resume, file-action, model-display and child-log policy. Those are host
  decisions. Each host projects its own UI from the parsed identity. A shared
  table returns only for behavior demonstrably identical across hosts, proven
  case by case, not assumed.
- **A `surface` key on any wire or persisted shape.** Derive it locally after
  parsing `RunIdentity`. If some boundary genuinely needs it, it gets a real
  runtime schema, not `z.custom`.
- **The workflow-roster failure.** Handled separately, after causal
  reproduction. See "Separated work".
- **The roster `workflowAgents`/`toolUseAgents` pair collapse**, and making
  `config.json` a kind-union. Different axes.

## Target model

### One identity

New `src/shared/schemas/runIdentity.ts`.

```ts
export const RunIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    agent: AgentNameSchema,
    /** How the agent executes. See "Why the agent arm carries category". */
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
a derived path helper (`runConfigPath(executionId)`), since it had three
persisted fields for one reachable value.

### One durable authority

The authority is **`ExecutionMeta`**, written exactly once at birth by
`registerExecution` inside the fresh-lease scope. Every other appearance of the
identity is a projection, and each must satisfy both tests the review set: a
necessary contract, and a derivation enforced in code rather than by convention.

| Appearance                             | Contract that makes it necessary                                                                                                                              | Enforced derivation                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionMeta.identity`               | The authority. Durable, written once at birth.                                                                                                                | Sole writer is `registerExecution`, inside the lease.                                                                                                                       |
| `streamData/{id}/meta.json` descriptor | Display renders before the run config snapshot resolves. `streamTabInfo.ts:36-42` documents exactly this window, and today fills it by parsing the stream ID. | Constructed by `buildRunDescriptor` from the same `RunIdentity` value passed to `registerExecution`, at one call site (`childStream.ts:128`). Never independently authored. |
| `trace.json` `identity`                | An exported trace is a standalone artifact with no access to `~/.texra`.                                                                                      | Written by the exporter, read from `ExecutionMeta` at export time. Optional in the schema, because every previously exported trace lacks it and `parseTraceData` throws.    |

Everything else that currently restates the fact is deleted rather than
projected: `CreateChildStreamOptions.streamCategory`, `ExecutionMeta.category`
as an untyped string, `StreamMetadataSchema.kind`, `isProcessAgent`, and
`resolveExecutionDisplayCategory`.

### Why the agent arm carries category, and why it cannot go stale

Carrying `category` inside the identity is a second persisted copy of a fact
`config.json` already owns, which review flagged as a divergence risk. It is
kept, for one reason with one enforcement:

The contract is the same early-render window as the descriptor. `streamTabInfo.ts:32`
reads `metadata.agentCategory` today precisely because `run` is undefined until
the config snapshot resolves. Removing the copy would not remove the need; it
would push display back onto a different copy or another name-parsing guess.

The divergence risk is real only while `config.json`'s category has two writers.
It has two today: agent resolution, and `normalizeWriterCategory`
(`src/agent/storage/executionLifecycle.ts:50`), which mutates persisted bytes at
write time and no-ops when `!isAgentRegistryReady()` (`:55`), so the same bash
run can persist different bytes on different launches. **The enforcement is
sequencing: `identity.category` is introduced only in the stage that deletes
`normalizeWriterCategory`.** There is never a window in which a frozen copy and a
correctable copy coexist. If that sequencing cannot hold, the copy must be
dropped and display must load the config, and this section is the record of that
decision rather than an assumption.

## Host projections

The shared layer's guarantee is that both hosts start from the same parsed,
validated `RunIdentity` instead of reconstructing it. What each host renders
from it stays local.

**Extension.** `buildStreamTabInfo` remains the one producer of display naming
for that host. It reads `identity` instead of parsing `streamId.split('@')[0]`
and calling `isProcessAgent`. Pane selection, toolbar contents and progress
state keying stay in the extension.

**CLI.** `StreamSlice.category: AgentCategory | undefined` becomes
`identity: RunIdentity | undefined`. This requires **adding** a run-identity fact
to the NDJSON progress vocabulary: `projectCliRunFact` returns `undefined` for
`run.start` (`sessionProgressSubscription.ts:74-83`) and `TUI_RUN_FACT_HANDLERS`
(`subscribeRuntimeHost.ts:144`) has no `run.start` key. The CLI does not receive
this today. Once it does, these local reconstructions collapse, each to CLI-local
logic:

| CLI reconstruction today                                                                                                                 | Replaced by                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `isFullLogChildStream` regex over four hardcoded stream prefixes (`subscribeStreamLog.ts:138-142`)                                       | a CLI predicate over `identity.kind`                 |
| `category === Workflow && entries.some(role === 'workflowTask')` (`App.tsx:310-313`, byte-duplicate at `panes/SubagentList.tsx:728-732`) | `identity.kind === 'workflowScript'`                 |
| `view.toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME` (`StaticConversationTranscript.tsx:104-108`)                                         | `identity.kind === 'workflowScript'`                 |
| `session.toolName !== 'bash'` model suppression (`SubagentList.tsx:176-180`)                                                             | `identity.kind !== 'process'`                        |
| Two-hop AgentCategory walk (`appInteractionPolicy.ts:286-288`)                                                                           | `parent.identity.kind === 'workflowScript'`, one hop |
| `category === ToolUse` offers resume (`resumeHint.ts:151`)                                                                               | a CLI resume predicate over `identity`               |

Where the two hosts turn out to make the identical decision from the identity,
that is an observation to be proven later, not a shared table to be built now.

## Compatibility readers

Every temporary reader is listed here with its introduction date, its exact
retirement condition, and a retirement date. A reader without all three does not
ship.

| Reader                                                          | Introduced | Retirement condition                                                                                                                                                                       | Retire by  |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Legacy descriptor arm at `streamSnapshotRead.ts:105-113`        | 2026-08-03 | Covers only descriptors written before `kind` was added at `runDescriptor.ts:24`. Retired unconditionally on the date, deleting the legacy schema arm, its fixture, and its test together. | 2026-11-03 |
| `ExecutionMeta` v1 legacy arm (`category` to `identity`)        | 2026-08-03 | Same window. The legacy arm must still declare `category`, or `z.object` strips it before the transform runs.                                                                              | 2026-11-03 |
| `legacyRunIdentity` for `trace.json` exports lacking `identity` | 2026-08-03 | **Permanent by nature**, because an exported trace is an immutable artifact. Confined to the trace read boundary and to nowhere else.                                                      | never      |

The descriptor and `ExecutionMeta` readers are scheduled deletions, not
scaffolding that quietly becomes permanent. Revision 1 argued the descriptor
reader should be permanent because the descriptor is a derived projection; review
rejected that, and the dated window replaces it. The consequence to accept is
that descriptors older than the window are dropped rather than healed, which is
already today's behavior for those rows.

## Result, stated honestly

This does not collapse the taxonomy to one element.

**What becomes singular:** the run identity has one durable authority
(`ExecutionMeta`) and one validated schema (`RunIdentitySchema`). Today no
declaration is authoritative and none is validated at a boundary.

**What remains, by design:** `AgentCategory`, unchanged, as a fact about agents
and `AgentConfigSchema`'s discriminant. `StreamTabInfo.kind` and
`ExecutionListingEntry.kind` remain as typed projections of `RunIdentity['kind']`
rather than independent declarations. Each host keeps its own presentation
types.

**What is deleted outright:** `streamCategory`, `ExecutionMeta.category` as an
untyped string, `StreamMetadataSchema.kind`, `isProcessAgent` and its five call
sites, `resolveExecutionDisplayCategory`, `normalizeWriterCategory`,
`RunConfigReferenceSchema`, the `handle.toolName` mutable slot, and the
`DELEGATION_AVAILABILITY_CATEGORY` fabricated row.

**Counting.** Revision 1 claimed a net of -16 elements. That number included
host-local branch collapses credited to a shared table this revision no longer
builds, so it is withdrawn rather than restated. The measured figures that stand
on their own: 6 independent classification declarations reduced to 1 authority
plus typed projections; 2 live defects fixed; 5 `isProcessAgent` call sites and 6
`?? AgentCategory.Workflow` silent defaults removed. The per-stage element delta
will be counted in each PR against the tree at that time, not projected here.

## Build order

**Stage 1. `RunIdentity` in the shared layer. Touches `streamData/meta.json`.**
Add `runIdentity.ts`. `RunDescriptor` carries `identity`. Split
`STREAM_TAB_META_SCHEMA_VERSION` (keep it at 1) before bumping
`RUN_DESCRIPTOR_SCHEMA_VERSION` to 2. Add the dated legacy arm at
`streamSnapshotRead.ts:105-113`, with its retirement test. Collapse
`CreateChildStreamOptions` to a single `run` field; the three launch sites pass
the truth; delete `agentKind.ts`. Fixes live defect 1.

**Stage 2. `ExecutionMeta.identity` as the authority. Touches
`executions/*/meta.json`.** Retype `category` to the identity with its dated v1
arm. Legacy classification: `'process'` to process; `streamId` prefixed
`workflow-script#` to workflowScript; else agent. `registerExecution` requires
the identity at all six call sites. Delete `normalizeWriterCategory` and
`runtimeCategory` in the same stage that introduces `identity.category`, per the
sequencing above. Delete `resolveExecutionDisplayCategory`. Add
`TraceDocument.identity` as optional. Run the trace-viewer tsc, which the root
typecheck does not cover. Fixes live defect 2.

**Stage 3. Host projections. No persisted data.** Extension reads `identity` in
`buildStreamTabInfo`; delete `ProgressStreamRunDetails`,
`StreamMetadataSchema.kind`, and the `?? AgentCategory.Workflow` defaults. Then,
separately, the CLI: add the run-identity fact to the progress vocabulary and
handle it, add `StreamSlice.identity`, delete the five CLI reconstructions, and
only in a later PR delete `setActiveStream.agentCategory`. Add before remove,
strictly. Check headless output parity per the `texra-cli` skill. Import
`RunIdentity` from `@shared/schemas/runIdentity`, never a new `@agent/*`
specifier (host-agent deep-import ratchet).

## Separated work

**The workflow-roster failure is not part of this proposal.** Revision 1 opened
with a stage that made `WorkflowScriptToolInputSchema.agent` nullish to unblock
`delegate_multi_agents` on `software-engineer` and `lean-project`. Review
correctly objected that this doc states the empty-roster mechanism is not
established, and that changing nullability before reproducing the cause at the
true boundary is premature.

The correct sequence for that work, on its own track:

1. Reproduce the empty roster deterministically and identify the boundary that
   produces it, distinguishing the roster selection resolution
   (`AgentRosterController`, `texra.agentRosterSelection`) from the admission
   gate (`WorkflowScriptTool.ts:287`, `DELEGATION_AVAILABILITY_CATEGORY`).
2. Fix at whichever boundary the reproduction implicates.
3. Only then decide whether nullability changes, and whether the checkpoint
   fixture test is needed.

That last point matters regardless of ordering:
`deriveWorkflowScriptCheckpointId` salts on the resolved agent name and feeds
`deriveExecutionId`, hence the executions directory, stream id and lease. Any
change in that area that alters the salt re-roots every checkpoint and defeats
the double-launch guard at `WorkflowScriptTool.ts:378`.

## Risks and open questions

- **`identity.category` sequencing is load-bearing.** If Stage 2 cannot delete
  `normalizeWriterCategory` in the same PR that introduces `identity.category`,
  the copy must be dropped rather than shipped alongside a second writer.
- **Deleting `normalizeWriterCategory` rests on one traced consumer.**
  `chatDefaults.loadHistoryDefaults` filters `isUserVisibleExecution` before
  reading `agentConfig.agentCategory`. Residual exposure is a parentless
  synthetic-config run. Grep for other readers of `config.agentCategory` on
  non-agent executions before Stage 2, and add a test for a parentless row.
- **`config.json` keeps a fabricated record per non-agent run**
  (`bash.ts:409-413`, `codexConfig.ts:97`, `claudeAgentConfig.ts:248`). This
  design makes those non-authoritative but does not remove them.
- **Historical workflow-script executions.** The `workflow-script#` prefix
  recovery was verified from the write site, not by sampling a bucket. A cohort
  predating that write reads as `agent`, which is today's behavior.
- **`ActiveChildInfo.kind` `{subagent, process}`** (`streamState.ts:62-71`)
  survives with no `workflowScript` member, so a script child's kind still leaks
  in through the optional `workflowPhase` field. A follow-up on the same axis.
- **Disk-scale numbers are not cited in this revision.** Revision 1 quoted 142 of
  478 descriptors affected by defect 1, from a prior measurement pass that was
  not re-run. Those figures are withdrawn pending measurement. The legacy arms
  are total either way, so nothing in the design depends on them.
