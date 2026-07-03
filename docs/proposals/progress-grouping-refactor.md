# PRD: Progress-board grouping — remove the cross-trace footgun

> **Status:** Superseded (2026-07-04) by the landed progress-grouping fixes and
> the 2026-07 tech-debt tracking tree. R1/R2/R4 have landed:
> `TraceEmitter.stageScope` is per instance, orphan groups re-root in
> `messageIndex`, and usage falls back from `logger.activeStageId()` to the
> storage key. The proposed `Task:` stage deletion has also landed; `executeAgent`
> no longer opens that stage. Current residue is the module-level channel logger
> in `src/agent/runtime/executeAgent.ts` (`CHANNEL` + `createChannelTrace`), while
> typed round stages are owned by #6965. Treat the body below as historical
> evidence, not current implementation guidance.

## Background

A subagent run's progress-board transcript rendered blank except for the user
instruction: the round groups (`Init`, `r0`, `r1`) and every nested card
(scratchpad, statistics, latexdiff results, loaded-files) were missing.

Shipped fix (PR #4620): `beginRunStage` now opens the `"Run:"` stage with
`{ root: true }` so it does not inherit an ambient cross-trace parent.

That one-liner patches the symptom. This PRD targets the **class** of bug it
came from, with a bias toward **removing** mechanisms rather than adding them —
the end state should be a smaller, simpler grouping system that still works.

## Root cause

The bug is the product of three confirmed facts that compound.

1. **Module-level stage scope, shared across all traces.** (C1, supported)
   `src/agent/trace/TraceEmitter.ts:37` declares
   `const stageScope = new AsyncLocalStorage<string[]>()` at **module scope**
   (before the class at line 43; the class holds only the instance field
   `subscribers` at line 44). A single stack instance is therefore shared across
   _all_ `TraceEmitter` instances. `currentStageStack()` (`:39-41`) returns
   `stageScope.getStore() ?? []`. `emit()` (`:55-61`) stamps any event lacking a
   `stageId` with `currentStageStack().at(-1)`. `withStage()` (`:76-83`) pushes
   onto the stack via `stageScope.run([...currentStageStack(), stageId], ...)`.

2. **Parent resolution falls back to the ambient stage.** (C2, C3, supported)
   `openStage(label, options = {})` (`TraceEmitter.ts:175`) resolves the parent
   as `options.root ? undefined : (options.parent?.id ?? options.parentId ?? this.activeStageId())`
   (`:177-179`). `beginRunStage` (`AgentLaunchContext.ts:163-170`) ends with
   `return agentLogger.openStage(label, { root: true })`, so `root: true` forces
   `parentId === undefined` (the documented "ROOT INVARIANT" at
   `AgentLaunchContext.ts:156-161`).

3. **The subagent launch runs inside the orchestrator's ambient stage.** (C4,
   supported) `DelegationTools.ts:364` calls `executeAgent(...)` synchronously
   from inside the delegation tool's `execute()`. `executeAgent.ts:386` awaits
   `buildAgentLaunchContext(...)`, which calls `beginRunStage` via
   `assembleAgentLaunchContext` (`AgentLaunchContext.ts:245-249`). At that moment
   the orchestrator's own tool-use stage is the active ambient stage: the
   orchestrator opens `taskStage = logger.openStage("Task: ...")`
   (`executeAgent.ts:441`) and runs the whole tool-use flow inside
   `taskStage.run(...)` (`:444`), which pushes the Task stage id onto the shared
   `stageScope` (via `StageHandleImpl.run` → `within` → `withStage`,
   `TraceEmitter.ts:238-251, 76-83`). Without `{ root: true }`, the subagent's
   `"Run:"` stage would inherit `activeStageId()` (`:177-179, 72-74`) — the
   orchestrator's Task stage id, which lives on the orchestrator's trace, not on
   the subagent's own run trace (`createRunTrace` at `AgentLaunchContext.ts:223`).
   So the `"Run:"` stage inherited a `parentGroupId` absent from its own stream.
   Both docstrings (`AgentLaunchContext.ts:156-162`, `AgentTrace.ts:47-55`)
   describe this exact scenario.

