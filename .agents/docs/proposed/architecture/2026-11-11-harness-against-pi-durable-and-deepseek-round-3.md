---
created: 2026-11-11
status: proposed
---

# The harness against pi-durable and DeepSeek Harness, round 3: waits and inputs

Read on 2026-11-11 at TeXRA `2f63e5a4`: `main` after round 2 (#14896),
#14893, #14897 and #14899. Every finding was checked again on 2026-11-14
at `d173e42d`, 33 commits later, and every line reference below is at
`d173e42d`. In those commits #14936 deleted one dead export this note had
listed, and #14926 fixed one more case of finding 1's cause. The peers are pi
[`473515f`](https://github.com/earendil-works/pi/tree/473515f9c297c75cf2c3ebb3ba027049ed836d27)
(`packages/durable`, its `[Unreleased]` section) and DeepSeek Harness (dsh)
[`fcc0ad4`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159),
which has not moved since round 2. Peer paths carry a `pi:` or `dsh:`
prefix. TeXRA paths are under `packages/harness/src/` unless they name a
package.

[Round 2](../../implemented/architecture/2026-11-10-harness-against-pi-durable-and-deepseek-round-2.md)
landed its findings 1 to 5. This round asks the same question on the new
`main`: which parts of the harness still decide one fact in several
places, where one general shape would do. pi's newest change picks the
place to look. It reports only what no earlier round, open note or
catalogue row records, or what the catalogue marks landed while the tree
says otherwise; finding 2 is of the second kind.

## Summary

The core stays sound: every resumable fact is a row, the model
invocation decides from its rows (`nextAttempt`), one publisher commits in
order, and a child's result travels typed (round 2). What is ad hoc this
round sits where a run waits on something outside its own work, and where
a message reaches a run.

| #   | Finding                                                                                                                    | Red flag (Ousterhout)                                                       | What goes                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A person's answer cannot reach a run no process holds**, and a run's end cancels requests its docs say outlive a restart | information leakage, two representations, special and general code mixed    | the decide door's "resume it first" rejection, the public `requestAnswerability`, the panels' resume state, a second request switch      |
| 2   | **A message is accepted that its run will never read** (A4, marked landed)                                                 | one fact decided at seven sites, two representations, false comment         | the sending path's missing rule, the view check, `owesResume`'s own rule, the dead `'instruction'` hold, the re-reads of the whole input |
| 3   | **A script is told its calls run together, and most run one at a time**                                                    | nonobvious code, a contract that says one thing while the code does another | the text, or the barrier inside a script (an owner decision); the launch count kept in memory                                            |
| 4   | **A turn end the run state forgets**: a crash after `submit_output`'s results resumes into one more billed request         | a fact the loop branches on that no run-state field holds                   | the live-only `endTurn`                                                                                                                  |
| 5   | Smaller: one dead schema value, one false comment                                                                          | dead code, a comment that says what the code does not                       | `holdUntil: 'instruction'`, `endIn`'s comment                                                                                            |

Findings 1 and 4 are defects traced through the code, not reproduced;
findings 1, 2 and 3 each carried an owner decision named in their section.
At `c78e9f9` (2026-11-17) only finding 3's is still to make: finding 1's
cancel rule is in the code and finding 2's `takesFollowUps` rule was ruled
in #14986 (see "Since this note's base").

## Since this note's base

**[Nothing held across a wait](./2026-11-14-nothing-held-across-a-wait.md)**
(the concurrency audit of 2026-11-14) owns what code holds while it waits
in one process: locks, permits, registry entries, lifetimes, and the
Effect primitive for each need. This note is about the other half: what a
durable wait means once no fiber is waiting, that is, what a person's
answer, a message or a script's call does to a run, above all a run no
process holds. Finding 1's design is that note's rule ("work that must
wait holds nothing and decides again when the wait ends") applied to a
person's answer. That note also records, as open, that "a run's end closes
open requests with the same decision a person's cancel writes"; finding 1's
cancel rule is the other half of the same rule, and #14926 is a defect it
caused.

**On `main` since `2f63e5a4`.** #14936 deleted `openOwnedChildren`, which
the first version of finding 5 listed. #14926 fixed one more case of
finding 1's cause. No other finding changed; their lines are updated.

**On `main` at `c78e9f9` (2026-11-17).** Each item of "Order" was read
again in the tree. The line references below are still those of
`d173e42d`; where a name moved, this paragraph gives the new one.

- **Finding 1's cancel rule is in the code.** `cancelledRequests` and
  `unboundRequests` have no references. One function, `cancelRequestRows`
  (`shared/session/runState.ts`), writes the cancellations for a run's end
  (`agent/storage/runLifecycle.ts`) and for a resume's activation
  (`agent/runtime/makeRunHistory.ts`), and it leaves a request that does not
  block its caller open. No suite holds the regression test the order asks
  for: the one test with a `blocksCaller: false` request
  (`src/test-kernel/controllers/session/sessionEvents.vitest.ts`) covers a
  missing plugin, not a clean close.
- **Finding 2's first case is gone.** #14969 rewrote `needsWake`
  (`agent/followUp/FollowUpReader.ts`): any run's message now wakes a run
  that ended, except after a user's stop. The second case stands: a run's
  message to a run the user stopped is still answered `queued`.
  `admission` is now `Inbox.acceptance` (`agent/followUp/Inbox.ts`), and it
  still reads only `inputClosed` and the in-memory readers.
- **Finding 2's `takesFollowUps` rule is ruled** (#14986): a message keeps
  reading the view in `submitFollowUp`, and the comment there says why (the
  store's answer would reject every ended one-shot root, which a later
  resume does read). So the view check stays and leaves "What goes".
- **`holdUntil: 'instruction'` is gone.** The field is
  `Schema.optional(Schema.Literal('turn'))` (`shared/schemas/followUp.ts`).
- **Still as written:** the decide door's rejection
  (`controllers/session/SessionRequests.ts`) and `requestAnswerability` (8
  references); the script request's own run reload (`AgentTool.ts`);
  `readers`, `disposed` and the two answer shapes; the `Promise.all`
  sentence, the barrier state (`places`, `barrier`, `since`) and the
  in-memory launch count (`countLaunch`, `agentChild.ts`); the live-only
  `endTurn`; `endIn`'s comment.
- **Design B's receipt half is gone.** `followUpReceipt` has no references,
  and "has this message been taken" is read only through `applyRunRow`
  (`sharedRowsFrom`, `shared/session/runRowReads.ts`);
  `followUpMessages.ts` no longer has a read-then-tail. What is left of B is
  reading the input once per loop step.

**On `main` at `8439d64` (2026-11-19): findings 1 and 2 implemented.** The
sections below keep the note's analysis as written; this paragraph says what
the code does now and where it departs from the design.

- **Finding 1, the decision as a wake: landed, by a different mechanism.**
  #14943 ("a resume restarts the step") had removed the guard's re-entry
  after this note was written: an activation cancels every open request
  that blocks its caller and the call asks again under a new id, so there
  was no open request left for a later decision to land on. The decide door
  (`controllers/session/SessionRequests.ts`, `decideSurfaceRequest`) now
  hands the answer to the run registry (`RunRegistry.holdAnswer`) and
  resumes the run (`resumeOwner`, following the parent whose open call owns
  it). The asking run's activation commits the `request.decided` after its
  `run.activate`, in place of the cancellation
  (`agent/runtime/loop/runLoop.ts`, `agent/runtime/makeRunHistory.ts`), and
  `resumedAttempt` reads a decision newer than the latest activation as one
  nothing has read: the call starts again and takes it when it asks the
  same thing (`callRequests`, compared by payload, so an answer never lands
  on a different question). No row changed. A resume that is refused
  rejects the decision with the resume's reason. `requestAnswerability`,
  `RequestAnswerability` and the panels' resume state are deleted.
  Left: the held answer is in memory until the activation, so a process
  that dies between the two loses it and the request stays pending (the
  person answers again); the variant that records the decision at once
  takes the `request.decided` version bump named above. An answer to a
  child's request is acknowledged once its parent has resumed, before the
  child's own activation commits it.
- **Finding 1, one request switch: half.** The script's shared request no
  longer reloads its run (it reads the request rows, as a decision does)
  and takes a held answer through the same rows. Its lookup stays its own:
  the request is keyed to the script (attempt 0 of the script's call), not
  to the asking call's attempt, and serving it from `callRequests` means a
  shared-attempt id on the public `CallRequests` and the dispatcher's state
  passed into it, which waits for the split of `loop/toolUseDispatch.ts`.
- **Finding 1, the cancel rule's regression test: already there.** A clean
  close writes no end any more (`packages/harness/AGENTS.md`, "Lifecycle":
  a quit leaves what a crash leaves), so the path this note traced is gone.
  What remains of the rule is that a run's end leaves a non-blocking request
  open, and `sessionEvents.vitest.ts` ("keeps a plugin request pending
  without its plugin or its run") asserts exactly that after a stop's end.
- **Finding 2 A: landed.** `sendVerdict`
  (`agent/followUp/FollowUpReader.ts`) is the one rule of a send, read in
  the job that commits it: `queue`, `replay` or `refused` with its reason
  (`closed`, `stopped`). It shares one predicate with `needsWake`, so a
  run's message to a run its user stopped is refused and the sender told. A
  child's report is exempt and still queues for the user's resume: refusing
  it would drop the child's result. `Inbox.send` answers the verdict and
  `SubmitFollowUpResult` is the one answer a sender gets. `readers` and
  `disposed` are gone: the run the registry holds reads its own rows, waits
  on the log's tail for the next message, and hears a closed input through
  the inbox's observers. `owesResume` is `needsWake` over one read; whether
  a fiber drives the run is the registry's answer (`wakeIfOwed`).
- **Finding 2 B: landed.** The reader hands a loop step one reading
  (`RunInput`); `runLoop.ts` reads the input once per turn step, once at an
  idle wait (which then waits from that reading) and once at a turn's end.

## What picks the targets

**pi's newest change.** pi `473515f` ("suspendable work") gives every
wait one mechanism (`pi:CHANGELOG.md`, `[Unreleased]`):

- A task sleeps on typed signal keys and an optional deadline. A value
  delivered with `harness.signal(taskId, token, key, value)` is stored on
  the task and answers `delivered`, `duplicate`, `invalid`, `closed` or
  `not_found` (`pi:src/signals.ts:45-50`, `:194-221`). The wake marks the
  key consumed and records why it woke (`time`, `expired`, `signal`,
  `tasks`; `:268-292`).
- A tool returns a park (pi's word) in place of a result and holds no
  invocation while it waits (`pi:src/harness/parks.ts`); its call is in a
  `parked` phase until a wake runs it again (`pi:src/harness/tool.ts:95-102`,
  `:208-232`).
- An approval is a gate: a `beforeTool` hook that sleeps on a signal, and
  the whole call phase runs again on every wake
  (`pi:test/examples/44-approval-gate.ts`).
- A subagent tool waits until its child's submission answers, through a
  signal the child's settling commit delivers (`SubmissionDraft.notify`;
  `pi:test/examples/43-subagent-waits.ts`): "while the person thinks,
  every task is parked and the Session needs no process".

**Fixes this month.** `node scripts/report-fix-churn.mjs` over the 30 days
to 2026-11-11 flags the same two areas as round 2: stop, resume and
ownership (24) and model, retry and route (23). Both counts are inflated
by the script's word match ("own noun", "own errors", every "model"). Read
one by one:

- model, retry and route: about 8 fixes of the mechanism, in four places
  (retry spend at a crash or a close, #14423 and #14445; a provider
  boundary's scope, #14863; route refusals, #14681 and #14687; model ids,
  #14715 and #14551; a 429's retry-after, #14746). No cluster.
- stop, resume and ownership: about 17 fixes. Four rejoin a wait after a
  resume (#14478 an edit proposal, #14042 a script at its wait, #14424
  work a crash cut, #14591 a script's stage), four are an input's wake or
  the stop fence (#14893, #14230, #14182, #14021), six are stops of runs
  and children (#14571, #14567, #14573, #14568, #14363, #14230), two
  refuse a resume (#14610, #14602), and three are host-side (#14021,
  #14005, #14717).

**Sizes.** The input subsystem (`agent/followUp/`, `agent/runtime/FollowUps.ts`,
the input schemas and readers) is about 1,930 lines; pi's
(`pi:src/harness/submissions.ts`, `inbox.ts`) is 498 and dsh's
(`dsh:packages/core/agent-loop/src/inbox.ts`) is 232. The request and
approval modules are about 2,030 lines, the child and delegation modules
about 2,860.

Three read-only area passes (waits, inputs, the script door) mapped these
modules; every claim below was then read in the tree.

## 1. A person's answer cannot reach a run no process holds

### What the code does

TeXRA has eleven kinds of wait. Each leaves a durable record under a
derived id, and a resume rejoins it by deriving the id again:

| Wait                                             | Record                                                         | Rejoin on resume                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A blocking request (approval, plan, question, …) | `request.opened`, id `${responseId}/${callId}:${attempt}:${n}` | `resumedAttempt` (`shared/session/inFlight.ts:410-432`), the guard      |
| A script's shared `agent()` request              | the script call's attempt-0 request                            | its own lookup (`agent/runtime/delegation/AgentTool.ts:190-228`)        |
| A model retry request                            | `failed{next: ask}` with `request.opened`                      | `nextAttempt`'s ask case                                                |
| A non-blocking plugin request (an inquiry)       | `request.opened`; the answer commits with its effects          | none: it stays open                                                     |
| An awaited child                                 | the child's `run.start` under `callChildRunId`                 | `earlierChild`, `standingOf` (`agent/runtime/delegation/agentChild.ts`) |
| A detached child or a background command         | the child's `run.end` and its report on the parent             | `closeLeftoverRun`, `cutShort` (`agent/runtime/leftoverChildren.ts`)    |
| A hook process                                   | `hook.outcome` per point                                       | the recorded outcome is reused (`agent/runtime/loop/hooks.ts`)          |
| A run waiting for input                          | `run.position waiting`, `followup.queued`                      | the loop's wait branch, `wakeIfOwed`                                    |
| A script waiting for its calls                   | `script.call` per `seq`                                        | the replay prefix (`agent/runtime/loop/toolUseDispatch.ts:617-638`)     |

(The other two, `executions wait` and a stop committing, keep nothing to
rejoin.) This is the right shape, and most of the differences are
essential: a request needs only someone to wait on its answer, a child
needs its program driven, a hook can only run again, a script replays. One
generic rejoin would be a template method. Three things are not essential.

**A decision for a run no process holds is rejected.** The decide door
rejects a person's answer to a blocking request when the run that asked is
not running here: "The task that asked is no longer running: resume it to
answer this request." (`controllers/session/SessionRequests.ts:186-195`).
The hosts carry that rule as a state of their own: `requestAnswerability`
answers `'answerable'` or `'resume'` (`shared/session/sessionView.ts:279-286`),
is public through `@texra-ai/harness/schemas` (`schemas.ts:49`, `:54`), and
is read by the session view (`sessionView.ts:361`), the script stage
(`shared/transcript/scriptStage.ts:242`) and the request card
(`packages/texra/src/ui/progress/components/RequestPanels.ts:136`,
`BaseRequestPanel.ts:125`). A message to the same run is accepted and
wakes it.

The reason is that whether a decision was already read is not a fact of
the rows; it is inferred from the order of activations. A started call
re-enters its own request only while the decision is newer than the
current activation (`decidedAt > state.activatedAt`,
`shared/session/inFlight.ts:430`); an older one counts as read by a waiter
that died, so the body may have run. A decision written while no process
holds the run would read as already consumed at the next activation.

The same inference has to be written again wherever a decision is read.
#14926, which landed while this note was written, added one more: a model
retry request that a run's end had cancelled was read on resume as the
person's cancel and ended every resume, and the fix reads the decision's
age against the activation (`shared/session/inFlight.ts:285-293`).

**The request switch is written twice.** "Answered: take it; open: wait
on it; absent: open it" is the guard's (`agent/runtime/loop/toolGuard.ts:300-342`)
and again the script's shared `agent()` request's, which reloads the
whole run to find its request (`AgentTool.ts:190-228`) and calls the
waiter itself.

**Two cancel rules disagree.** A non-blocking request is promised to
outlive a restart: "its plugin's decision hook delivers the answer to
whichever process holds the run by then, so it stays open across every
resume" (`shared/schemas/request.ts:172-178`); the inquiry tool says its
answer arrives "even hours later, even after a restart"
(`packages/texra/src/tools/inquiry/ExternalInquiryTool.ts:8-11`).

- A resume's activation cancels only the requests no attempt re-enters
  (`unboundRequests`, `shared/session/runState.ts:238-259`, applied at
  `agent/runtime/makeRunHistory.ts:337-358`), and that set leaves
  non-blocking requests out.
- A run's end cancels every open request, non-blocking ones included
  (`cancelledRequests`, `agent/storage/runLifecycle.ts:189-199`, written by
  `endIn` at `:310`).
- A clean close writes an end: a `CANCELLED` end with a `shutdown` stop,
  which a resume continues (`cutShort`, `agent/runtime/leftoverChildren.ts:95-97`).
- The decide door answers only pending requests, as the inquiry plugin
  notes ("the session decides only pending requests",
  `packages/texra/src/tools/inquiry/inquiryActions.ts:113`).

So an inquiry survives a crash, which writes no end, and is cancelled by a
clean close, which does: the opposite of what both docs say. This chain is
read step by step and not reproduced.

### What the peers do

pi keeps a delivered value on the waiting task and marks it consumed when
a wake reads it (`pi:src/signals.ts:268-292`), so a value can arrive while
no process runs the task and wakes it later. An approval is a signal to a
gate (example 44). dsh's approval is a one-shot call through answerer
listeners, withdrawn when its step aborts and not durable
(`dsh:packages/interaction/user-approval/README.md`).

### The design

**A decision is a wake, as a message already is.** The decide door
accepts an answer for a run no process holds: it resumes the run as a
message's wake does (`wakeRun`, following an owning parent), and the
decision commits once the asking run's activation is in, so it is newer
than that activation and the re-entered call takes it from the row
(`toolGuard.ts:311-314`). A resume that is refused rejects the decision
with the resume's reason, as it does for a message. No row changes. The
variant closer to pi records the consumption itself on the decision, so
no ordering carries it; that one takes a `request.decided` version bump.

**One request switch.** The guard's re-entry serves the script's shared
request too, fed from the dispatcher's state, so its own run reload and
waiter call go.

**One cancel rule.** A run's end cancels the blocking requests it leaves,
which nothing waits on any more, and leaves a non-blocking request open
until it is answered or the run is deleted, as `blocksCaller`'s doc and
the inquiry tool say. Which rule wins is an owner decision; the docs and
the plugin were written for this one.

**What goes:** the rejection in the decide door, `requestAnswerability`
and `RequestAnswerability` (public), the panels' resume state, the script
request's lookup and waiter, and the end's cancellation of non-blocking
requests. The line count is small; the gain is that a person's answer
behaves like any other input.

**Not taken from pi.** Releasing the fiber while a call waits: pi runs
`execute()` again on every wake (`pi:src/harness/tool.ts:211-232`), and
TeXRA's tool bodies are written in direct style; running them again would
recompute what they computed before asking, which is the bug #14478
fixed. A waiting fiber costs memory only, so re-entry stays for resumes
across processes. A `call.park` row would restate `request.opened` and a
child's `run.start`.

**Risks.** A child's request needs the child's own activation before its
decision, not its parent's. Answering a request of a closed session now
resumes its run, which is the point but is new to a person used to the
resume-first card.

## 2. A message is accepted that its run will never read

### What the code does

Whether a message wakes its run is `needsWake`'s rule
(`agent/followUp/FollowUpReader.ts:59-76`): a user's message wakes a run
unless a user's stop came after it; a child's or parent's message, unless
the run was stopped by a user; any other run's message only while the run
has not ended ("a peer's message never revives a run that ended", `:55`);
a notification never. Accepting a message is `admission`'s rule
(`agent/followUp/Inbox.ts:270-277`): the input is not closed, or a reader
here holds it. The two disagree:

- A peer's message to an ended run, and a run's message to a run the user
  stopped, are accepted and answered `queued`, and nothing wakes the run
  for them.
- `executions send` then tells the sending model the run "reads the
  message before its next model request, or at its next turn boundary"
  (`tools/executions/send.ts:94-97`).

This is the catalogue's A4, marked "landed (#14769, R5)"
(`.agents/docs/evidence/2026-11-07-design-red-flags-lenses/catalogue.md:1143`).
Its target was one rule read in the sending job, with the answer
`sent | refused(reason)` and the in-memory `readers` and `disposed` gone
(`.agents/docs/evidence/2026-11-05-design-red-flags/A-child-runs.md:294-306`).
#14769 deleted `wakesOnly` and left the rest: the sending job reads only
`inputClosed`, `readers` and `disposed` stand (`Inbox.ts:104`, `:108`),
and there are two answer shapes (`Sent`, `Inbox.ts:78-81`;
`SubmitFollowUpResult`, `agent/followUp/ToolUseFollowUp.ts:45-48`).

The area pass counted seven deciders of "does this message wake the run"
(`readableMessages`, `needsWake`, `owesResume`, `wakeRun`, `openResume`,
the stop's drain wait and the loop's wait branch), four representations
of "the input is closed" (`run.start.takesFollowUps`, `inputClosed`, the
in-memory readers, and the "takes no more input" signal observers hear),
and two readings of "has this message been taken" (`applyRunRow`'s, and
the receipt's own scan in `shared/session/runRowReads.ts:319-339`).

Each read of a run's input decodes every input row since its start
(`controllers/session/sessionStore.ts:182-184` reads from seq 1), and one
turn reads it up to four times before its model request
(`agent/runtime/loop/runLoop.ts:315`, `:349`, `:364`, `:373`) and three
more at its boundaries (`:418`, `:440`, `:473`). The cost grows with the
conversation; it is not measured here.

Two leftovers:

- `holdUntil: 'instruction'` has no writer
  (`shared/schemas/followUp.ts:158`, read at `FollowUpReader.ts:26-43`),
  and since `followup.queued` v6 no readable row can hold it.
- `endIn`'s comment says "a root's unread input dropped"
  (`agent/storage/runLifecycle.ts:256-258`), but `consumedRows` drops only
  controls (`agent/runtime/loop/rows.ts:177-191`, called at
  `runLifecycle.ts:301`): a root's queued messages stay for its resume,
  which is what the golden suite pins.

### What the peers do

pi accepts an input in one commit (`admitSubmission`,
`pi:src/harness/submissions.ts:220-319`): a busy conversation queues it,
an idle one places it and starts the run in the same commit, so there is
no separate wake to decide. A submission's status is stored, and `wait`
answers from the commit observer. dsh's send is one event plus a wake of
the driver (`dsh:packages/core/agent-loop/src/agent.ts:170-176`), and its
inbox is an in-memory projection of those events (`inbox.ts:26-61`).

### The design

**A. One verdict, read in the sending job (A4's rest).** A pure function
over the run's input rows, of the shape of `nextAttempt`: `queue` (with
whether it wakes), `replay` (a caller id already sent) or `refused`
(with its reason). Every sender's job, `owesResume` and `openResume` read
it; `sentBefore` still runs first, as the receipt rule requires
(`packages/harness/AGENTS.md`, "Run loop architecture"). The answer is
then `sent | queued | refused`, and a message nothing would read is
refused with its reason. The `takesFollowUps` question #14893 left open was
ruled in #14986: a message keeps reading the view, so that rule is not the
verdict's.

**B. One input reading for the reader and the receipt.** The reader reads
the input once per loop step and answers `{ readable, controls }`; a
receipt's `wait` applies each new row to what it holds instead of
reading again. `followUpReceipt`'s separate scan goes.

**What goes:** `owesResume`'s own rule, the scattered `disposed` checks, two of the
three rejection wordings, and the repeated full reads (the view check in
`submitFollowUp` stays, by #14986, and the `'instruction'` hold is already
deleted). The area pass estimates A at about 60 lines out and 45 in, and B
at 150 out and 80 in; round 2 found such estimates undercount what
replaces the code, so read them as such.

**Risks.** A rejects messages it accepts today (a run's message after a
user's stop, a peer's message to an ended run); that is the point, and a
behavior change. B must keep the receipt's read-then-tail order
(`agent/followUp/followUpMessages.ts:128-132`).

## 3. A script is told its calls run together, and most run one at a time

### What the code does

The `script` tool's description tells the model "Use `Promise.all` to run
calls together" (`tools/codemode/ScriptTool.ts:326`). The script door
places each call in issue order and gives it its tool's lane
(`agent/runtime/loop/toolUseDispatch.ts:784`): a barrier waits for every
call placed before it (`inLane`, `:644-672`, `:650`). Only read, grep,
glob, the web tools and the four search tools declare `parallel`, and
`agent`, `self()` and `document_task` declare `own`; every other tool is
a barrier by default (`agent/runtime/run/tools.ts:73-74`): bash, the edit
and write tools, the document tools, and every MCP and plugin tool. So
`Promise.all` over two commands runs them one after the other.

A script's agent launches are capped at 1,000 (`agent/runtime/delegation/agentChild.ts:45`).
The count is a value the door shares in memory (`toolUseDispatch.ts:710`),
made afresh at each activation, and a resume's replayed calls never reach
it: the cap holds per activation, not per script. The same shape for file
reads was fixed in `d99b6f92` by reading them from the rows.

### What the peers do

pi applies no lanes to nested calls: "the caller decides what runs at
once by what it awaits" (`pi:src/harness/types.ts:373-374`); its round
rule binds only the model's own calls. dsh partitions the model's
response only (`dsh:packages/core/tools/src/batch.ts`).

### The design

Two choices; the owner picks one.

- **Say what happens.** The description names the tools whose calls run
  together and says the rest run in the order issued. No behavior
  changes.
- **The guest's awaits are the order, inside a script.** A call takes one
  window slot unless its lane is `own`; no barrier applies inside a
  script, and the response path keeps its lanes. This deletes the door's
  issue-order and barrier state (`places`, `barrier`, `since`, about 25
  lines) and makes the description true, against the design that chose
  issue order (`.agents/docs/implemented/architecture/2026-10-01-codemode-everywhere.md:140-143`).
  Risks: several approval cards from one script at once, and plugin tools
  that rely on the barrier to avoid running together.

Either way, the launch count is read from the script's `script.call`
rows, as file reads are.

**Not proposed, with the evidence.** The thirteen fix commits on these
files this month cluster on facts kept outside the rows (`86220d8e`,
`d99b6f92`, `1f65bf3b`), calls a script left open at its end
(`fb96546a`), an ambient context (`906ed646`) and calls by origin
(`0c74e369`, `ca1e5906`); none changed lane or ordering behavior. Round
2's "the lane rule written twice" stays recorded, not proposed. Two
hazards the area pass inferred (a guest that never issues a recorded call
waits out its timeout; live results reach the guest in completion order
rather than commit order) are not reproduced and not proposed.

## 4. A turn end the run state forgets

### What the code does

`submit_output` is the one tool whose result ends the turn
(`endTurn: true`, `tools/structuredOutput.ts:219`). The delivery decides
it from the pending response's results (`toolUseDispatch.ts:869-873`),
and the loop ends the turn from the delivery's return value
(`agent/runtime/loop/runLoop.ts:324`). The delivering `append` clears the
pending response and sets `at` to `results.ready`
(`shared/session/turnRowHandlers.ts:261`); no run-state field keeps that
those results end the turn.

A crash after the delivering `append` and before `turn.end` resumes into
the turn: no pending response, no handed-down call, and `at` is not
`response.ready`, so the loop goes on to a new model request
(`runLoop.ts:326-389`). The run pays one more request, and its text
policy then ends the turn because the structured output is in. The
harness's own rule is that "every fact the loop branches on is a row
field the run state reads" (`packages/harness/AGENTS.md`). Read, not
reproduced: the crash suite's scenario has no `submit_output` call.

### The design

The delivering `append`'s handler sets a run-state field when a delivered
call's `tool.result` carries `endTurn`, and the loop reads it on resume.
One regression test, written to fail first: a store cut after that
`append`. This is also a correction to round 2's refused next-move
function (`RUN-turn-next-move-function`): this turn end is a fact of the
rows that the run state drops, not a result of the effect; the refusal's
other cases stand.

## 5. Smaller

- `openOwnedChildren`, exported with no caller at `2f63e5a4` (#14769
  removed the last one), was deleted by #14936.
- `holdUntil: 'instruction'` (deleted since) and `endIn`'s comment (finding
  2; still there).
- A deadline restarts at each resume: a script's `timeoutMs`
  (`tools/codemode/ScriptTool.ts:231`), a hook's timeout, and a retry's
  backoff. pi stores `until`. Recorded, not proposed: whether a process's
  downtime should count is a decision, not a defect.

## Carried from round 2

- Finding 6 (a provider's facts in eight files) as written there.
- The `history delete` race, recorded in
  [the session surfaces audit](../simplification/2026-11-10-session-surfaces-ad-hoc.md).
- Two answers to one inquiry at once can leave the thread's record and the
  decided row naming different answers.
- The `takesFollowUps` question: ruled in #14986 (a message keeps reading
  the view), so finding 2's design A no longer decides it.
- The `endTurn` defect: finding 4, now traced through the code.

## What the peers do that is still not taken

- **Running a tool body again on every wake** (pi): see finding 1.
- **A scheduler for nested calls** (pi's keyed tasks): refused in round 1;
  finding 3's second choice keeps one fiber per call.
- **Storing a message's receipt** (pi stores a submission's status): a
  receipt is read from rows, never stored (`packages/harness/AGENTS.md`).
- **A caller-chosen wake flag** (dsh's `send(message, target, wakeup)`):
  an option for what the rows already decide.
- **Gates that run again on every wake** (pi): TeXRA's hooks are external
  commands, recorded once per point as `hook.outcome` and reused, which
  is already one durable mechanism.

## What is good and stays

- **Derived ids for every wait**, so a resume in another process rejoins
  the request, the child or the hook outcome its attempt left.
- **`hook.outcome` once per point.**
- **`nextAttempt`**, the shape findings 2 and 4 extend.
- **The typed child delivery** (round 2), which finding 2's verdict reads.

## Order

0. **Finding 4**, with its regression test. No owner decision.
1. **Finding 1's cancel rule**: in the code (`cancelRequestRows` leaves a
   non-blocking request open at a run's end and at an activation), and
   tested (see "Since this note's base", 2026-11-19).
2. **Finding 1's decision as a wake**: landed, with the answer held for the
   asking run's activation. Left: the script request's own lookup.
3. **Finding 2's designs A and B**: landed.
4. **Finding 3**: the description now; the guest's order if the owner
   wants it; the launch count from rows.
5. **Finding 5's deletions** at any time. `holdUntil: 'instruction'` is
   deleted; `endIn`'s comment is left.

## Verified

- **Peers.** pi was fetched to `473515f` and read: `src/signals.ts`,
  `src/harness/parks.ts`, the park and wake parts of `src/harness/tool.ts`,
  `CHANGELOG.md` `[Unreleased]`, and examples 43 and 44. dsh has no
  commit since round 2. No peer was built or run.
- **Area passes.** Three read-only passes mapped the waits, the input
  subsystem and the script door. Each claim used above was then read in
  the tree at the cited lines, except those marked inferred.
- **Traced, not reproduced:** finding 1's cancel rule (each step read),
  finding 2's accepted-but-never-woken message (both rules read side by
  side), finding 4 (the loop's resume path read).
- **Fix counts.** `node scripts/report-fix-churn.mjs` on 2026-11-11, and
  the subjects read one by one for the classification above.
- **Sizes.** `wc -l` over the named files at `2f63e5a4`.
- **Checked again at `d173e42d`.** Each cited anchor was looked up again
  in the tree at `d173e42d` and its line updated. #14926 (the final-tool
  state, `nextAttempt`'s cancel check), #14927 and #14936 touched files
  the findings cite; none of them changes a finding beyond what is noted
  above.
