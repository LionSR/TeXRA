# Simplification survey: multi-agent dispatch (2026-08-28)

Status: implemented in the PR that carries this record, grounded on
`origin/main` at `f24078b012` (after #11498, #11511, #11514, #11513).
Archived: 2026-09-06

## Scope and method

Five read-only survey agents, one per domain — the workflow-script engine
(`src/agent/workflowScript/`), the delegation tools layer
(`src/tools/delegation/`), the projection and shared contracts
(`workflowScriptRun.ts`, the snapshot/card schemas, shared copy, `/executions`
view), the extension/desktop board and proposal surfaces, and the CLI
surfaces — followed by one adversarial verifier per domain that applied every
candidate in a throwaway worktree and ran typecheck + the relevant suites
before returning a verdict. Verdicts below cite the measured diff, not the
survey's estimate.

Rulings consulted and not re-litigated: `2026-08-14-delegation-flow-substrate-consolidation.md`
(ten debts, A1–A8), `2026-08-26-simplification-survey-round3.md` (§3 keep
rulings), `2026-08-28-workflow-plan-vs-issued-calls.md` (§Study: refuted
display ideas; §Rejected), the checkpoint + commit fence + child ledger
design, the QuickJS bridge shape, per-call replay.

## Defects found by the survey (fixed here)

- **Per-call review card accepted a model/agent pick it then discarded.** The
  proposal transport shipped dropdown options for every proposal; the panel
  hid them only for whole-workflow (`workflowScript`) proposals, while the
  admission path (`createWorkflowCallAdmission`) reads only
  `approve | not`. A pick on a per-call card was silently dropped. The
  transport now owns "accepts overrides" and ships no options otherwise; the
  panel renders dropdowns iff options arrived.
- **Setup on a per-call review card meant "skip, and overwrite the main
  view".** The admission contract is binary; Setup's semantics ("the user
  will run it manually") are false inside a live script. Hidden for
  `workflowCall` proposals.
- **A replayed call vanished on the second durable resume.** `hydrate` keeps
  a `CACHED` call `issued`; the projection's baseline recorded `cached`; the
  replay changed nothing, so attempt ≥ 3 emitted no card. `issueCall` now
  resets a reusable prior call to `planned` with a fresh execution window, so
  every attempt re-emits `planned → cached`. One regression test.
- **A construction-fold throw masked hydrated history as current work**
  (`constructionEmissionSeen` was set in `finally` even when the baseline
  loop never ran). The baseline is recorded before the fold's `try`.
- **The multi-agent proposal card's row budget was one row short** (the
  workflow branch of `agentProposalMetadataRows` omitted the outer margin
  row), overflowing by one row in feedback mode.
- **A persisted `status: 'starting'` snapshot fails resume loudly** once
  the status is removed. The compatibility preprocess that briefly mapped it
  (and stripped `stageTitle`/`blockedReason`/`queuedAt`) was deleted the same
  day — intermediate-era data is disposable, not age-gated; an interrupted
  run's `meta.json` from an older build is rejected loudly on resume.
- Three silent catches in the delegation layer made loud (§15 M2/M4).

## Landed simplifications (measured)

Engine: `raceWithAbort` → `p-timeout` (already a dependency); two dead
"no writes after settle" guards deleted (`acceptingEntries` + `onIdle` +
try/catch in persistence; `CoalescedSnapshotWriter.seal`) — the commit fence
and the sealed execution state already own that fact; the two in-flight maps
folded into one keyed by child execution id; `STARTING` removed (zero
observable duration; the follow-up `RUNNING` write was synchronous);
`parseCheckpointId` deleted (validated an in-process typed handoff);
`normalizeWorkflowScriptPhaseTitle` wrapper → the schema; `checkpointKey`
uses `JSON.stringify` (key order is the persisted identity, stated in a
comment); the `@agent/workflowScript` barrel shrinks by six test-only
re-exports (knip baseline −6).

Projection: `issuedCallIds` and the `'call-issued'` transition channel
deleted — `call.issued` on the snapshot is the one owner; `phaseStageIdFor`
pre-minting deleted (cards are emitted only under an open phase);
`settledWorkflowCall` replaced by a guarded re-fold of the terminal snapshot
plus a small tail; `queuedAt` (no reader) and `blockedReason` (derivable)
removed from the snapshot with the legacy keys stripped by the existing
preprocess; `WorkflowJournalCostError` → plain `Error` with `cause`.

Delegation: duplicate cost-observer guard deleted (the child-run loop
already guards it); `buildResult` removed from the strategy's return type;
`delivery` always constructed (two interfaces, no unreachable throw);
`userFollowUpSupport` derived once and carried as data; model selection
owned by one file; three single-owner micro-fixes.

Extension/desktop: transport owns override options; Setup hidden on per-call
cards; `ApproveSplitButton` menu values are the event names; controller
`handleAction` returns `void`; one header fold for phase headers and the run
band.

CLI: the transcript fold is the single owner of current-attempt membership
(three downstream re-derivations and two shared helpers deleted; the
intermediate-era untagged-row carve-out from 2026-08-13 dropped);
`workflowTaskMetadata` collapsed onto the shared metadata parts (dashboard
rows now show `attempt N` like the board); `formatCliWorkflowCallLine`
inlined; `openedPhases` and `focusedSessionLocationText` deleted; `s`/`r`
keys gated on the same fact as the status-bar hint; phase heading computed
once; one test-only case deleted (its fixture is unreachable from the
emitter).

## Refuted or deferred (with the reason)

- Make `script` required on `PersistedWorkflowScriptRunOptions`: six test
  sites exercise resume-from-stored-script; the persisted `script` would
  become write-only without a schema bump — not worth −4.
- `realmPreludes` → required string: breaks five sandbox call sites; the
  optional-string form is a net add.
- Emit `WorkflowExecutionCall` directly instead of `WorkflowCallProgress`:
  the card is the persisted `WORKFLOW_TASK` row schema and five host status
  switches read the collapsed vocabulary — churn-class.
- Collapse `deriveWorkflowCounts` and `workflowPhaseCallProgress`: different
  questions (succeeded vs. settled) over different inputs, documented.
- Fold the three proposal-literal builds into one helper: one caller each,
  predicted net-add.
- `resolveWorkflowCallConfig` called twice per admitted call: one owner
  invoked twice by design; caching needs a new engine handoff channel.
- Attempts-model fallback in `workflowCallFacts`: would show a previous
  attempt's resolved model on a re-queued call.
- `{text, style}[]` restructure of the CLI proposal modal: the JSX has
  per-span styling; the defect is one token.
- Shared three-surface tally, card-summed spend, `meta.phases[].detail`,
  static script analysis, second state store: ruled in the plan-vs-calls
  record.
- Per-call reject feedback is flattened to `'skip'` by the admission
  contract: recorded as a follow-up, not changed here.
