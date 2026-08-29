# Simplification survey: the workflow-script display, TUI popup vs. extension board

**Date:** 2026-08-29
**Scope:** how the two interactive hosts display a `dispatch_multi_agent`
(workflow-script) run after #11588, #11590, #11591, and #11594 landed — the
CLI's phase-tab popup (`packages/cli/src/chat/tui/panes/WorkflowPopup.tsx`,
`state/workflowDashboardModel.ts`, `state/childControls.ts`) against the
extension progress view's group tree (`packages/extension/src/progressView/
frontend/components/TaskGroupList.ts`, `messageIndex.ts`,
`logFormatters/workflowCallFormatter.ts`) and the shared layer both read
(`src/shared/copy/workflowCall.ts`, `src/shared/schemas/workflowCallProgress.ts`,
`src/shared/transcript/projectTranscriptRow.ts`).
**Method:** two parallel evidence sweeps (one per host) at `origin/main`
`68e900aa`, then a manual re-verification of every load-bearing claim below
(row fields, budget parameters, category defaults, existing fallbacks,
consumer counts). Counts are `rg` over production (`src/`, `packages/*/src`,
`packages/cli/scripts`) versus `src/test-kernel/`.

Prior rulings this survey is judged against, and honours:

- `2026-08-28-workflow-plan-vs-issued-calls.md` §Display: the phase tally, the
  dot strip, and the run band are folds over rows the board already holds —
  **no new owner of counts**; a shared three-surface tally and a re-summed
  spend segment were refuted; a declared card exists only under an open phase;
  an extension attempt-boundary fold was rejected.
- `2026-08-28-simplification-survey-cli.md`: lifting the CLI's phase grouping
  into `@shared/copy/workflowCall` was measured against the board's
  `rebuildTree` (65 L nested + orphan re-rooting vs 18 L flat) and left
  host-local by #11545 — extraction net-adds.
- `2026-08-03-run-classification-consolidation.md` §538: `isFullLogChildStream`
  is the ruled-on identity-based predicate (its `rg -c → 0` acceptance is
  superseded by the shipped shape).
- `2026-08-15-shared-contracts-and-retirement.md` §868:
  `WORKFLOW_TASK_STATUS_LABEL` is the one status-label table; do not fork it.
- AGENTS.md "Duplicate UI controls": one home per user action; secondary
  surfaces show read-only status.

## Owner ruling (2026-08-29)

The maintainer ruled on this survey the same day: **the two hosts must share
one workflow-display state structure and differ only in how they paint it.**
That supersedes the #11545 measurement that left the phase grouping
host-local, and it settles the "divergences" below as defects, not product
choices: the board gets the per-call glyph strip, the declared phases and
tasks from the `workflow.plan` marker, and the attention-first grouping,
from the same model the popup reads. No projector or adapter layer on either
side — each host calls the shared model directly. The dead-code findings
(C1–C7) are cleaned up in the same pass. Implementation: one PR moves the model
into `src/shared/streams/` with the CLI on it and the cleanups; a second puts
the board on it.

## Candidates (issue-ready, ordered by leverage)

Estimated total across C1–C6: about −150 production LoC, −9 exports, −50 test
LoC, no new abstraction. Each is a bounded deletion or a fold into an existing
owner; none introduces a shared model.

### C1. Delete the session list's second home for skip/retry

**Evidence.** The popup owns `s` skip / `r` retry / `x` kill for a workflow's
calls (`WorkflowPopup.tsx:490-500`, gated by
`selectedChildRowWorkflowControllable`). The persistent session list still
carries the same two actions for a selected row when a workflow grandchild is
focused and its siblings list as session rows: `SubagentList.tsx:305` (key
gate, `WORKFLOW_CONTROL_KEYS`), fed by `App.tsx:376`
(`selectedChildWorkflowControllable` from `selectedChildParentId`), threaded
through `ConversationRegion.tsx` (snapshot + prop) and the status bar
(`statusBarDisplay.ts:164,742,752-770` `skipBinding`/`retryBinding`,
`StatusBar.tsx:336`). 18 production sites across 7 files; the only test is
`ChildListInteraction.vitest.ts` "skips and retries the focused subagent
grandchild by execution id"; the status-bar hint row itself has **zero**
tests (`StatusBar.vitest.ts:403,422` pin only `k kill`).

**Rule.** AGENTS.md "Duplicate UI controls" — the same action from two
controls drifts; the popup is the home, the list is a secondary surface.
Since #11594 the list reaches those rows only from _inside_ a task the user
opened from the popup, so nothing is lost: Esc returns to the popup.

**Proposal.** Delete the `s`/`r` arm of the `SubagentList` key gate and
`WORKFLOW_CONTROL_KEYS`, the `onWorkflowControl` and
`selectedChildWorkflowControllable` props on `SubagentList` and the region
snapshot, `selectedChildParentId`/`selectedChildWorkflowControllable` in
`App`, and the `selectionWorkflowControllable` input and both bindings in
`statusBarDisplay`/`StatusBar`. Keep `k kill` on the list and keep
`selectedChildRowWorkflowControllable` (the popup's predicate; move it next to
the popup or leave it in `appInteractionPolicy`). Delete the one test.

**Net.** ≈ −70 production LoC, −40 test LoC, −1 export
(`WorkflowControlAction` stays), −1 status-bar input field. Risk: low.

### C2. Retire the `stream:` encoding of `ChildListValue`

**Evidence.** After #11594 removed the `workflowPhase:`/`workflowTask:` kinds,
`ChildListValue` is `` `stream:${string}` `` — a one-variant tag
(`state/childListSelection.ts:4`). `childListStreamId` (`:10-16`) keeps a
`startsWith('stream:')` branch that can never be false; `childStreamListValue`
exists only to add the prefix. Production: 5 hits in 3 files (`App.tsx`,
`SubagentList.tsx`, `ConversationRegion.tsx`); tests: ~20 call sites of
`childStreamListValue` across `ChildListSelection.vitest.ts`,
`ChildListInteraction.vitest.ts`, `SubagentListDisplay.vitest.ts`.

**Proposal.** Carry `StreamTabId` directly through
`reduceChildListSelection`, `SubagentList`'s `Select` items, and the region
snapshot. Delete both helpers and the dead branch; the reducer's
`resolveChildSelectionValue` compares ids.

**Net.** ≈ −25 production LoC, −2 exports, ~20 mechanical test edits. Risk:
low (typecheck carries it).

### C3. Fold the popup's single-consumer helpers into the popup

**Evidence.** Three helpers live in the _session-list_ display module but no
session row uses them: `workflowPhaseTallyText` (`SubagentListDisplay.ts:133`,
1 consumer `WorkflowPopup.tsx:136`), `workflowPhaseStatusStrip` (`:153`, 1
consumer `:598`), `dashboardMarkerCell` (`:124`, 1 file / 3 call sites). All
three have zero tests of their own. `uniqueWorkflowChildStreamId`
(`workflowDashboardModel.ts:247`, 1 consumer `WorkflowPopup.tsx:343`) re-queries
the `childTaskIndex` the same module built at `:232-240` and needs `streams`
passed back in. The popup title re-spells the tally inline
(`WorkflowPopup.tsx:354-365`) that `workflowPhaseTallyText` already joins.
`dashboardMarkerCell` pads `' ' + marker` to three columns — the same cell
`transcriptEntryLayout.ts:142,361` spells as `firstPrefix + marker + ' '`; a
glyph-width change today is made twice.

**Proposal.** Move the three helpers into `WorkflowPopup.tsx` as file-local
functions (the strip and tally are popup-only presentation); have
`workflowDashboardModel` emit each task's focusable child stream
(`focusableChildStreamId`, resolved once from the index it already holds) and
delete the exported re-lookup; build the title from `workflowPhaseTallyText`
plus elapsed and cost; give the marker cell one owner (export the width from
`transcriptEntryLayout` or derive `firstPrefix` from it). Also fold the row
budget onto `scrollableModalTextRowsBudget({ extraFixedRows })`
(`ScrollableModalText.tsx:34-40`) instead of the hand arithmetic at
`WorkflowPopup.tsx:406-418`, and delete three defaults that mask nothing:
`tabs[index] ?? ''` (`:122`, index is bounded), the double
`workflowPhaseStatusStrip(...) ?? ''` (`:601`, the caller already guards
`group`), and `ATTENTION_RANK[status] ?? 0` (`workflowDashboardModel.ts:380`,
membership is guaranteed by `popupGroupOf`; type the attention statuses so
the record is total). Fix the stale "dashboard replaces the session list"
comments (`appInteractionPolicy.ts:204-206` and the `WORKFLOW_DASHBOARD_KINDS`
doc in `transcriptFold.ts:56-66`) while there; do not rename files.

**Net.** ≈ −30 production LoC, −4 exports. Risk: low; the two popup render
tests cover the visible output.

### C4. Read `statusLabel` and `metadataParts` off the row the popup already has

**Evidence.** The popup's `entry` is `TranscriptRowOf<'workflowTask'>`
(`workflowDashboardModel.ts:23`), which `projectTranscriptRow.ts:560-561`
already stamps with `statusLabel` and `metadataParts` from the shared tables.
The popup re-derives both per render: `WORKFLOW_TASK_STATUS_LABEL[entry.call.status]`
at `WorkflowPopup.tsx:203,232` and `workflowDashboardModel.ts:342` (filter),
and `formatWorkflowCallMetadataParts(entry.call)` at `:158` inside
`workflowTaskMetadata` — two representations of one fact, one of them
recomputed on every repaint of a 75-row phase.

**Proposal.** Use `entry.statusLabel` and `[...entry.metadataParts, ...live]`;
the label table stays only for `DeclaredTaskRow` (a `WorkflowCallIdentity`,
which has no row). Note `2026-08-28-simplification-survey-multi-agent-dispatch.md`
§91 already collapsed `workflowTaskMetadata` _onto_ the shared parts; this is
the remaining half.

**Net.** ≈ −10 production LoC; one fewer per-render fold. Risk: none.

### C5. Resolve a stream's identity through the fallback that already exists

**Evidence.** `presentStream`/`isWorkflowScriptStream`
(`state/childControls.ts:96-131`) added `rosterRowFor`, a scan of **every**
parent's roster, to read a child's identity before its `run.start` lands.
`streamViews.ts:110-124` (`streamTabInfoFor`) already implements exactly
`metadata.identity ?? parent-roster-row identity` via the `parentStream` map
and `visibleSubagentRows`.

**Proposal.** Have `isWorkflowScriptStream` read `streamTabInfoFor(...)?.identity`
and keep only the reverse scan `presentStream` needs for the parent _edge_
when `parentStream` has none yet. **Verify first:** `streamTabInfoFor` returns
`undefined` when `streamMetadataFor` is undefined (`:117`); confirm that in
the roster-first interval the summary metadata record exists without
`identity` (as `streamViews.ts:107-109` documents) rather than being absent —
if it can be absent, the fold loses the fallback and this candidate is
withdrawn.

**Net.** ≈ −10 production LoC. Risk: low once verified.

### C6. Relocate `workflowScriptDeclaredItemsByPhase` to its only consumer

**Evidence.** `src/shared/copy/workflowScriptProposal.ts` exports
`workflowScriptDeclaredItemsByPhase` for the approval proposal; production
consumers: **1**, the extension's `ProposalRequestPanel.ts:246,273-291`. The
CLI's `AgentProposal.tsx:114-155` prints only `workflowScriptPlanSummary` and
the note. "Shared copy" with one host is nominal sharing.

**Proposal.** Either the CLI modal adopts it (declared items grouped per phase
in the approval card — a small parity gain the plan-vs-calls record does not
rule on) or it moves into the extension panel. The relocation is the
simplification; the adoption is a product call listed under §Divergences.

**Net.** −1 shared export; ±0 LoC. Risk: none.

### C7. Trim tests that pin copy rather than behaviour

**Evidence.** `WorkflowDashboardModel.vitest.ts:307-362` asserts four
per-render strings (`'◆ Explore · 0/0'`, `'Workflow · 0/0'`, `'No calls in
this phase yet'`, `'Esc close'`); `:365-423` mixes the real windowing
invariant (`/… \d+ more/`, failed before running) with tally copy
(`'12 running'`, `'1 failed'`); `AppEscapeRouting.vitest.ts:343` pins the
popup title's exact separators inside an Escape-routing test.

**Proposal.** Keep the structural assertions (model shape, ordering, overflow
marker, `foregroundReader.kind === 'workflow'`); drop the copy pins. Per
"Testing discipline", a copy change should not be merge friction.

**Net.** ≈ −10 test LoC; fewer churn-coupled tests.

## Rejected, with the evidence

- **A shared `groupWorkflowCallsByPhase` for both hosts.** Refuted by the
  #11545 measurement (see rulings above) and the gap has widened since: the
  CLI model now also unions the declared plan, scopes rows (not just tallies)
  to the newest attempt, and suppresses stale-attempt phases — three
  behaviours the plan-vs-calls record explicitly declined for the board.
  Extraction would carry CLI-only branches into shared code. Net-add.
- **A shared status → presentation token table.** Today: the CLI's
  `WORKFLOW_TASK_STATUS_STYLE` (`transcriptEntryLayout.ts:163-177`, exhaustive
  via `satisfies`), the extension's `statusIcon` switch
  (`workflowCallFormatter.ts:14-38`, `assertNever`), and two CSS maps
  (`groupStyles.ts:86-116`, `logEntryStyles.ts:77-175`, no guard). A token
  table would be a fourth owner and the CSS would still enumerate classes.
  The only real gap — the CSS maps have no exhaustiveness check — is closed
  by a `satisfies Record<WorkflowCallProgress['status'], string>` on a
  TS-side class map in the extension; a one-line follow-up, not a shared
  model.
- **A shared tally string.** Refused as a second owner of counts in the
  plan-vs-calls record. C3 reuses the _existing_ CLI helper in two CLI
  places; it does not create a cross-host owner.
- **Deleting or renaming `WorkflowRunDetails`.** Still reachable:
  `AgentCategory.Workflow` is the prefault category for every reflection-flow
  agent (`AgentDataclass.ts:40-41`), those subagents are focusable, and the
  component renders round/output lifecycle (it skips `kind === 'phase'` at
  `:136`). The name is misleading post-popup, but a rename is churn-class
  (R5); a doc comment suffices (folded into C3).
- **`compactWorkflowEntries` / `WORKFLOW_DASHBOARD_KINDS`.** With the
  workflow never the active stream, this is the _only_ producer of the rows
  the popup renders (`subscribeStreamLog.ts:236-238,394-399`). Keep; rename
  the vocabulary in comments only (C3).
- **`isFullLogChildStream`.** Settled by the 2026-08-03 ruling.
- **Folding `workflowTaskMetadata` and `childRowMetadataText`.** Same
  three-part join, different fact sets (call card with live cost vs. stream
  with tool-call count); a union parameter nets positive.
- **`presentStream`'s return value.** Three callers, one reads it — but that
  one branch is the reason the function exists. Keep.

## Divergences between the hosts (product decisions, not cleanups)

Recorded so the next design pass sees them; none is a simplification:

1. Ordering: the board lists calls in transcript order; the popup leads with
   awaiting-approval → failed → running and folds the rest into counted
   groups.
2. Unopened phases: the popup shows declared phases as tabs and declared
   tasks as rows (from the `workflow.plan` marker, #11590); the board ignores
   the marker (`logSlice.ts:136-142` drops `INTERNAL`) and shows nothing until
   a phase opens.
3. Resume: both scope tallies to the newest attempt; the board still lists
   superseded-attempt cards and the duplicate phase group, the popup drops
   both.
4. Settled run: the popup hides never-reached plan-only phases
   (`runSettled`); the board has no equivalent state.
5. Controls: the popup has skip/retry/kill and `f` next-failed; the board's
   call row is a navigation link only, taken verbatim from `childStreamId`
   with no uniqueness check (the CLI's `childTaskIndex` refuses ambiguous
   rows).
6. Approval card: the board lists declared items per phase; the CLI modal
   prints the summary only (C6).

## Explicitly excluded

The architectural ratchets, the frozen `@agent/*` surface, the PocketFlow
engine, and the four hosts themselves. Headless output
(`packages/cli/src/runtime/workflowPlainOutput.ts`) is untouched by every
candidate above.

## Checks

Docs-only survey: `npm run format`, `npm run check:guidance-refs`,
`git diff --check`.
