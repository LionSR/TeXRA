# Durable harness lanes: what the sweep left for a decision

Date: 2026-10-03
Status: proposed
Origin: the simplification sweep over the durable-harness lanes (H1, H2, H5,
H6 and the history rename M5). Its behaviour-preserving edits merged in
#13669. Of the findings it left, the resume predicate (#13671), the
`toolOutcome` question (removed by #13827), the model-switch row (now a
`run.config`), the blocker wording and `agentChildRunId`'s fallbacks have
since been settled. What follows is still open; each item changes a
persisted shape, copy, or which liveness source a surface reads.

## 1. Row shapes to settle with a storage-format bump

- `run.start.parentCard` and `run.start.parent.callId` both name the call
  that launched the run (`RunStartEventSchema`,
  `packages/harness/src/shared/schemas/sessionEvent.ts`). The three
  launchers (`AgentTool.ts`, `subagentRun.ts`, `backgroundScript.ts`) always
  write them together, and `RegisterRunOptions`
  (`packages/harness/src/agent/storage/runLifecycle.ts`) carries them as two
  options. A `card` on `parent` beside `callId` would replace the top-level
  field.
- `RunView.descriptionBy` (`packages/harness/src/shared/session/sessionView.ts`)
  sits on the wire schema, but no host reads it. It is the fold's own working
  state for "a user title outlives later model titles". Moving it into the
  fold's private indexes takes it off the wire.

## 2. Smaller duplications, worth doing when the file is next touched

- **The interrupted roots, twice.** The open-time follower
  (`packages/harness/src/tools/interruptedTasks.ts`) filters roots on the
  database claim. The notice list (`packages/texra/src/ui/copy/interruptedTasks.ts`)
  filters on the fold's `interrupted` group. Under `auto`, what resumes and
  what `ask` lists can drift. They read different liveness sources, so
  unifying them needs the claim-versus-view question answered first. The two
  modules also share the name `interruptedTasks`.
- **One error string, three times.** "The task stopped before its view was
  edited." appears in `RunInput.end` and twice in `FollowUps.ts`.

## Rejected

- **`owningCall` and `openOwnedChildren` as one function:** they are
  different facts. A resume of an ended owned child still goes to its
  parent.
- **`resumeRun`'s second `resumeBlocker` check after the follower's:** the
  follower clears the block before a resume that may be refused for another
  reason, such as `owned_elsewhere`.

## Acceptance

- Item 1 lands with a storage-format bump, with the golden store
  regenerated.
- Item 2's interrupted-roots change lands with a recorded answer to which
  liveness source the notice and the follower share.
