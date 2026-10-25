---
created: 2026-10-23
status: proposed
---

# Run input: one owner per fact, delivery at the next request

Baseline: `main` at `a20cc39310`. Line references point into that tree.
Revised the same day after an adversarial review by a fresh agent; the
"Review" section lists what it changed.

## Summary

A message typed while a run is working waits until the run's turn ends. Up to
v0.40.10 the engine delivered it at the next model request inside the turn;
#12314 (2026-09-12), which replaced the engine with the Effect loop, kept only
the end-of-turn read, and nothing recorded the loss. Restoring delivery at the
next request is a two-line change to the loop once the input chain has one
owner per fact. Today it has not: five places decide which pending rows are
messages, three predicates say whether a run is live here, three mechanisms
decide whether a run owes a resume, and two in-memory facts (a stop's commit
ordinal, a subagent notice's staleness) restate what the rows already hold.

This note redesigns the chain around the rows. Every fact below gets one
owner, the in-memory copies become row reads, and the following are deleted:
`wakeAfterGeneration` with its `since` ordinal, `wakeParent`'s re-derivation
and the id-prefix match behind it, `getToolUseFollowUpTarget` and its
`retainsTerminalParent` flag, `joinStopped`, `endedChildProgress`'s view
lookup inside the loop, the send `mode`/`wake` option plumbing, and the
direct inbox read in the dispatcher. The one new stored value is two more
members of the `holdUntil` enum: `'turn'` for a message the user wants held
until the turn ends, and `'generation'` for a notice that is read only by a
generation already running and never resumes one.

## What exists and why

The durable layer is correct and stays:

- A run's pending input is its `followup.queued` rows minus its
  `followup.consumed` rows, rebuilt by `applyRunRow`
  (`packages/harness/src/shared/session/runRows.ts`). One reader of rows for
  the loop, the view and the inbox.
- A send is one transaction under the run's claim (`Inbox.send`,
  `packages/harness/src/agent/followUp/Inbox.ts:124`). The claim
  (`SessionLog.hold`) is the cross-process fence; a write to a run this
  process does not hold fails `DatabaseNotOwner`.
- A delivered batch commits its `followup.consumed` rows in the same append as
  the user message it becomes (`FollowUps.batchRows`,
  `packages/harness/src/agent/runtime/FollowUps.ts:187`), so a crash leaves a
  message either queued or consumed, never both and never neither.
- One reader per run per process (`Inbox.open` dies on a second); one resume
  in flight per run (`Inbox.resumeOnce`).

Above that layer, the facts have several owners.

### Which pending rows are messages, and readable now

| Site                                             | Rule                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `RunInput.pending` (`RunInput.ts:60`)            | `control === undefined`, `holdUntil`, an instruction present                                                         |
| `Inbox.queued` (`Inbox.ts:399`)                  | `control === undefined`                                                                                              |
| `wakeAfterGeneration` (`ToolUseFollowUp.ts:235`) | `control === undefined`                                                                                              |
| `projectFollowUps` (`sessionViewUpdate.ts:911`)  | `control === undefined`                                                                                              |
| `endedChildProgress` (`FollowUps.ts:164`)        | a subagent notice whose child has ended, checked only at delivery, by parsing the child id out of the notice text    |
| `acceptsFollowUp` (`sessionView.ts:267`)         | the composer's rule, on the view, with a `FollowUpHost` constant each host passes (the extension passes both values) |

Consequence: the queued panel counts a subagent notice the loop will discard,
and `Inbox.release` withholds its "takes no more input" notice while one sits.

### Whether a generation of the run is live here

- `RunRegistry.isLive` (a fiber, a hold, or a launch in progress;
  `runRegistry.ts:272`) → `LiveRun.live`, read by `Inbox.port.live`,
  `resumeRun` and `startFollowUpWake`.
- `entries.get(runId)?.handle?.controls` → `getToolUseFollowUpTarget` answers
  `'active'` (`runRegistry.ts:339`).
