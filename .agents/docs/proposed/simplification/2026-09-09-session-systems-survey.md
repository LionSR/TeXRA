---
created: 2026-09-09
updated: 2026-09-09
status: proposed
---

# Session systems: three design-level simplifications

> **Status:** surveyed on `main` at `98afef5a7a` on 2026-09-09. Five agents read
> the session tier in disjoint scopes: `src/shared/session/`,
> `src/controllers/session/`, the session-owning half of `src/agent/runtime/`,
> the session and stream schema vocabulary, and how the four hosts consume the
> fold. Every consumer count below was grepped, and the load-bearing claims were
> re-checked by hand. The bounded deletions from the same survey are filed as
> issues #12177, #12178, #12179, #12180, #12181 and #12182. This document holds
> only the three candidates that need an owner ruling before anyone writes code.

The survey ran against the governing PRD,
[`../../implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md`](../../implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md).
One correction to the record it is worth stating up front: lanes 5 and 8 landed
(lane 5 via #11881 and #11884, lane 8 via #11883, #11917 and #11911), even
though tracking issues #11864 and #11866 remain open. Everything below is
residue of a landed lane, not lane work.

## 1. Two exit choreographies for one fact

Ending a session's live runs durably is implemented twice, and neither
implementation is a superset of the other.

`closeSession` (`src/controllers/session/sessionLayer.ts:647-742`) closes
admissions, kills each root execution, waits for settlement inside a budget,
flushes, and releases. When the budget expires it reports `abandoned` and writes
no outcome, so the runs stay durably RUNNING.

`settleLiveSessionExecutions` (`src/agent/runtime/SessionHandle.ts:856-959`)
never kills. It force-writes `RUN_OUTCOME.CANCELLED` with
`keepExistingOutcome: true` under the lease and publishes closure facts for the
still-open transcript entries. Its own comment concedes the consequence at
`SessionHandle.ts:850-851`: "A driver that writes a different outcome after this
settlement remains a separate lifecycle race."

The split is not by host but by trigger. Host quit runs only the second path,
registered by all four hosts at `src/tools/agentCliSessionStores.ts:119-121`,
followed by `teardownDefaultSession` and `disposeProcessRuntime`. The first path
is reached only by the SDK's `closeSession` and the desktop's per-paper close.

The reason the second path exists is stated at `agentCliSessionStores.ts:92-97`:
without it a live execution's outcome goes un-persisted, "which surfaces later
as a run stuck in RUNNING with no owner". That is precisely the gap in the first
path's `abandoned` branch.

**Proposal.** One owner, `closeSession`. Move the force-settle body into its
post-budget `abandoned` branch, then make the hosts' shutdown handler close each
open root rather than calling `settleLiveSessionExecutions`. That deletes
`settleLiveSessionExecutions`, `liveSessions`, `forEachLiveSession` and
`teardownDefaultSession`, and it closes the documented race: a close interrupts
before it force-writes, so no driver is still running when the CANCELLED lands.

**What we give up.** Host shutdown ordering is load-bearing and explicitly
documented ("Do not reorder these two calls",
`agentCliSessionStores.ts:100-101`). Two remaining `forEachLiveSession` sweeps,
`killBackgroundProcesses` and the agent-CLI registry interrupt
(`agentCliSessionStores.ts:58-68`), plus the "a non-default session was live"
diagnostic (`SessionHandle.ts:1008-1020`), need either a synchronous session
list or a home inside `closeSession`.

**Acceptance.** One durable outcome per run after every quit path, including the
budget-expiry path that writes nothing today. Roughly 80 lines net, three fewer
exported functions, one fewer module-level Set, one fewer lifecycle race.

**Risk: high.** This is the last thing guaranteeing a durable outcome at quit.
It needs an owner ruling, not a PR.

Dedupe: #11347 (closed) collapsed the handler wiring into
`registerRuntimeShutdownHandlers`; this is the step it did not take. #11368
(closed) only documented the ordering. #12014 concerns `closeSession` not
draining publications and reads as separately resolved on `main`.

## 2. Three folds of the same durable rows

The ruling is unambiguous: "There is no mirror of a fold anywhere" (§2), and
"The database keeps only `event` and `event_sequence`. Every surface is a fold"
(§1). Two stores in `src/transcript/` are folds of the same rows into the same
facts as `sessionFold`.

`StreamSnapshotStore.apply` (`src/transcript/StreamSnapshotStore.ts:65-119`)
folds `run.config`, `updateStreamDescription`, `usage`, `updateTodos`,
`updatePlan`, `addOutputFiles`, `updateMissingOutputs`, `updateCompileFailures`,
`setParentStream` and `stream.removed`. `sessionFold` folds every one of those
into `StreamView` (`src/shared/session/sessionView.ts:88-172`). The two are the
only callers of the shared `mergeRounds` helper.

`StreamLogStore` builds `new StreamLog()` plus `createTranscriptFold` per
resident stream (`src/transcript/StreamLogStore.ts:49-50, 244-245`);
`sessionFold.emptyTranscript` builds `new StreamLog()` plus
`createTranscriptFold` per resident stream (`sessionFold.ts:431-434`) and
applies the identical dispatch. Same code, same rows, two copies in one process.

The surface is large: twenty production call sites on `session.snapshots.*`
across controllers, tools, `resumeRun`, `ToolUseFollowUp` and all three hosts,
and fifteen on `session.transcripts.*`.

**Proposal.** A tracking issue, not a PR. Project the runtime reads
(`getRunMetadata`, `getWorkPlan`, `getOutputFiles`, `getRunUsage`,
`getParentStreamId`, `getKnownFilePaths`, `hasProvenance`, `getExecutionIdMap`)
off `SessionView`, and make the trace assembler's `StreamSnapshot` an
export-shape projection of `StreamView` rather than a second fold.

**What must survive intact.** `StreamLogStore`'s non-fold responsibilities are
not duplication: the residency leases, the `runOwner` single-owner arbitration
(`StreamLogStore.ts:281-319`), the eviction gate and the `ephemeral` mode. Those
are process-ownership machinery.

**What we give up.** The fold keeps transcripts only for subscribed aggregates
(PRD §5.2 residency), so a runtime reader that today reads any stream would need
a subscription or a bounded read. Upper bound is roughly 500 lines across the
three files and their tests, two classes and one schema, realistically staged.

**Risk: high**, and cross-cutting.

Dedupe: #11283 and #9590 (both closed) attacked the old file-backed versions of
these stores, before the event table existed, so their conclusions predate the
substrate. Not #11867, whose SQLite cutover has landed, and not #11869.

## 3. The TUI never adopted `Surface`

**The narrow proposal below has landed** (`resolveSelected` split into
`resolveSelectedId` plus the `keepWhenViewEmpty` arm; `cliState.ts`'s
`selectedRunId` now calls it instead of reimplementing the rule). The rest of
this section — `Surface.expanded` vs. `expandedStreams`, `Surface.launch` vs.
`sessionMeta`, `Surface.phase` vs. `WORKFLOW_POPUP_VIEW`, and the full
`Surface` adoption in #11866 — is unchanged and still open.

PRD §10.1 says in writing that the TUI "Gains a `Surface`." It did not.
`rg -c "shared/session/surface" packages/cli/src` returns zero: the TUI imports
no part of the shared record, not `applySurfaceAction`, not `pruneSurface`, not
`loadSurface` or `persistSurface`, not `resolveSelected`, not `acceptsFollowUp`.

The result is a concept-by-concept twin. `Surface.selected` against
`activeStreamId` (`packages/cli/src/chat/tui/state/cliState.ts:90`);
`Surface.expanded` against `expandedStreams` (`cliState.ts:126`);
`Surface.launch` against `sessionMeta` (`cliState.ts:60`); `Surface.phase`
against `WORKFLOW_POPUP_VIEW` (`cliState.ts:329`). The selection rule itself is
written twice, at `src/shared/session/surface.ts:293-301` (seven extension and
desktop call sites) and `cliState.ts:101-108` (read in five CLI files).

**Proposal, deliberately narrow.** Do not port `cliState.ts` onto `Surface`
wholesale. That is a lane, and the cross-host convergence experience says a
typed-port convergence adds lines when the duplicated surface is smaller than
the seam. The provable deletion is the rule, not the record: give
`resolveSelected` the extra arm the CLI needs, where no streams at all keeps the
local pre-run id, and have `selectedStreamId` call it.

**What we give up.** The shared function gains one arm, and the TUI's
`undefined`-versus-`null` spelling of empty has to be reconciled at the one call
site. The divergence is load-bearing for the CLI's pre-run local conversation,
documented at `cliState.ts:92-99`, so the shared arm must be added rather than
the CLI arm dropped.

**Risk: medium.** About eight lines and one duplicated rule.

The full `Surface` adoption belongs to #11866 as the residual of PRD §10.1, not
as a fresh candidate.

## Deliberately rejected, with evidence

Recorded so nobody re-asks:

- **`webviewSessionLayer` is not a duplicate of `sessionLayer`.** They share
  three lines of shape and no content; folding them would drag `node:fs` and
  `@effect/sql-sqlite-node` into the renderer bundle.
- **The sweep and repair trio is not the startup restart-repair species
  (#11837, #11822).** All three are committed-row-driven, and
  `sweepLeftoverStreams` does not arbitrate: `Database.removeStream`'s
  `proveReclaimable` refuses anything but a proved-dead foreign owner in
  automatic mode. Liveness has one owner and the prober is documented as
  advisory.
- **`IToolUseSession` is a genuine single-implementor port**, but four dated
  audit checkpoints already ruled keep on this same evidence.
- **The `TerminalState` three-state enum** reads only as `!== 'open'`, but it is
  the guarded `claimTerminalFinalize` landmine that three prior scouts refuted.
- **The `src/shared/session/X` and `src/controllers/session/X` same-name pairs
  are contract and implementation, not pass-throughs.** Read both sides: 214
  against 1327 lines, 47 against 326, 20 against 182.
- **`ActiveChildInfo` correctly survived** the one-fold deletions.
  `child.activity` is never durable (`SessionEvents.ts:132` returns null for
  it), so it is a runtime roster row rather than a display slice.
- **The six run vocabularies are five distinct facts** with one owner each and
  no re-derivation helper. `RunIdentity` genuinely travels now.
- **The agent-CLI session registry is not speculative generality.** Two
  registries, both production-consumed (`src/tools/codex.ts:73`,
  `src/tools/claudeAgent.ts:82`), holding real claim, drain and
  interrupt-on-shutdown machinery.

Also verified clean: no `SessionEvent` variant lacks a producer or a consumer
(all thirty-two discriminant literals grepped, the lowest being
`execution.launchLabel` at two, live on both ends); no Zod `.catch` masking on
persisted event or stream data; no surviving pass-through, adapter or re-export
shim from lanes 1 through 4; and PRD §13's resume-latch collapse has landed, as
both hosts now call `resumeStreamWithRefusalNotice`.