4. **The renderer silently drops orphan subtrees.** (C5, supported)
   `messageIndex.rebuildTree`
   (`packages/extension/src/progressView/frontend/components/messageIndex.ts:72-137`)
   builds the tree only down from parentless roots:
   `this.tree = groups.filter((g) => !g.parentGroupId)...map(buildNode)`
   (`:128-129`). `buildNode` only descends through `childrenMap.get(group.id)`
   (`:114-124`), and `childrenMap` is keyed by `parentGroupId` (`:81-85`). A group
   whose `parentGroupId` points to a group **not** in the set is excluded from
   roots (its truthy `parentGroupId` fails the `:129` filter) and is filed under
   `childrenMap[<missing-parent-id>]`, which `buildNode` never queries. The orphan
   and its entire subtree are therefore never visited — **silently, with no
   warning, no logging, and no fallback**. This is why the failure was invisible.
   Worse, the orphan's messages are also lost: `:101` files a message into
   `messagesByGroup` whenever `groupMap.has(msg.groupId)` is true; the orphan group
   _is_ in `groupMap`, so its messages go to `messagesByGroup` (not `ungrouped`)
   and are never read into any tree node.

The original blank-transcript symptom (a `"Run: devise"` stage carrying a
`parentGroupId` with no matching group entry in its stream) is consistent with
this root cause. **Unconfirmed:** the specific persisted-streamLog evidence for
the `devise@opus48T#…` run (group id `0a171d9d…`) cited in the original draft was
not re-verified in this fact-check pass and should be treated as anecdotal.

## Goals

- Remove the cross-trace inheritance hazard **by construction**, not by
  per-call-site discipline.
- Make orphaned groups **render** (degrade gracefully) instead of vanishing.
- Net-negative LoC: delete the options/side-channels that become unnecessary
  (see Deletions enabled).
- Zero behavior change for the cases that already work (top-level runs,
  within-trace nesting, tool-use cards).

## Non-goals

- Rewriting the AgentTrace SDK surface or the recorder/store schema.
- Changing how the orchestrator displays subagents (background-tasks panel).

## Proposed changes

### R1 — Per-trace stage scope (highest leverage)

Move `stageScope` from a module-level singleton to a `private readonly stageScope`
field on `TraceEmitter`, and convert `currentStageStack()` into a private method
reading `this.stageScope`. Ambient parent-inheritance then works _within_ a trace
(the legitimate case) and is **structurally impossible across traces** (always the
wrong case).

**Feasibility (F-scope-readers): safe to make per-instance, risk MEDIUM.** No code
relies on the scope being **shared across distinct `TraceEmitter` instances**.
Each agent run creates its own emitter via `new TraceEmitter()` in
`createRunTrace`/`createChannelTrace` (`src/logger/runTrace.ts:29,49`), yet today
all instances share the one module-level scope. The only cross-instance
interactions — `src/tools/claudeAgent.ts:558` and `src/tools/codex.ts:557` — treat
that sharing as an **unwanted leak** they defend against with `{ root: true }`.
With a per-instance store, a fresh emitter starts empty, so its first `openStage`
naturally resolves `parentId = undefined` even without the flag; the leak
disappears by construction and `{ root: true }` becomes redundant-but-harmless
there. All same-instance nesting (ResponseCycle, outputState, reflection rounds,
`roundPersistedFlow`, `ModelHandler` streams) behaves identically because the push
and the read happen on the same instance within the same async activation.