- `Inbox.readers.has(runId)` → `Sent.read`, which picks the word the user
  sees ("sent" or "queued").

### Whether the run can take a message

- The `followup.closed` row (inbox).
- `userFollowUpSupport` on `run.start`, set at eight launch sites, read by
  `tools/executions/send.ts:70`.
- `controls.oneShot`, read by `tools/executions/send.ts:81`, with the comment
  that a message queued there "would sit unread under a 'sent'
  acknowledgement": the admission would accept and the tool patches it.
- `getToolUseFollowUpTarget` plus `runRejection` inside `submitFollowUp`,
  which also holds the rule "only the user's own message continues a run no
  generation holds" (`ToolUseFollowUp.ts:333-338`).

### Who writes `followup.consumed`

Five sites with four literal shapes: `Inbox.closeInput`,
`FollowUps.batchRows`, `childTurnResult` (`childTurnResult.ts:154`, on the
child's own aggregate), `rows.consumedRows` (the loop's `/compact`, the model
switch, the run end in `runLifecycle.ts:255`), and `toolUseDispatch.ts:716`,
which writes rows the `executions` tool asked for through `consumedFollowUps`
on its result (`ExecutionsTool.ts:202`, stripped at `toolUseDispatch.ts:161`).

### Whether someone owes the run a resume

Three deciders with three inputs, reconciled only by `resumeOnce`:

- `Inbox.landed` (`Inbox.ts:316`): no reader, not live, no resume in flight,
  decided at the send's commit, and only when the sender asked
  (`options.wake`).
- `wakeAfterGeneration` (`ToolUseFollowUp.ts:222`): a `followup.queued` row
  with `commit > since`, where `since` is an in-memory `CommitOrdinal` the
  registry stamps at each generation's start (`runRegistry.ts:470`), at a
  stop's request (`:649`) and at `markStopped` (`:776`), threaded through
  `init.wake`.
- `wakeParent` (`childTurnResult.ts:369`): re-reads the parent's input after
  the child's commit for the delivery id, or any id with the `lostResultId`
  prefix (`startsWith`, so the id's string layout is a protocol). Six call
  sites: `toolUse.ts:535`, `childRunLoop.ts:122, 576, 623, 840`,
  `childTurnResult.ts:347`.

The second exists because the loop releases its reader before its fiber ends:
a message landing in that window sees no reader but a live run, so `landed`
defers to whoever runs when the generation leaves. The `since` ordinal also
carries a product rule: a message queued before the user's Stop does not
restart the run; one sent after it does.

### Routing, decided twice

`chatSessionController.ts` keeps `interruptedRunId`, `childFollowUpTarget`,
`claimPreparingRoot`, a race against `awaitRunFolded`, and a 110-line
`FollowUpDeliveryQueue`. The harness routes again in `submitFollowUp` from a
registry snapshot, and the stopped-run case a third time in `joinStopped` and
in `wakeAfterGeneration`'s `since` rule.

### Smaller

- `RunInput.take`, `takeQueued` and `hasQueued` all only read; nothing is
  taken. The class comment claims "the reader takes again only after that
  commit", which the loop's sequencing provides, not the class.
- The `/compact` wake text (`COMPACTION_REQUEST`) is a model-facing prompt
  held by the reader module.
- `FollowUpBatch.synthetic` has two producers (the compact wake, a Stop hook's
  block); the `RunInput` comment names a third that #14201 removed.
- `childRunLoop.ts:698` races `input.take` against an `AbortSignal` callback.
  For a process child this is needed: `interrupt()` aborts the controller
  and does not interrupt the fiber (`:312`).
- `toolUseDispatch.ts:1106` reads the session inbox directly for a pending
  model switch instead of the run's `controls`.
- `RunInboxSendOptions.mode: 'live_notification'` (one sender,
  `RunSubscriptionRegistry.ts:135`) means "lands in the inbox, never wakes a
  run"; `SendOptions.hold: 'instruction'` means almost the same for the pause
  and stop notices; a progress notice gets the same by being sent with no
  `wake`. Three spellings of one row fact.
- `FollowUps.release` decides `terminal` from `session.runs.get(runId)?.parent`
  (`FollowUps.ts:336`): a registry read deciding an inbox fact.
- Two id schemes: `randomUUID()` for sends, `${runId}:${prompt}:delivery` for
  child results.

## Design

The rule: a fact the rows state is read from the rows; a fact only this
process knows (a reader is open, a resume is in flight) has one in-memory
owner, the inbox.

### `holdUntil` says when a row may be read, and whether it wakes

The row already has `holdUntil: 'instruction'`. Two more members:

| Value           | Read                                                                                                   | Wakes a run with no live generation |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| (absent)        | at the next request, the turn's end, or idle                                                           | yes, by sender (below)              |
| `'instruction'` | only beside an instruction (pause and stop notices)                                                    | no                                  |
| `'turn'`        | at the turn's end or idle, not before a request inside the turn                                        | yes, by sender                      |
| `'generation'`  | at the turn's end or idle, only by a generation already running (progress notices, host notifications) | never                               |

`'generation'` replaces `mode: 'live_notification'`, the no-`wake` path a
progress notice takes today, and the `'quiet'` arm of `admitQueued`.
`rowVersions.ts` bumps `followup.queued`: an older build would reject the new
members.

### Two pure functions beside the row reader

In `packages/harness/src/shared/session/runFacts.ts`, the module that reads a
run's facts off its rows (the view cannot import `@agent/*`, so
`shared/session` is the one place every reader can reach; `runRows.ts` would
cross the 400-line core limit, and a new file would widen the `entry-files`
ratchet). `isInstruction` moves here from `followUpMessages.ts`.

