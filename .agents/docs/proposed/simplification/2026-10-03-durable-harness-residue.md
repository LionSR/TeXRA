# Durable harness lanes: what the sweep left for a decision

Date: 2026-10-03
Status: proposed
Origin: the simplification sweep over the durable-harness lanes: H2 (#13638),
H1 (#13642), the history rename M5 (#13653), H5 (#13656, #13657, #13658) and
H6 (#13660, #13663). The same PR made these behaviour-preserving edits
directly:

- `openOwnedChildren` now reads each child's records once. Its `exists()`
  probe went because a child with no `run.start` already has no edge. Its
  `readRunEnd()` read the whole aggregate and folded usage only to test
  for null; it became `runEndFromEvents` over those same rows.
- `FollowUps.consumeSettled` folded into `consume` as an `Effect.fn` pipeable.
- Four stale comments were corrected: the deleted `run-ledger-foundation`
  doc cited from `runHistoryEvent.ts` and `sessionEvent.ts`, the claim that
  "only `compaction` has a writer" of `context.edit`, `run.description`'s
  doubled JSDoc, and `deriveResumability`/`classifyRun`'s description of
  `unopened`.

The rename left no `ledger` identifier or comment other than the
architecture rulings ledger and Lean's tactic ledger. No reader of the
pre-H2 shapes remains: `model.compaction`, `keepPrefix`, an edit's
`continuation`, and the run id in an outcome question's text all have no
reader.

The findings below change behaviour, a persisted shape, or copy, so none was
made as a drive-by edit.

## 1. "Can this run resume?" is decided three ways

- The fold's `resumeEligible` (`src/shared/session/sessionFold.ts:360`)
  requires `category === ToolUse`, plus a plain-agent or `script` identity.
- `deriveResumability`'s `unopened` arm (`src/agent/storage/resumability.ts`)
  checks the identity clause only. A Workflow-category run that was
  registered and never opened is `unopened`, so `classifyRun` calls it
  resumable while the fold offers no Resume.
- `checkpointExists` feeds `checkpointPresent` in the run listing
  (`src/agent/storage/runListing.ts:157`, the CLI's `history.ts:202`), and
  `cliRunStanding` (`packages/cli/src/runtime/toolUseResumeData.ts:88`)
  derives `resumable` from it. `texra history` therefore shows an unopened
  run as not resumable, while `texra resume` accepts it.

**Proposal:** one identity-and-category predicate beside `isPlainAgentIdentity`
(`@shared/schemas`) that both the fold and `deriveResumability` call. The
listing then asks `deriveResumability` instead of `checkpointExists`, and
`checkpointExists` leaves `src/agent/storage/index.ts`.

**What we give up:** nothing. This is a fix, and the reason it is not
labelled a cleanup is that a Workflow run left unopened stops being
resumable through `classifyRun`. Decide whether round mode should resume
an unopened run. Round mode itself is pending removal in the documents
decision, so this may collapse on its own.

## 2. The `toolOutcome` decline is spelled three ways, and read two ways

- The TUI card sends `reject` (`rejectionMode="immediate"`,
  `packages/cli/src/chat/tui/modals/ToolOutcomeRequest.tsx`).
- The progress view sends `skip` (`ToolOutcomeRequestPanel.ts:26`).
- Headless rewrites `reject` to `skip` (`packages/cli/src/runtime/approvalAdapter.ts:264-277`).

The persisted `request.decided` therefore depends on the host. On the
reading side:

- The dispatch barrier (`toolUseDispatch.ts`, `decided`) reads `retry` as a
  re-run, `cancel` as "ask again", and anything else as skip.
- `agentChild.ts`'s `unknown` arm reads anything but `retry` as skip, a
  cleanup's `cancel` included. It then retires the earlier child.

**Proposal:** one `toolOutcomeAnswer(decision): 'rerun' | 'skip' | null` in
`@shared/session/approvalDecision`, read by both consumers. The TUI card
sends `skip`, and the headless rewrite goes.

**Decision needed:** whether a `cancel` written while `agent` recovers its
child should ask again, as the barrier does, or retire the child, as it does
today.

## 3. Row shapes to settle with the storage freeze

These are persisted-shape changes, so they are held for the freeze PR, as in
`2026-10-03-codemode-delegation-residue.md`.

- `run.start.parentCard` and `run.start.parent.callId` both name the
  call that launched the run. The same three launchers (`AgentTool.ts`,
  `subagentRun.ts`, `backgroundScript.ts`) always write them together,
  spreading the same `logId`/`toolCallId` pair by hand, and
  `inBandSubagentRun.ts` and `runLifecycle.ts` forward them as two options.
  A `card` on `parent` beside `callId` replaces the top-level field.
- A model switch is stored as `cause: 'compaction', trigger: 'model-switch'`
  with an empty range (`loop/modelSwitch.ts:72-82`). It summarizes nothing.
  Either it becomes a cause of its own, or the refinement "only a compaction
  names a trigger" is restated.
- `RunView.descriptionBy` (`sessionView.ts:128`) sits on the wire schema,
  but no host reads it. It is the fold's own working state for "a user title
  outlives later model titles". Moving it into the fold's private indexes
  takes it off the wire.

## 4. Smaller duplications, worth doing when the file is next touched

- **The blocker's wording, twice.** `runResumeBlockedMessage`
  (`src/shared/runs/runStatusDisplay.ts`) and `resumeBlockerLine`
  (`src/ui/copy/interruptedTasks.ts`) each switch over `agentMissing |
pluginOff | pluginUntrusted`, and they disagree ("is no longer installed"
  against "which is not installed"). One noun table in `src/ui/copy/` would
  serve both.
- **The interrupted roots, twice.** The open-time follower
  (`src/tools/interruptedTasks.ts:118-138`) filters on the database claim.
  The notice list (`src/ui/copy/interruptedTasks.ts`) filters on the fold's
  `interrupted` group. Under `auto`, what resumes and what `ask` lists can
  drift. They read different liveness sources, so unifying them needs the
  claim-versus-view question answered first. Two modules also share the
  name `interruptedTasks`.
- **`agentChildRunId`'s fallbacks** (`agentChild.ts:43-46`). `responseId ??
''` and `toolCallId ?? run.runId` name a child that `callChildren` can
  never match, so neither `owningCall` nor `openOwnedChildren` sees it. If
  every `agent` call now carries both ids, the fallbacks should become a
  loud defect. If some do not, H1's ownership guard does not cover them.
- **One error string, three times.** "The task stopped before its view was
  edited." appears in `RunInput.end` and twice in `FollowUps.ts`.

## Rejected

- **`RunHistory.appendBatch`'s registration checks** (`contractViolation`):
  the one caller is `forkRun`, but these are the service's stated
  preconditions, beside the opening-snapshot and foreign-aggregate rules. They
  are not a re-validation of one caller's values.
- **`compactIfNeeded`, `force: 'overflow'` and the
  `COMPACTION_TRIGGER`/`COMPACTION_REASON` pair:** their other caller is
  `src/agent/output/documentRoundPolicy.ts`, which is held for the documents
  decision.
- **`owningCall` and `openOwnedChildren` as one function:** they are
  different facts. A resume of an ended owned child still goes to its
  parent.
- **`resumeRun`'s second `resumeBlocker` check after the follower's:** the
  follower clears the block before a resume that may be refused for another
  reason, such as `owned_elsewhere`.

## Acceptance

- Item 1 lands with one predicate and the listing on `deriveResumability`,
  plus a decision recorded for unopened Workflow runs.
- Item 2 lands with the shared reader. Every host then writes `skip`, and
  `cancel` has one ruled meaning.
- Item 3 lands in the storage-freeze PR, with the golden store regenerated.