**Why MEDIUM, not low:** (1) the existing regression test
(`RunTraceStream.vitest.ts:151-165`) uses a single shared logger and does **not**
exercise the true cross-_instance_ case, so it will not catch a per-instance
regression — we must add a two-instance test (below); (2) the child-session IIFEs
in `claudeAgent`/`codex` rely on `AsyncLocalStorage` propagation, so verify the
per-instance field is captured by the same instance the child loop calls (it is,
since `logger` is the child's own emitter).

In-file readers/writers of the scope to convert (`TraceEmitter.ts`):

- WRITERS: `withStage()` (`:82`), `openStream()` explicit-stageId branch (`:207`).
- READERS: `emit()` fallback (`:61`), `activeStageId()` (`:73`), `withStage()`
  pre-push read (`:81`), `openStage()` parentId default (`:179`), `openStream()`
  comparison (`:204-205`).

Downstream consumers of `activeStageId()` (unchanged, read whatever the
per-instance scope resolves to): `toolUseHelpers.ts:37`,
`ToolUseCycleFlow.ts:570,639`. `noopTrace.ts:43-44,61` is a separate no-op impl
with no shared scope — unaffected.

### R2 — Render orphans instead of dropping them (guardrail)

In `messageIndex.rebuildTree`, treat a group whose `parentGroupId` is not present
in `groupMap` as a **root** (attach at timeline top). This degrades gracefully
(rounds still show, just un-nested) and makes future orphan bugs visible. Pairs
with R1: R1 prevents the bug, R2 ensures the next one is at least seen.

**Feasibility (F-orphan-render): one-line change, risk LOW.** The single
load-bearing line is the root filter at `messageIndex.ts:129`. Change:

```ts
// before
this.tree = groups.filter((g) => !g.parentGroupId)...
// after
this.tree = groups.filter((g) => !g.parentGroupId || !groupMap.has(g.parentGroupId))...
```

`groupMap` is already built (`:76,80`) and in scope, so no new state is needed.
This pushes orphan groups — and, via `buildNode`, their children **and** their
messages from `messagesByGroup` — into `this.tree`; `rebuildTimeline`
(`:147-152`) then interleaves them at the top level by `group.startTime`. No
change needed to `rebuildTimeline`, `childrenMap` construction, or message
classification. No code or test relies on the drop: the only non-test callers
(`TaskGroupList.ts:200,223,244`) just render `this.tree`/`this.timeline`, and the
existing tests (`TaskGroupListIndex.vitest.ts:69,120`) use only self-consistent
inputs. `logSlice.ts:90,119` set `parentGroupId` from `entry.groupId` at
GROUP_START/GROUP_END with no guarantee the parent exists in the same snapshot —
confirming transient orphans (child arrives before parent, or parent pruned) are
real, so this is a correctness improvement, not dead defensiveness.

**Render-side (done):** `TaskGroupList.renderGroupNode` previously selected layout
via the raw `!group.parentGroupId` field, so a re-rooted orphan (which still has a
dangling `parentGroupId`) would render in the nested/collapsible style rather than
the root-container style. Fixed by passing an explicit `isRoot` flag down from the
single top-level caller (the timeline render) and branching on that — layout now
follows actual tree position, not the raw field. Covered by a render test in
`TaskGroupListIndex.vitest.ts`.

A dev-mode warning when re-rooting is optional; if added, it must respect the
"stateless renderer / no render-time side effects" rule and live in the
data-building path, not in a component render.

### R3 — Collapse the dual trace in `executeAgent` (remove a footgun)

`executeAgent.ts:65-66` keeps a module-level `logger = createChannelTrace(CHANNEL)`
alongside the recorder-attached run trace `ctx.logger`. (C6, supported)
`createChannelTrace` (`src/logger/runTrace.ts:28-32`) attaches **only** a channel
subscriber — no transcript recorder — whereas `createRunTrace` (`:49-54`) attaches
**both** a channel subscriber and `attachTranscriptRecorder`. (C7, supported)
`ctx.logger` is the run trace: `AgentLaunchContext.ts:223-225,295`.

The `"Task:"` stage at `executeAgent.ts:441` is opened on the module-level channel
`logger`, **not** on `ctx.logger`, so its `stage.start`/`stage.end` events reach
the per-channel output sink but **never** the webview/CLI transcript. The
actually visible top-level stage is `ctx.parentStage` = `"Run: <agent>"`, opened
on the run trace via `beginRunStage` (`AgentLaunchContext.ts:245-249`). The rounds
parent **explicitly** to `ctx.parentStage` (C10, supported): `runReflectionFlow`
forwards `parentStage` into `RoundPersistedFlow`, whose `createRoundStage` opens
each round with `{ parent }` (`runReflectionFlow.ts:245-258`,
`roundPersistedFlow.ts:256-261`). The channel `taskStage` merely wraps the flow
via `taskStage.run(...)` and is never passed as the round parent — so it is inert
in the transcript today, which is precisely the trap.

**Feasibility (F-task-stage): safe to delete the `"Task:"` stage and the
module-level channel logger, risk LOW.** `taskStage` is a pure local: defined at
`:441`, consumed only at `:444`; its `.id` is never read, stored, or returned, and
grep for `taskStage` returns only those two lines. The `"Task:"` label is
special-cased nowhere. The `.run` wrapping is **not** load-bearing: inner flows
root their stages off `ctx.parentStage`/`ctx.logger`, not off the ambient
`activeStageId`, so removing `taskStage.run` and inlining its body changes neither
transcript output nor the round hierarchy.

Concrete change:

1. Drop `taskStage = logger.openStage('Task: ...')` (`:441`) and inline its body
   (replace `return taskStage.run(async () => {...})` with the body directly).
2. Redirect the diagnostic calls on the module-level `logger`
   (`:198,274,422,423,424,427,445`) to `ctx.logger` — each is inside a closure
   where `ctx` is in scope, and `ctx.logger` exposes `debug/info/warn/error`
   (`AgentTrace.ts:146-149`). `:216` already uses `ctx.logger` (`logSdkError`).
3. Then remove `CHANNEL` (`:65`), `logger` (`:66`), and the `createChannelTrace`
   import (`:26`).

The one judgment call: those diagnostics currently land on the dedicated
`'executeAgent'` channel sink, whereas `ctx.logger` writes to the per-stream
channel + transcript. If a dedicated `'executeAgent'` debug channel is wanted,
keep the module-level `logger` for the plain log calls and delete only the
`openStage`/`run` wrapping. Risk is LOW because no machine-readable consumer
(id, label match) exists.

### R4 — Fold the usage groupId side-channel into the stage handle

Statistics/usage grouping currently uses an explicit
`usageMonitor.setActiveGroupId(stage.id)` wired in the `onStageCreated` callback
(`runReflectionFlow.ts:256-258`). (C8, supported) Once R1 makes within-trace
ambient stamping reliable, this parallel channel is redundant.

**Feasibility (F-setActiveGroupId): safe to delete, risk LOW.** The mechanism has
exactly five references repo-wide: field decl `UsageMonitor.ts:88`; sole writer
`setActiveGroupId` (`:106-108`); sole reader
`logger.usage(payload, { stageId: this.activeGroupId ?? storageKey })` (`:180`),
gated on `AgentCategory.Workflow` (`:178`); and the sole caller
`runReflectionFlow.ts:257`. No subclasses, no tests, no serialization, no other
consumers.

The normal stage scope already covers this: the value passed is `stage.id` from
`createRoundStage` = `logger.openStage('r${roundIndex}', { parent })`;
`RoundPersistedFlow` runs every node inside that round stage's scope via
`inStage()` → `within()` (`roundPersistedFlow.ts:124-129,181,191`); `recordUsage`
fires through `onRoundFinalized` on both the success path
(`ResponseCycleFlow.ts:455-457`) and error path (`ResponseCycleNode.ts:121`),
both inside node execution (i.e. inside the round-stage scope, which
`AsyncLocalStorage` propagates across awaits); and `TraceEmitter.emit`
(`:55-61`) already stamps `stageId` from `currentStageStack().at(-1)` — the exact
same round stage id `setActiveGroupId` stored. The tool-use path is unaffected:
it uses plain `PersistedFlow`, never calls `setActiveGroupId`, and `recordUsage`
skips `logger.usage` entirely for `AgentCategory.ToolUse` (`:178`).

Concrete change:

1. Delete `UsageMonitor.ts:88` (field) and `:100-108` (`setActiveGroupId`).
2. Delete the `onStageCreated` block at `runReflectionFlow.ts:256-258` (and drop
   `usageMonitor` from that closure if otherwise unused).
3. At `UsageMonitor.ts:179-181`, replace
   `logger.usage(payload, { stageId: this.activeGroupId ?? storageKey })` with
   `logger.usage(payload, { stageId: logger.activeStageId() ?? storageKey })`.

**Behavioral nuance:** the current fallback is `this.activeGroupId ?? storageKey`.
A bare `logger.usage(payload)` would stamp `activeStageId() ?? undefined`, losing
the `storageKey` safety net for any hypothetical future workflow caller that logs
usage **outside** a round stage. In all current paths a round stage is always
active when workflow usage is logged, so the result is identical — but using
`logger.activeStageId() ?? storageKey` (step 3 above) preserves the `storageKey`
fallback defensively. Risk is LOW and confined to workflow-agent usage-line
grouping in the transcript.

## Recorder ↔ slice contract (document, no code change)

(C9, supported) `TexraTranscriptRecorder.ts:156-168` appends a `GROUP_START`
entry on `stage.start` and `:170-178` updates the **same** `event.id` in place to
`GROUP_END` on `stage.end`, with `status` and `endTime`. So one store entry
transitions GROUP_START → GROUP_END in place; the persisted shape therefore
differs between a mid-run reload (GROUP_START present) and a post-run snapshot
(already GROUP_END). The slice tolerates a GROUP_END arriving with no prior
GROUP_START: `logSlice.ts:102-131` (`updateTaskGroups`), after the
`if (entry.type !== GROUP_END) return false;` guard, handles `groupIndex === -1`
by **creating** a new task group (`:112-121`) instead of failing; otherwise it
updates the existing group (`:122`). This implicit recorder↔slice contract should
be documented in both files.

## Sequencing

1. **R1 + R2 together** (structural fix + guardrail) in one PR, separate from the
   shipped #4620 one-liner. **Do not** revert the `{ root: true }` flag at
   `AgentLaunchContext.ts:169` until R1 has landed and the new cross-instance test
   is green — see Deletions enabled for why the flag is only safe to remove after
   per-instance scoping is verified.
2. R3, then R4 as independent follow-ups. R4's redundancy argument depends on R1,
   so land R4 after R1.

## Test plan

- Existing coverage: `src/test-kernel/agent/trace/RunTraceStream.vitest.ts`
  (`within`/`openStage`/`root` at `:119-165`, tool-use card groupId,
  stream coalescing), `RunTraceDispose.vitest.ts:24` (openStream),
  `EmitToolUseCard.vitest.ts:15-75` (multiple `new TraceEmitter()` instances).
  Note: `RunTraceStream.vitest.ts:151-165` uses a single shared logger, so it does
  **not** exercise the cross-instance leak.
- **Add a cross-instance test (required for R1):** push a stage on emitter A,
  then `openStage`/`activeStageId` on a separate emitter B; assert B's stage is a
  root (`parentId === undefined`) **without** `{ root: true }`. This is the gate
  that confirms per-instance scoping closes the leak.
- **Add a `rebuildTree` orphan test (required for R2):** a group with a dangling
  `parentGroupId` plus a message under it; assert it appears at timeline top with
  its message intact. None exists today.
- After per-instance scoping lands, verify child-agent transcripts still group
  correctly (the `claudeAgent`/`codex` session scenario) before removing the
  `root` option.
- `npm run typecheck`; targeted `vitest run` on the trace + progressView suites.

## Fact-check summary

| Claim                   | Verdict     | One-line                                                                                                                                                    |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1                      | supported   | `stageScope` is module-level (`TraceEmitter.ts:37`), shared across all instances; `emit()` `:55-61`, `withStage()` `:76-83`.                                |
| C2                      | supported   | `openStage` parent resolution `options.root ? undefined : (...?? this.activeStageId())` at `:177-179` (sig `:175`).                                         |
| C3                      | supported   | `beginRunStage` opens with `{ root: true }` (`AgentLaunchContext.ts:163-170`), yielding `parentId === undefined`.                                           |
| C4                      | supported   | Subagent launch runs inside the orchestrator's `taskStage.run` scope; without `root` it would inherit the cross-trace Task id.                              |
| C5                      | supported   | `rebuildTree` root filter `:128-129` + `buildNode` `:114-124` silently drop orphan subtrees (and their messages, `:101`); no warning/fallback.              |
| C6                      | supported   | `executeAgent.ts:65-66` module-level channel `logger`; `taskStage` opened on it at `:441`, never on `ctx.logger`.                                           |
| C7                      | supported   | `createChannelTrace` = channel sink only (`runTrace.ts:28-32`); `createRunTrace` = channel + transcript recorder (`:49-54`).                                |
| C8                      | supported   | Usage grouping wired via `onStageCreated → setActiveGroupId(stage.id)` (`runReflectionFlow.ts:256-258`; `UsageMonitor.ts:106`).                             |
| C9                      | supported   | Recorder collapses GROUP_START→GROUP_END on one id in place (`TexraTranscriptRecorder.ts:156-178`); slice tolerates lone GROUP_END (`logSlice.ts:102-131`). |
| C10                     | supported   | Rounds parent explicitly to `ctx.parentStage` (`runReflectionFlow.ts:245-258`, `roundPersistedFlow.ts:256-261`); channel `taskStage` is inert.              |
| C11                     | supported   | `StageOptions.root` doc (`AgentTrace.ts:47-55`) describes the cross-trace child-agent-session case verbatim.                                                |
| EVID (devise streamLog) | unconfirmed | Specific `devise@opus48T#…` / `0a171d9d…` persisted-log evidence not re-verified in this pass; treat as anecdotal.                                          |

## Deletions enabled

Each item lists the concrete declarations/call-sites to remove and the safety
verdict. Net effect is negative LoC.

- **`{ root: true }` at `AgentLaunchContext.ts:169`** — _conditional, risk MEDIUM_
  (F-root-callers). Safe to revert **only after** R1 makes `stageScope`
  per-instance and the cross-instance test passes. If reverted while the scope is
  still a module singleton, the `"Run:"` subtree re-orphans (real regression).
- **The `root` option entirely** — _conditional, risk MEDIUM_ (F-root-callers).
  Sole reader is the branch at `TraceEmitter.ts:177-179`. Three production callers
  pass `{ root: true }`, all for the same cross-trace reason:
  `AgentLaunchContext.ts:169`, `claudeAgent.ts:558`, `codex.ts:557`. No
  within-trace caller needs it (the only same-trace use is the synthetic vitest at
  `RunTraceStream.vitest.ts:155`). After per-instance scoping, the option is
  removable: delete the field + doc (`AgentTrace.ts:47-55`), collapse the
  `:177-179` branch to `options.parent?.id ?? options.parentId ?? this.activeStageId()`,
  change the 3 callers to pass `{}`, and delete the vitest block (`:143-166`).
  Keeping `{ root: true }` as documented defensive intent at the two child-tool
  sites is acceptable (belt-and-suspenders); deleting it is the net-negative-LoC
  path.
- **Module-level `logger` / `createChannelTrace` import in `executeAgent.ts`** —
  _safe, risk LOW_ (F-task-stage). Delete the `"Task:"` `openStage` (`:441`) and
  its `.run` wrapping (inline the body), redirect diagnostics
  (`:198,274,422,423,424,427,445`) to `ctx.logger`, then remove `CHANNEL` (`:65`),
  `logger` (`:66`), and the import (`:26`). Caveat: this moves those diagnostics
  off the dedicated `'executeAgent'` channel sink onto the per-stream
  channel+transcript; keep the module-level logger for plain log calls if a
  dedicated debug channel is wanted, and delete only the stage wrapping.
- **`setActiveGroupId` + `activeGroupId` field + `onStageCreated` plumbing** —
  _safe, risk LOW_ (F-setActiveGroupId). Delete `UsageMonitor.ts:88` and
  `:100-108`, delete `runReflectionFlow.ts:256-258`, and change `UsageMonitor.ts:180`
  to `logger.usage(payload, { stageId: logger.activeStageId() ?? storageKey })`.
  The round-stage `AsyncLocalStorage` scope already stamps the same id. Only the
  `storageKey` fallback for hypothetical out-of-round workflow usage differs;
  the suggested replacement preserves it.
- **Orphan-drop behavior in `rebuildTree`** — _not a deletion; a one-line fix_
  (F-orphan-render). `messageIndex.ts:129`: add `|| !groupMap.has(g.parentGroupId)`
  to the root predicate. No state added (`groupMap` already in scope); no caller
  or test relies on the drop.