```ts
export type InputPoint = 'request' | 'turn' | 'idle';

/** The pending messages a run reads at `at`, in commit order. */
export function readableMessages(
  rows: readonly QueuedFollowUp[],
  at: InputPoint,
  /** Whether the run a notice came from has ended: its notice is stale. */
  childEnded: (runId: RunId) => boolean,
): QueuedFollowUp[];
// control rows: never (they are the run's own requests, read as `controls`)
// holdUntil 'instruction': only beside an instruction in the same read
// holdUntil 'turn' | 'generation': not at 'request'
// holdUntil 'generation' from a child run that ended: stale, consumed unread

/** Whether pending input obliges a resume of a run no generation holds. */
export function needsWake(input: InputRows): boolean;
// over readableMessages(rows, 'idle'), excluding holdUntil 'generation'
// (a progress notice, a host notification: never a wake):
// - the run's current lifecycle has not ended (it waits on a child, or its
//   generation left without an end): any run's message wakes it, as the
//   user's does (today's rule for a message to a parked or waiting run)
// - the run ended other than by a user's Stop: a user's message or a child's
//   delivery wakes it; another run's message does not revive it
// - the run ended by a user's Stop (its last run.end is cancelled): only a
//   user's message committed after that run.end wakes it
```

The child id of a stale notice is `content.from.runId` on the row; nothing
parses the text. `childEnded` is the view's `isTerminalOutcomePhase` lookup,
passed by the loop (`FollowUps`), the inbox (through its port, beside
`parentOf`) and the view projection (its own runs). `endedChildProgress`
goes; the view, `Inbox`'s "a message is queued" and the loop agree.

`RunInput.pending(at)`, `Inbox`'s "is a message queued" test, the view's
`projectFollowUps` and the wake all call these. Adding a `holdUntil` member
touches `readableMessages` and the schema enum, nothing else.

### One wake, `Inbox.wake(runId): Effect<boolean>`

Waits for the publisher (`session.log.settled`, the barrier
`wakeAfterGeneration` has today), reads the run's input rows, and if the input
is open, `needsWake` holds, no reader is open here and nothing is live here,
starts the one resume (`resumeOnce` dedups). Returns true when nothing was
owed or the resume took the run; false when a resume was owed and refused.
Called at four moments:

1. by the sender, after its send committed with `read: false`
   (`submitFollowUp`, and the child delivery's `wakeParent`, whose body
   becomes this call; its six call sites and the `ChildRunBoundary` field
   stay);
2. a reader's release;
3. the registry's generation-leave (`runRegistry.ts:480`);
4. the registry's hold-release (`runRegistry.ts:555`).

Moments 3 and 4 already call `init.wake(runId, since)`; the hook stays and the
ordinal goes. Moment 1 is the sender's: `Inbox.send` stays the pure door (one
transaction; `Sent` is `queued { read } | duplicate | refused`), and a sender
whose row no reader took asks `wake` — `submitFollowUp` for every host and
tool, relaying the answer as the wire's `wake: 'failed'`; `wakeParent` for a
child's delivery, which commits inside the child's transaction
(`admission`). Keeping the door pure matters: a resume's own host step sends
input to the run it is resuming, and a door that woke would wait on itself;
`wake` also answers true while a resume is in flight, since that resume reads
the input when it lands. Deleted: `wakeAfterGeneration`, `wakeParent`'s row
re-read and the `lostResultId` prefix match, `entry.since` and its three
stamps, `SendOptions.wake`, `Sent.wake`, `admitQueued` with its
`'live' | 'wake' | 'quiet'` modes.

### The Stop fence is the cancelled `run.end`, and a send waits for it

A message committed after the run's last cancelled `run.end` continues the
run; one committed before it does not restart it by itself. For that to hold
for "Stop, then retype" — a window the review sized as the whole unwind (the
interrupted tool's fiber, a child's stop cascade, `finalizeRun`), not
milliseconds — `submitFollowUp` does what the CLI does today in
`chatSessionController.ts:1004-1016`: a user's message to a run whose stop is
in progress (`runs.get(runId)?.stopReason !== undefined`, set before the
interrupt and cleared with the entry) waits for the run to drain
(`LiveRun.drained`) before its row commits. The row then lands after the
`run.end`, `needsWake` is true, and the sender's wake resumes the run. The
CLI's wait becomes redundant (second PR). Behaviour change, stated: a child's
result delivered after its parent's user Stop no longer revives the parent
(today the retained activation made it `'queue'`d and woken); the user's next
message carries it.

### One admission, `submitFollowUp`

Every sender (CLI, extension, desktop, `executions send`, `agent_cli`
follow-ups, GitHub notifications) goes through it, and it alone refuses: a
closed input, a run held elsewhere, a non-parent sender, a one-shot run (live
`controls.oneShot`, else `run.start.userFollowUpSupport === 'unsupported'`
for a run's message; a user's message may resume such a run as a conversation,
as today), the resume rejections (finished, unusable, blocked), and a run's
message or a notification to a run that ended with no generation here (the
rule `ToolUseFollowUp.ts:333-338` holds today). The one-shot and support
checks move here from `tools/executions/send.ts:70-88`. With `progressNotify`
(`childRunLoop.ts:422`) sending `holdUntil: 'generation'` and letting the
admission refuse, `getToolUseFollowUpTarget`, `ToolUseFollowUpTarget` and
`retainsTerminalParent` have no callers: a completed parent's input stays
open (`release('recoverable')`, `runProgram.ts:140`) and its child's delivery
is admitted and wakes it by `needsWake`, as traced in the review.

### One consume

`FollowUps.consume(cell, batch, { rows?, alongside?, position? })` is the
one way a batch leaves the queue: `rows` are the boundary it commits with (a
turn's end, a child's delivery), `position: false` joins the batch to the
turn running instead of opening one with `turn.ready`. `joinStopped` is
deleted: the message a user typed with a Stop is delivered by the request
that follows the stopped response's results, the same path as every message
typed mid-turn, so the dispatcher no longer carries follow-up rows. One
`consumedRow(runId, followUpId)` constructor in `runFacts.ts` replaces the
four literal shapes (the child's own consumed prompts included; same shape,
its own aggregate). Behaviour change, stated: `joinStopped` joined only
instruction rows and committed them with the results; the request delivery
takes every readable row (a child's result too), in its own batch after the
results. A crash between the two leaves the message queued, not lost.

### The reader reads

`RunInput`: `next(at)` blocks, `read(at)` reads, `hasPending(at)` probes,
`controls` reads the run's own requests. The compaction request text lives
in `run/compaction.ts` beside the compaction that answers it. The dispatcher
takes the loop's `controls` for its model-switch check instead of reading
the session inbox directly. A process child's wait keeps its `AbortSignal`
race: the abort is what ends it.

### Delivery at the next request

In `runTurn`, before each new request (`state.invocation === null`), after
`compaction.atBoundary`, and only when the history ends in a tool group:

```ts
if (state.messages.at(-1)?.role === 'tool') {
  const queued = yield * followUps.read('request');
  if (queued !== null)
    state = (yield * followUps.consume(cell, queued, { position: false }))
      .state;
}
```

The user message lands after the tool results; the append is uninterruptible;
resume reads the same rows (the fold's `append` handler is the one the loop's
own nudges already use mid-turn). A request whose history already ends in a
user message (the turn's first request, a nudge) takes nothing: providers
refuse two user turns in a row, and the message is read at the next tool
boundary or the turn's end as before. A request whose attempt is open is not
changed: a retry resends the history it had. What is delivered at a request: the user's
messages without `'turn'`, a parent's instruction, a child's result. What
waits for the turn's end: `'turn'` and `'generation'` rows. Two loop-level
reads that change with it: `afterTextResponse`'s blank-nudge test
(`messages.at(-2)?.role === 'tool'`) looks past a delivered user message; `resumeQueuedToolUse` reports `delivered` on
`onIdle`, which a mid-turn consume does not fire — acceptable, since a
resumed run takes its first message at idle, not mid-turn.

### Codecs

Verified in `packages/llm/src/api`: `PreparedHistorySchema`
(`message.ts:316-351`) allows `assistant(local-call) → tool → user →
assistant`. Google merges a user message into the previous `user_input` step
(`googleInteractions.ts:213`); OpenAI Responses and OpenRouter take a user
message after `function_call_output` / `tool` items with no adjacency rule;
Anthropic emits `user(tool_result[])` then `user(text)`, which the API
combines into one turn with the tool results first. No codec change.

## Ownership after the change

| Fact                                     | Owner                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Pending input                            | `applyRunRow`                                                             |
| When a row may be read; whether it wakes | `holdUntil` on the row; `readableMessages`, `needsWake` in `runRows.ts`   |
| A notice is stale                        | `readableMessages`, from the row's `from.runId` and the view's run status |
| Reader presence; resume dedup; the wake  | `Inbox`                                                                   |
| Can this run take a message              | `submitFollowUp`                                                          |
| Batch → message → rows                   | `FollowUps.consume`                                                       |
| Next-request vs end-of-turn              | the loop, by `at`                                                         |
| Stop fence                               | the cancelled `run.end`; the admission waits for it                       |

## Races and what closes each

| Race                                                             | Closed by                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A message lands while the loop unwinds (reader gone, fiber live) | `Inbox.wake` at generation-leave, after `log.settled`; the resume waits on the run's lane |
| A message lands during a registry hold (no reader)               | `Inbox.wake` at hold-release                                                              |
| Two senders both resume                                          | `resumeOnce`                                                                              |
| Delivered twice after a crash                                    | `followup.consumed` commits with the message                                              |
| "Stop, then retype"                                              | the admission waits for the drain; the row lands after the cancelled `run.end`            |
| A notice resumes an idle or finished run                         | `holdUntil: 'generation'` never wakes                                                     |
| A lingering pause notice resumes the run at every leave          | `needsWake` is over readable rows, which exclude a held row with no instruction           |
| A next-request message summarized by compaction                  | consumed after `atBoundary`, before the request                                           |
| A stale notice counted or keeping the input open                 | `readableMessages` drops it everywhere                                                    |
| A one-shot run acknowledges a message it never reads             | the admission refuses it                                                                  |

## Deleted

| Element                                                                           | Where                                                                                         | Lines  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| `wakeAfterGeneration` and `since`                                                 | `ToolUseFollowUp.ts:205-255`, `runRegistry.ts:470, 480, 555, 649, 776`, `sessionLayer.ts:206` | ~70    |
| `wakeParent`'s row re-read, `lostResultId` prefix match                           | `childTurnResult.ts:362-390` (body becomes `Inbox.wake`)                                      | ~20    |
| `getToolUseFollowUpTarget`, `ToolUseFollowUpTarget`, `retainsTerminalParent`      | `runRegistry.ts:85-110, 326-350`, `childRunLoop.ts:422, 935`, comment `sessionEvent.ts:329`   | ~45    |
| `admitQueued` modes, `mode: 'live_notification'`, `SendOptions.wake`, `Sent.wake` | `ToolUseFollowUp.ts:60-69, 262-345`, `Inbox.ts`, `RunSubscriptionRegistry.ts:135`             | ~40    |
| `joinStopped`                                                                     | `FollowUps.ts:95-101, 316-330`                                                                | ~25    |
| `endedChildProgress`, `subagentProgressRunId` use in the loop                     | `FollowUps.ts:160-175`                                                                        | ~15    |
| Four `followup.consumed` literals                                                 | five sites                                                                                    | ~20    |
| `isInstruction` duplicate home                                                    | `followUpMessages.ts:52` (moves)                                                              | 0      |
| `followUpSender.ts` (two exports, 19 lines)                                       | folded into `followUpMessages.ts`; `plugins.ts`, `send.ts`, `Inbox.ts` repointed              | 1 file |
| Direct inbox read                                                                 | `toolUseDispatch.ts:1106`                                                                     | ~5     |
| Native child `AbortSignal` race                                                   | `childRunLoop.ts:698-705`                                                                     | ~5     |
| Two rebuilt wordings of the send result                                           | `executions/send.ts:114-120`, `TasksForm.tsx:381` (use `presentFollowUpResult`)               | ~10    |

About 255 lines out; added: `readableMessages`, `needsWake`, `consumedRow`,
`Inbox.wake`, the drain wait in the admission, the consume at the next
request, two enum members and the version bump: about 90 lines.

## Surface

Checked beside the design: every export of the chain and its caller count.

- `acceptsFollowUp(run, host)` is the composer-visibility rule, written
  separately from the admission, with a `FollowUpHost` whose only field
  (`terminalBacked`) every host passes as a constant and the extension passes
  inconsistently (`true` in `ToolUseRunContent.ts:20`, `SessionComposer.ts:534`,
  `sessionSurfaces.ts:446`, `TaskGroupList.ts:275`; `false` in
  `RunHeader.ts:362`), so a codex child's header says it cannot continue while
  its composer shows. `terminalBacked` has one setter
  (`detachedChildRun.ts:216`) and this one reader. Second PR with the CLI
  cut: `FollowUpHost` goes; `acceptsFollowUp` and `submitFollowUp` read the
  same facts.
- `Inbox` methods with one caller: `resumeSettled` (`SessionRequests.ts:282`),
  `joined` (`effect/runHandle.ts:297`), `closeInput` (`resumeRun.ts:182`),
  `forget` (`sessionLayer.ts:258`), `sendDetached` (`childRunLoop.ts:424`),
  `onClosed` (one consumer, the GitHub registry). The first two are resume
  questions that sat on the inbox because the `resumes` map did; they moved
  to a `Resumes` class (`followUps.resumes.once / settled / joined`, and the
  `inFlight` set the wake reads), which lives in `ToolUseFollowUp.ts` beside
  the resume it dedups, and keeps `Inbox.ts` under the 400-line core limit;
  `followUpSender.ts` folds into `followUpMessages.ts`. The `entry-files`
  ratchet holds: no entry closure gained a file.
- `FollowUps`: 7 members and 3 single-consumer types → `read`, `hasPending`,
  `next`, `controls`, `consume`, `release`; `ConsumeOptions` is the one
  exported type.
- Kept with reason: `FollowUpFailureReason` (every value produced; one
  wording table), `InboxItem.displayText` (three readers),
  `SendOptions.fromParent` (the only-the-parent-instructs rule), `RunInbox`
  (the plugin door).

## Review

What the fresh review (2026-10-23, read-only against `a20cc39310`) changed:

- `needsWake` over "message vs control" would have resumed a run for a
  lingering pause notice at every generation-leave (and stranded the
  resume's idle latch, `resumeRun.ts:297-303`), resumed a completed parent per
  progress notice, and revived a finished conversation for a sibling's
  message or a GitHub event. It is now over readable rows, `'generation'`
  never wakes, and the sender rule of `ToolUseFollowUp.ts:333-338` is kept.
- The child's end job cannot consume its stale notices: detached,
  held-elsewhere, user-stopped and persist-only children never run one. The
  stale check stays at read time, in the one shared predicate, keyed on the
  row's `from.runId`.
- `Inbox.wake` without `log.settled` loses the unwind-window send.
- The Stop window is unwind-sized; the first draft's halt-row fence would
  have left the extension's "Stop, then retype" message queued and unread.
  The admission now waits for the drain, as the CLI does.
- `Sent.wake` is read in `runtimeRequest.ts:192`, `SessionRequests.ts:425`,
  `hostRunActions.ts:603`, `chatSessionController.ts:1085, 1095`,
  `TasksForm.tsx:382`, `send.ts:114`; it stays as the sender's relay of
  `Inbox.wake`.
- `wakeParent` has six call sites and an interface field; its body changes,
  the sites stay.
- The Anthropic codec branch is unnecessary.
- `joinStopped` → `consume` delivers non-instruction rows to a stopped turn's
  dispatch; stated above.
- A process child's wait still needs the abort.
- `rowVersions.ts` bumps `followup.queued`.
- Line corrections: `since` stamps at `runRegistry.ts:470, 649, 776`; the loop
  also reads at `toolUse.ts:443` and through `joinStopped` at `:331`.

## Verified

- The old engine's delivery point: `ToolUseRoundPrepNode.prep` at v0.40.10
  ("injected here BEFORE calling the model"), deleted in #12314 with no
  replacement in the loop.
- Every send site: `SessionRequests.ts:403` (hosts), `executions/send.ts:97`,
  `agentCliShared.ts:72`, `githubSubscriptionTool.ts:626`,
  `RunSubscriptionRegistry.ts:135`, `modelSwitch.ts` (controls),
  `childRunLoop.ts:424` (progress), `childTurnResult.ts:237, 319` and
  `childRun.ts:209` (child results and pause notices, in the child's
  transaction), `runLifecycle.ts:372` (lost result).
- `applyRunRow` accepts a `followup.queued` row before the run's `run.start`
  (`runRows.ts:282`), and the CLI mints the run id before launch
  (`chatSessionController.ts:849`), so the CLI can send to a starting run
  without waiting for the view.
- `userFollowUpSupport` can lag the live loop: a resume passes its own
  `stopAfterCycle` (`resumeRun.ts:309`), so a one-shot headless run resumed by
  a user message becomes a conversation. The admission keeps both checks
  (live `oneShot`, else the row), as `send.ts` does today.
- A completed parent with a live background child: `release('recoverable')`
  keeps its input open; no `followup.closed` is written at `run.end`; the
  child's delivery is admitted under the parent's claim and `canResume`
  accepts an ended conversation (`runActions.ts:94-96`).
- The fold's `append` with `sourceResponse: null` is already used mid-turn by
  the loop's nudges; a mid-turn user message changes no turn count.
- The crash suite (`crashConformance.ts:178-190, 1090-1093`) pins queued-once
  and consumed-once per follow-up id; a consume at a request boundary stays
  within it.

## Landed

Steps 1 to 7 of the plan below landed in #14261 (`f5c5f063f3`, 2026-10-24),
with the review fixes listed in that PR. Finding F5 of the ownership audit,
which this design's step 7 points to, landed in #14266 (`3e474178c5`). The
audit's own leftovers are listed in that note, not here.

## Still open

The second PR, which none of #14261 started:

1. **The CLI's own delivery bookkeeping.** `FollowUpDeliveryQueue`,
   `interruptedRunId`, `claimPreparingRoot` and the `awaitRunFolded` race in
   `packages/cli/src/chat/chatSessionController.ts`. `submitFollowUp` now
   routes, refuses and waits for a stopping run to drain, so the CLI's copies
   of those decisions go. The queue sends each message to the harness at
   once, one at a time, which is why a message typed in the CLI is already
   delivered at the next request (the hermetic validator's artifact shows
   it).
2. **`FollowUpHost`.** The constant each host passes to `acceptsFollowUp`
   (`packages/harness/src/shared/session/sessionView.ts`) goes;
   `acceptsFollowUp` and `submitFollowUp` read the same facts.
3. **A key that holds a message for the turn's end.** The harness reads
   `holdUntil: 'turn'` already; no host sends it. The key (Enter sends for
   the next request, a second key holds for the turn's end) belongs to the
   CLI's composer once item 1 is cut.

## Plan

One PR, in this order, each step type-checked and `test:pure` green:

1. `readableMessages`, `needsWake`, `consumedRow`, `isInstruction` in
   `runRows.ts`; `holdUntil` members and the version bump; every site uses
   them; `endedChildProgress` goes. Behaviour-preserving except the panel
   count.
2. `Inbox.wake`; delete the three wake mechanisms and `since`; progress
   notices and GitHub events send `'generation'`.
3. `submitFollowUp` owns admission and the drain wait; delete
   `getToolUseFollowUpTarget`.
4. One `consume`; `joinStopped` goes; the compaction text moves; the
   dispatcher reads the loop's controls; one presenter for the send result.
5. Delivery at the next request; the blank-nudge test. The CLI key goes to
   the second PR ("Still open", item 3).
6. E2E: `validate-run.mjs` (the hermetic CLI validator every PR runs)
   drives a real `texra chat` under a PTY against the validation model: the
   agent's one command waits for a release file, the message is typed while
   it waits, the file is written once the message's row is queued. The
   chat's rows are the artifact (`mid-turn-delivery.json`): the
   `followup.consumed` row sits between the command's `tool.result` and the
   turn's second model attempt, and the run has one turn. The crash suite's
   clean pass already crosses the new commit point for its `/compact` and
   `/model` requests; a user message consumed at a request boundary is the
   same row pair, pinned queued-once and consumed-once by the suite.
7. From the ownership audit (`2026-10-24-ownership-audit.md`), the two
   findings on this chain. F1: the stop begun for a run is the registry
   entry's `stopReason` from the request until the view folds the run's end;
   child admission reads it, so the per-stop tokens, their lift at settlement
   and the folded-stop sweep that patched the window between them go, with
   one refusal message. F2: `runRejection` is the one decider of why a resume
   here is refused, asked by the message admission before the row commits, by
   the resume under the run's claim (in place of `canResume`), and by a
   host's run record; an earlier build's rows refuse as `earlier_build`
   instead of failing the resume. `blocked` stays the resume's alone: the
   blocker needs the catalog services the admission's callers do not carry.

Files: `runRows.ts`, `rowVersions.ts`, `RunInput.ts`, `Inbox.ts`,
`FollowUps.ts`, `ToolUseFollowUp.ts`, `followUpMessages.ts`, `toolUse.ts`,
`toolUseDispatch.ts`, `rows.ts`, `childTurnResult.ts`, `childRunLoop.ts`,
`runRegistry.ts`, `sessionLayer.ts`, `sessionViewUpdate.ts`,
`executions/send.ts`, `compaction.ts`, `sessionEvent.ts`,
`RunSubscriptionRegistry.ts`, `TasksForm.tsx`, the CLI composer and panel.
