---
created: 2026-11-10
status: proposed
---

# The harness against pi-durable and DeepSeek Harness, round 2: what is still ad hoc

Read on 2026-11-10 at TeXRA `8281784`, and every finding re-checked on
`main` at `521bb189`, after
[one row per fact](./2026-11-09-agent-data-one-row-per-fact.md) (#14894)
merged. The peers are pi
[`a05e3a0`](https://github.com/earendil-works/pi/tree/a05e3a07763c38d23d50207742f7e073e35cd0f8)
(`packages/durable` 1.5.1 and `packages/ai`) and DeepSeek Harness (dsh)
[`fcc0ad4`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)
(0.2.2-rc.1). Peer paths carry a `pi:` or `dsh:` prefix. TeXRA paths are
under `packages/harness/src/` unless they name a package.

Round 1
([harness design by Ousterhout's criteria](../../implemented/architecture/2026-10-30-harness-design-against-pi-durable-and-deepseek.md))
landed its eight moves. Seven red-flag rounds and two lens audits have landed
339 findings since then
([catalogue](../../evidence/2026-11-07-design-red-flags-lenses/catalogue.md)).
This round asks the same question again: which parts of the harness and
`packages/llm` still decide one fact in several places, where one general
shape would do, and what the peers do there now. It reports only what no
earlier round or open PR records, or what the catalogue marks landed while
the tree says otherwise. Two of its findings are of the second kind: A7 and
R7 are marked landed, and half of each is not in the tree.

## Summary

The core is sound:

- every resumable fact is a row;
- the model invocation's retry is a pure function of its rows
  (`nextAttempt`);
- one publisher commits in order;
- the llm `Model` is a deep door with four members.

What is still ad hoc sits beside the core. In each case one fact has two
owners, and each sits behind a cluster of this month's fixes.

| #   | Finding                                                                                                                                                          | Red flag (Ousterhout)                                               | What goes                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Where the loop stands, three ways.** A stored `run.position`, a derived `RunLoopPhase`, and about fifteen predicates in the turn loop and the per-call program | two representations, a stored cursor, nonobvious code               | the `response.ready` and `results.ready` positions, `RunLoopPhase`, `PHASE_AT`, `phaseAfter`; then the branch predicates, for one pure next-move function like `nextAttempt` |
| 2   | **A child's result is typed, rendered to XML and parsed back,** and an awaited child's is formatted twice (A7's typed half, marked landed)                       | information leakage, format then parse, repetition                  | most of `shared/subagentFollowup.ts` (336 lines), the re-parse in `queuedRow` and `followUpDisplay`, the JSON-in-XML script summary, the second formatter in `AgentTool`     |
| 3   | **A run's life is a state machine spread over seven collections,** with a second map of the same fibers and a cast to reach it                                   | state in maps and flags, two representations, overexposure via cast | five of the seven collections, `heldIds`, `stopEnded`, the dead `programs` member, the 11 `registryOf` casts                                                                 |
| 4   | **What kind of run this is, and its launch, decided at many sites:** two owners of "takes input", `run.config` written twice per launch, two terminals           | two representations, temporal decomposition, repetition             | a resume that waits for input its run refuses (reproduced), one `run.config` per launch (47% of its stored bytes), the process child's own end                               |
| 5   | **Which grant answers a request has two tables that disagree,** and three askers go around the one open door (R7's core, marked landed)                          | two representations, information leakage, temporal decomposition    | `GRANT_OF`, `offeredGrant`'s conditions, the five `offersGrant` writers, the invoker's own request and wait, the plugin answer's three transactions                          |
| 6   | Smaller: a provider's facts in eight files (the rest of O9); the lane rule written twice                                                                         | change amplification                                                | the endpoint and region rows written by hand; the sentinel manifest rows                                                                                                     |

Findings 1 to 5 landed on this note's branch (#14896). "Landed" says what
changed and where the result differs from the design; the sections after it
describe the tree at `521bb189`, before the change.

## Landed

Each finding landed in its own commits and was merged into the branch with
the golden store regenerated from the merged source. Finding 1's step 2 was
drafted, measured and refused.

- **Finding 1, step 1** (`28726ae9`, `run.position` v6). The row that
  implies `response.ready` or `results.ready` sets it, and `RunLoopPhase`,
  `PHASE_AT` and `phaseAfter` are gone. 41 of the golden store's 123
  position rows go.
- **Finding 1, step 2** (`06e73da4`), refused as
  `RUN-turn-next-move-function` in `.agents/docs/refuted-candidates.json`.
  The switch that keeps behavior is 338 lines against the 258 it replaces,
  and several turn ends are results of the effect just run, not facts of
  the run state.
- **Finding 2** (`6ec3835a`, `followup.queued` v6). A delivery is a typed
  `ChildRunDelivery`, rendered by `formatDelivery` where the row becomes the
  parent's message. The regex summarizers, `subagentResults.ts`,
  `scriptSummaryElement`, `parseScriptDeliverySummary`, `deliveredResponse`
  and the `escape-string-regexp` dependency are gone. The text the model
  reads is byte-identical in the golden store.
- **Finding 3** (`3cfe5452`, `703b6886`). One `Map<RunId, RunEntry>` of
  five states. `RunRegistry` is a service tag, and `registryOf` (11 casts)
  and `programs` are gone. A resume right after an end resumes the run,
  with a regression test.
- **Finding 4 (a)** (`bbb6f012`). `openResume` decides once: a run waits for
  input only if its rows say it takes input and its caller is present. A
  send to a run launched to run once says so. With a regression test.
- **Finding 4 (b)** (`2386b7ba`). One `run.config` per launch: 36 rows to
  19, and 32,214 bytes to 16,784.
- **Finding 4 (c)** (`8b46c177`). It reproduced: a process run whose
  `process.output` row the store refused ended completed. Both programs now
  end through `commitEnd`, with a regression suite
  (`packages/harness/test/agent/runtime/processRun.vitest.ts`).
- **Finding 5** (`94b19a66`, `ec9142fa`, `ce7cca5a`, `request.opened`
  v11). `answeredBy` is decided at open, and the answer at open and the
  grant sweep read it. `GRANT_OF`, `grantHeld`, `bypassCovers`,
  `grantAnswers`, `policyDecidedRows`, the five `offersGrant` writers,
  `awaitDecision`, the script's private wait and `decisionLanes` are gone.
  A plugin request's decision, facts and follow-up commit in one
  transaction. With a regression test of the grant turned on while a call
  waits.

The golden store went from 749 rows to 691, and from 411,127 bytes of row
data to 394,376.

### Where the result differs from the design

- **The branch adds lines.** Across the packages' `src` directories it is
  +2,014 and −1,810 lines: 204 more than it removes. The "What goes" lists
  named what is deleted, not what replaces it.
  - Finding 1, step 1: −21.
  - Finding 2: −5. `shared/subagentFollowup.ts` went from 336 lines to
    326, not "most of" it: the regex paths went, and the display summary
    of a typed delivery took their place.
  - Finding 3: +137. `runRegistry.ts` went from 686 lines to 816. Each
    state is handled where membership tests were, so the estimate of about
    80 lines removed was wrong.
  - Finding 4: +44 ((a) +11, (b) +8, (c) +25).
  - Finding 5: +52, and −3 for the review fix below.

  Tests are +296 and −83: four regression tests and the fixtures' changes.

- **Finding 2 changes what an awaited call's model reads.** The call
  answers with its child's stored report, so its text now carries the wall
  time, working directory and memory misses. A report says
  `continued="true"` only when the run reported before, not on every
  resume: a child a crash cut short, finished by its recovery, now answers
  with the same report a clean run does.
- **Finding 5 changes behavior in three places**, each following from one
  table.
  - A grant turned on while a plan approval or a non-shell command waits
    now answers it, as it did at open.
  - A non-shell command's card offers "Approve all agent work".
  - When the session closes first, the waiter interrupts the asking fiber
    and records nothing, and the next resume asks again; the invoker had
    ended the turn as cancelled. A failed read of the log fails the wait,
    where it read as a cancel.

  The script's shared request still reloads its run to find the request
  standing for it, which belongs to the script call; only its private wait
  went.

- **The one-shot refusal carries its words, not a kind.** 4 (a) first added
  a `ranOnce` failure reason. Nothing branches on a follow-up's reason, so
  a refused send now answers with its message (`c3304665`, from review).

## Since this note's base

**#14894 landed the largest finding of this round's first draft.** That
draft found the conversation stored twice: history rows the run resumes from
and display rows the hosts render. Its biggest part was the tool cards, and
#14894 removed them. A card is now its call's rows: `tool.intent` names the
card it opens, `tool.result` the card it closes, and `callCard` shows them
as `tool.start` and `tool.end` (`controllers/session/rowReader.ts`).
`cardRows`, `settleCards` and the `at`-based page end are gone, and the
golden store went from 806 to 749 rows.

**#14894 kept the remaining copies on purpose, and this note does not
reopen that.** The copies are the model's answer text (`stream.end.finalText`),
the user-message `log` rows and the copies of a model failure. #14894 §3.1
gives the reason: deriving them would decode the heaviest rows on every cold
read, or cache the text in `projected_row` again. This round measured that
cost on the golden store before the merge, and it agrees. A display read
that took the `response`, `append` and `handed-down` messages, `tool.intent`,
`script.call` and `hook.outcome` in place of the copies would read about
89 KB where the display read took 54 KB, 63% more, while storing 26 KB less.
One correction to the first draft: `response.finalized` is not a copy. It is
the answer after replacement-rule cleanup, and the run state reads it
(#14894 §3.1). It equals the response text in the golden store only because
no replacement rule runs there.

**#14893 (open) raises finding 4 (a) as an owner question.** It is the
`takesFollowUps` check in `submitFollowUp`, read from the view, which skips
it when the view has not loaded the run. It records that
`packages/harness/example/10-external-plugin.ts` sends an ended one-shot
root a message and resumes it, and passes only because of that skip.
Finding 4 (a) adds a reproduced case to that decision. #14893 also moves
the registry's parent edges onto store reads. Finding 3 rewrote the same
file first, so whichever merges second rebases onto the other.

## What picks the targets

**Fixes this month.** `npm run report:fix-churn` (`scripts/report-fix-churn.mjs`)
over the 30 days to `8281784` counts 159 fix commits:

- 63 scoped `harness` and 8 scoped `llm`.
- Three areas are over the script's line of ten, where an area's rulings
  are to be revisited: stop, resume and ownership (24), model, retry and
  route (23), and desktop and windows (13). The third is outside the
  harness and `packages/llm`.

By file (fix commits touching `packages/harness/src` or `packages/llm/src`,
renames followed):

- `shared/schemas/rowVersions.ts`: 13.
- `agent/runtime/loop/toolUseDispatch.ts`: 11.
- `agent/runtime/loop/runLoop.ts` (formerly `toolUse.ts`): 10.
- `controllers/session/SessionRequests.ts`: 8.
- `agent/runtime/ModelInvoker.ts`: 8.

The loop's two files took 20 distinct fix commits. Five of them are
scripts':

- a stage a resumed script reopens (#14591);
- a script's own function sent as a tool (#14582);
- an un-awaited call that finishes late (#14255);
- a failed script resumed while waiting that ends COMPLETED (#14042);
- one child run per nested call (#14251).

**What a run stores.** The golden store on `main`
(`src/test-kernel/fixtures/storage/golden-1.0.sql`) is what the CLI writes
for 18 runs: 749 `event` rows. Counted by `type` (the method is under
"Verified"):

| Rows                                      | Count | Share |
| ----------------------------------------- | ----: | ----: |
| history (the run state reads them)        |   609 |   81% |
| display (only hosts read them)            |   140 |   19% |
| `run.position` (finding 1)                |   123 |   16% |
| `run.config` (finding 4)                  |    36 |  4.8% |
| card rows left (an agent CLI's own cards) |     4 |  0.5% |

## 1. Where the loop stands, three ways

### What the code does

**A stored cursor.** `run.position` is "the one record of the loop's
position" (`shared/schemas/runHistoryEvent.ts:95-98`), with six values
(`:85-92`). It is 123 of the golden store's 749 rows. Two of its values only
restate the row they are committed with:

| Value            | Writer                                                                 | Rows | Always right after       | Readers                                                           |
| ---------------- | ---------------------------------------------------------------------- | ---: | ------------------------ | ----------------------------------------------------------------- |
| `response.ready` | `ModelInvoker.ts:373`, in the batch of the `response` row              |   28 | `model.message response` | one: `runLoop.ts:330`                                             |
| `results.ready`  | `loop/toolUseDispatch.ts:955`, in the batch of the delivering `append` |   13 | `model.message append`   | none outside `PHASE_AT`                                           |
| `turn.ready`     | `runLoop.ts:175`, `:244`; `agent/runtime/FollowUps.ts:281`             |   21 |                          | `forkRun.ts:66`, `runLoop.ts:411`, `delegation/agentChild.ts:123` |
| `turn.begin`     | `runLoop.ts:306`                                                       |   21 |                          | `runState.ts:335`, `transcriptUpdate.ts:386`                      |
| `turn.end`       | `runLoop.ts:472`                                                       |   19 |                          | the follow-up receipt (`runHistoryEvent.ts:103-105`)              |
| `waiting`        | `runLoop.ts:425`, `:474`; `agent/runtime/forkRun.ts:264`               |   21 |                          | four sites                                                        |

The writers and readers come from a grep of the literals over
`packages/*/src`, with tests excluded. The row counts come from the golden
store.

The harness's own rule is that "no row restates loop state"
(`packages/harness/AGENTS.md`, "Run loop architecture"). `response.ready`
and `results.ready` do restate it. Nothing else commits them, so the run
state can set `at` when it applies the row that implies it. #14894 removed
the position's constant `family` field. It did not touch these two values.

**A derived encoding of the cursor.** `RunLoopPhase` (`shared/session/runState.ts:99-126`)
maps the six positions onto five phases through `PHASE_AT` and
`phaseAfter`.

- Code reads only `waiting`, `turn.ended` and null. A grep for `\.phase\b`
  finds `forkRun.ts:64`, `:121`; `runLoop.ts:157`, `:302`, `:410`;
  `loop/step.ts:273`; and `loop/runProgram.ts:102`, `:125`.
- Where it is read, it is read together with `at`. The test
  `(phase === 'waiting' || phase === 'turn.ended') && at !== 'turn.ready'`
  (`runLoop.ts:409-411`, again at `forkRun.ts:64-66`) is `at` in
  `{'waiting', 'turn.end'}`, spelled through both encodings.

**Predicates in control flow.** The turn loop decides its next step from
about fifteen reads of other fields, each in its own branch:

- `runTurn` (`runLoop.ts:297-401`) reads:
  - `pendingResponse` (`:315`) and `handedDown` (`:326`);
  - `at === 'response.ready' && invocation === null`, with the last
    message's role (`:329-333`);
  - `invocation === null`, with the tail's role (`:346`);
  - `offeredContext === null` (`:366`) and `forceFinalTool` (`:381`).
- `afterTextResponse` (`:107-139`) reads `finalToolTurn`, `structured` and
  `answerFinalized`.
- `loopBody` (`:404-501`) reads:
  - `phase` and `at` (`:409-411`), `lastError` (`:414`) and `isResuming`
    (`:424`);
  - `stopAfterCycle` (`:434`, `:470`, `:498`);
  - whether the run is a child (`:420`, `:428`, `:479`).

The per-call program does the same inline. `finishCall`
(`loop/toolUseDispatch.ts:335-603`) decides keep, derive, skip or run at
`:350-383`, and the script door's finalizer decides its own skip at
`:673-707`.

**The precedent is the model invocation**, the one loop that already
decides from its rows:

- `ModelInvoker.invoke` (`ModelInvoker.ts:836-909`) is a loop over one
  pure, total function of its rows. `nextAttempt` (`shared/session/inFlight.ts:230-286`)
  answers one of six moves (`:202-213`), and `failedNext` (`:306-323`)
  records the move after a failure on the `failed` row.
- A resume continues the same series because the decision is a function of
  the same rows.
- Earlier audits list it as a good module
  ([row model](../../evidence/2026-11-05-design-red-flags/C-row-model.md),
  "Good modules in this area").

The turn loop and the per-call program, whose two files took 20 of this
month's fix commits, still decide by control flow.

### What the peers do

**pi stores the step itself:**

- A generation task's checkpoint is one union of seven phases
  (`pi:packages/durable/src/harness/generation.ts:71-138`): `prepare`,
  `request`, `retry`, `poll`, `tools`, `finish` and `drain`.
- Its handlers are one table. Each returns its successor in the commit that
  ends it (`:175-396`).
- A crash resumes into the stored phase. An in-flight `request` with
  `restarts` set is charged as a failed attempt, never re-sent
  (`:269-273`).
- A tool task has two phases, `call` and `execute`. `execute` is reached
  only by recovery (`pi:packages/durable/src/harness/tool.ts:85-88`,
  `:148-228`).

**dsh keeps its phase in memory and does not resume a turn mid-way:**

- The phase is a field of the agent object
  (`dsh:packages/core/agent-loop/src/agent.ts:115`, `:161-168`).
- On open, `repair.ts` closes the open turn with synthetic `tool/result`
  rows (`TOOL_NOT_STARTED`, `TOOL_OUTCOME_UNKNOWN`) and an interrupted
  `turn/end` (`dsh:packages/core/session/src/repair.ts:15-29`).

TeXRA resumes both mid-turn and mid-call, which neither peer does. That is
why its decisions must be functions of its rows, as the invocation's
already is.

### The design

**Step 1 (stored shape, with the storage batch).**

- `response.ready` and `results.ready` leave `PositionAtSchema`. The
  `model.message` handler (`shared/session/turnRowHandlers.ts`) sets `at`
  when it applies a `response` row or a delivering `append`.
- The view needs neither value. It sets `ready` from a run's start and its
  `run.end` (`shared/session/sessionViewUpdate.ts:335`,
  `shared/session/runRowReads.ts:273`), `waiting` from `at === 'waiting'`
  (`:269`), and `running` otherwise.
- `RunLoopPhase`, `PHASE_AT` and `phaseAfter` go. Readers read `at`. A run
  is open once its first position is applied, as `requires: 'opened'`
  checks today.
- `run.position` takes a version bump.

In the golden store this removes 41 of the 123 position rows.

**Step 2 (no stored change).** The turn loop's next move becomes one pure,
total function of the run state and the few facts outside it: whether input
is queued, and the run's kind and policy (finding 4's role). It is the
shape of `nextAttempt`. Sketch, illustrative:

```ts
type TurnMove =
  | { kind: 'dispatch' } // a pending response's calls
  | { kind: 'textPolicy'; text: string } // a committed text-only answer
  | { kind: 'deliverQueued' } // input queued at the request
  | { kind: 'compact' }
  | { kind: 'invoke'; forced: boolean }
  | { kind: 'endTurn'; outcome: RunOutcome }
  | { kind: 'wait' }
  | { kind: 'end'; outcome: RunOutcome };
declare function nextTurnMove(
  state: RunState,
  queued: boolean,
  role: RunRole,
): TurnMove;
```

- The loop becomes `for (;;) switch (nextTurnMove(...))`, each case one
  effect and one append.
- The resume rules become rows of a table a test can enumerate: what the
  run does next after each stored position, with or without queued input,
  for each role.
- The per-call program gets the same treatment. `callMove(status, fact,
  recovered, replayable)` returns keep, derive, skip (with its reason) or
  run (with its attempt). `finishCall` and the script door's finalizer
  share it.

This is not a flow engine:

- no node, cursor or services bag is added;
- the moves are not stored;
- the program stays one Effect program over the run's rows.

It is the rule the harness already follows for the invocation, applied to
the other two loops.

**What goes:**

- Step 1: two position values, three types or tables (about 40 lines), and
  a third of the stored positions.
- Step 2: the duplicated `parked`/`begins` predicates of `runTurn` and
  `loopBody`, and the inline decisions of `finishCall` and the finalizer.

Step 2's line count is roughly even. The gain is that each resume rule is
decided in one place a test can enumerate.

**Risks:**

- Step 1 changes what a position row says. A host that reads
  `RunView.position` or the listing's position must still see `running`
  between `turn.begin` and `turn.end`, and it does: only `waiting` is
  distinguished.
- Step 2 touches the two files with the most fixes. It lands alone, after
  step 1 and finding 4's role. Its gate is the crash-point suite and the
  golden store, with no behavior change.

## 2. A child's result is typed, rendered to XML and parsed back

### What the code does

A child's end builds the envelope its parent's model reads, from the
child's typed facts:

- `formatDelivery` (`agent/runtime/deliveryEnvelope.ts:66`) is called from
  13 sites:
  - in the harness: `subagentResults.ts:94`, `:120`;
    `delegation/bashDelivery.ts:118`, `:134`; `leftoverChildren.ts:63`; and
    `scriptRun.ts:247`, `:262`, `:289`;
  - in the app: `tools/agentCli/claudeAgent.ts:366`, `:377`;
    `codex.ts:352`, `:362`; and `agentCliShared.ts:269`.
- The parent's `followup.queued` row holds only that text.
  `FollowUpContentSchema` has `text`, `displayText`, `media` and `from`
  (`shared/schemas/followUp.ts:59-68`), and `batchMessage` sends the text
  as it is (`agent/runtime/FollowUps.ts:125-132`).

Every surface that shows the result recovers its facts from the text, with
regular expressions over the delivery tags (`shared/subagentFollowup.ts`,
336 lines):

- `queuedRow` summarizes the envelope into `displayText` as it queues it
  (`agent/followUp/followUpMessages.ts:83`).
- `followUpDisplay` re-parses a script's summary from the text (`:45-52`).
  The script wrote that summary as JSON inside an XML element
  (`shared/subagentFollowup.ts:185-189`).
- The `agent` tool's card extracts the answer from the result text
  (`shared/transcript/toolRowSections.ts:378-381`, `deliveredResponse`),
  and so does the script stage (`shared/transcript/scriptStage.ts`).

The answer the card parses out sits typed on the same result:

- An awaited child's call returns the child's `RunEndOutput` (whose
  `response` field is the answer, `shared/schemas/runRecords.ts:94-102`)
  on the result's `value`.
- It also formats the envelope a second time (`agent/runtime/delegation/AgentTool.ts:249-286`).
  That second formatting leaves out the wall time, the working directory
  and the memory misses the child's own end passes
  (`agent/runtime/childDelivery.ts:57-91`), which stored the envelope as
  the run's `run.report`.

### Already designed, and marked landed in error

Round 1's area A found this as A7 and designed the fix: "The envelope's
typed facts (`ScriptDeliverySummary`, `ResultMeta`) travel on the row ...
and the XML is rendered once at the point the row becomes a model message
(`FollowUps.batchMessage`) ... `summarizeSubagentFollowup` and
`parseScriptDeliverySummary` then read the typed row"
([A-child-runs](../../evidence/2026-11-05-design-red-flags/A-child-runs.md),
finding 7; [root designs](./2026-11-05-root-designs-effect-native.md),
R5).

The catalogue marks A7 "landed (#14769, R5; one delivery id #14788)". Only
the id half landed (one delivery id, assigned once). The typed half did
not: no row carries the facts, and both parsers still read the text. This
note takes the rest of A7 as written, and the catalogue's A7 row should say
its second half is open.

**What goes:**

- The summarizing and re-parsing paths of `shared/subagentFollowup.ts`.
  The module keeps `hasIncompleteEmbeddedSubagentFollowup` and
  `summarizeEmbeddedSubagentFollowups`, which hide an envelope a model
  echoes inside its own streamed answer. They do not depend on how a
  delivery is stored.
- `scriptSummaryElement` and its parse.
- `deliveredResponse`'s tag matching. The card reads the result's `value`.
- `childResult`'s second formatting. The awaited call answers with the
  child's stored report.

`followup.queued` takes a version bump.

**Risk.** A plugin's child (the agent CLIs in `packages/texra`) writes its
own envelope today. It would pass the same typed delivery, and the harness
would render it. The XML the model reads does not change, so no prompt
changes.

## 3. A run's life is a state machine spread over seven collections

### What the code does

`RunRegistry` (`agent/runtime/runRegistry.ts:124-152`) keeps each run's
state as membership in seven collections:

- `live` (the fiber) and `controls`;
- `starting` (`{ stop, settled }`), `stopping` and `stoppedBeforeStart`;
- `stopped` and `busy`;
- plus two flags, `disposed` and `closing`.

A run's state is the combination of the collections it is in:

- `heldIds` and `liveRun` rebuild a view of a run out of three of them
  (`:175-201`).
- `stop`, `stopHeld` and `stopEnded` each re-check that combination
  (`:483`, `:527`, `:555`).

Beside it, the session already holds a `FiberMap<RunId>` of the same
fibers (`controllers/session/sessionOwners.ts:156`), which the registry
forks into (`:243-245`, `:256`).

The public door `Runs` has two members. Harness internals reach the
registry's other public methods through an unchecked cast, `registryOf`,
at 11 sites in 9 files (`grep -rn "registryOf("`). One member is dead:
`programs` (`runRegistry.ts:155-161`) is assigned and never read. Its
`executeAgent` (`:104`) is passed in at `sessionOwners.ts:257` and never
called. These collections are where a stop, a start and a resume meet, and
that area (stop, resume and ownership) took 24 of this month's fixes.

One consequence was reproduced with finding 4 (a)'s throwaway case. A resume
sent as soon as `run.result` resolved, which happens once the view shows the
stored end, found the ended run still held in `live` (its fiber's observer
had not run yet). It was answered as a join of "the activation it runs"
(`joinOpening`, `agent/runtime/resumeRun.ts:168-200`): the call succeeded,
returned the old activation's handle, whose result is the stored end, and
wrote nothing. A caller that resumes right after an end gets a silent no-op.
The stored `run.end` and the registry's `live` map are two answers to "does
this run still run here", and they disagree for a moment that a caller can
hit.

### What the peers do

Both hold a unit's state as one value:

- pi's task record carries one `state` union of six statuses: `pending`,
  `running`, `waiting`, `sleeping`, `completing` and `terminal`
  (`pi:packages/durable/src/types.ts:660-702`).
- dsh's agent carries one `Phase` union: `idle`, `maintenance` or `running`
  (`dsh:packages/core/agent-loop/src/agent.ts:53-61`).

### The design

The registry's per-run state becomes one value:

```ts
// illustrative
type RunEntry =
  | { kind: 'pending'; stop: RunStopReason } // a stop before any row
  | { kind: 'opening'; stop: RunStopReason | null; settled: Deferred<void> }
  | {
      kind: 'live';
      fiber: AnyFiber;
      controls?: RunControls;
      stopping: boolean;
      stopped: boolean;
    }
  | { kind: 'busy'; done: Deferred<void> };
```

- It lives in one `Map<RunId, RunEntry>`, and each method is a `switch` on
  the entry.
- `closing` and `disposed` become one session state.
- An internal `RunRegistry` service tag replaces the `registryOf` cast. The
  public `Runs` stays two members.
- The dead `programs` member goes.
- A `live` entry whose run's end is stored answers a resume as ended, not as
  a join, so the no-op above cannot happen.

A design with stops only in rows does not work. `stopRun` cannot write a
row for an id that has none yet (`agent/storage/runLifecycle.ts:356`), so
the `pending` state is real.

**What goes:** five collections, `heldIds`, the rebuild in `liveRun`,
`stopEnded` and the 11 casts. That is about 80 lines, measured by the area
reader, not by an implementation.

**Risk:** the stop-during-open orderings the isolation suites pin. This
lands with no behavior change other than the join, after #14893, which
moves the registry's parent edges onto store reads and changes the same
file.

## 4. What kind of run this is, and its launch, decided at many sites

**(a) "Does this run take input" has two owners.**

- `run.start.takesFollowUps` is stamped once, at registration.
- Each resume's caller decides `stopAfterCycle` again through
  `ResumeInput.interactive` (`effect/sessionPrograms.ts:226`:
  `stopAfterCycle: interactive !== true`; `agent/runtime/resumeRun.ts:248-262`).
- `submitFollowUp` refuses every message to a run whose `takesFollowUps`
  is false, as the view reads it (`agent/followUp/ToolUseFollowUp.ts:194-197`).

**Reproduced** with a throwaway case over the test kernel (the validation
model, a persistent session; not committed), started with no `interactive`
and resumed with `interactive: true` after its first activation ended
`completed`:

- The resume succeeds. It writes `run.activate`, `run.config` and
  `run.position waiting`, and the view shows the run waiting with `stop` and
  `compact` among its actions, `outcome` null and `takesFollowUps` false.
- A `followUp.send` to it fails `Unavailable`: "This run cannot accept
  messages right now. Resume it, or start a new agent task."
  (`agent/followUp/ToolUseFollowUp.ts:86-87`). The run was just resumed.
- The run's input reader opens anyway (`agent/followUp/Inbox.ts:127-141`),
  so it waits for input nothing may send, until it is stopped.

The CLI avoids this by restating the rule twice ("a run launched to run once
reads no messages", `packages/cli/src/chat/chatSessionController.ts:579-590`,
`packages/cli/src/commands/resumeRun.ts:159-162`), and continues the chat
as a fork. The run's kind is also recombined by its other readers:
`stopAfterCycle` is read on 23 lines in 11 files and `takesFollowUps` on 17
lines in 11 files.

This is the case #14893 leaves to the owner, from the other side. #14893
asks whether a message to an ended one-shot root is refused always or
accepted when no launch holds the run. The reproduction adds that a resume
can put such a run into a wait the refusal then makes permanent. Whichever
rule the owner picks, the resume must apply the same rule.

**Design.** `interactive` cannot simply go. An interactive run resumed by a
headless caller (`texra resume`) must still run one cycle and exit, so the
caller's presence is a real input. What is wrong is that the two facts are
combined by each caller. They should be combined once, where the resume
reads the run's rows (`openResume`, `agent/runtime/resumeRun.ts:211-263`):
a run waits for input only if its rows say it takes input and its caller
is present. With #14893's "refuse always", a one-shot run is never resumed
into a wait, and a send to it is refused with its real reason (it was
launched to run once; fork it), not with "Resume it". The fix is one line
of decision and one refusal wording, with one regression test written to
fail first.

The wider direction is one `RunRole` (root, awaited child, background
child, process child), derived once from the run's `run.start` and
activation rows, so that one module answers what each reader asks today:

- does it take a later turn;
- does it count against the budget;
- does its end deliver to a parent;
- does it read input when it waits.

**(b) The registration is built before the model binds and committed after
it.**

- `enterRun` builds the registration rows (`agent/runtime/executeAgent.ts:94-102`)
  before the binding exists (`:308-318`).
- The opening batch then writes a second `run.config` that adds only the
  binding (`runLoop.ts:243`). A forked child writes a third (`forkRun.ts:321-323`,
  `runLoop.ts:174`).
- In the golden store on `main`, 14 of 18 runs write two `run.config` rows
  and 2 write three. In 15 of the 18 consecutive pairs the second row
  repeats the same `config` and adds `binding`.
- The repeats are 15,133 of the 32,228 bytes the store spends on
  `run.config`.

**Design.** `enterRun` returns the registration's options. `openToolUse`
builds the rows once the binding is known, as one `run.config`.

**(c) Two terminals.** A native run ends through `endRun`, which fails a
run whose rows the store refused unless a stop ended it
(`agent/runtime/AgentRunLifecycle.ts:148-153`, `log.lost`). `log.lost` is
the first published display row the store refused
(`shared/session/sessionLog.ts:61-66`), and a process child's
`process.output` rows are such rows. A process child ends through
`runProcessChild` (`agent/runtime/processRun.ts:98-164`), which builds its
end from its own verdict and does not ask `log.lost`. As read (not
reproduced), a process run whose output rows the store refused ends with
its own verdict where a native run in the same state ends failed.

**Design.** Each program keeps its own verdict. One shared end commits it:
the lost-rows check, the log, `endRunRows`, and re-raising an interrupt. If
the asymmetry reproduces, it is a defect and its fix gets one regression
test, written to fail first.

## 5. Which grant answers a request has two tables that disagree

### What the code does

A request to a person is approved by a grant (an "approve all" the run
holds) through two tables, one at open and one while it waits:

- **At open**, the guard and the door read the policy through `OPERATIONS`
  (`agent/runtime/loop/toolGuard.ts:75-81`). A plan, and a call of a tool
  with no command grant, are answered by the delegated-work grant
  `superYolo`. So a plan approval is approved at open while `superYolo` is
  on (`answerFor`, `agent/runtime/requests.ts:148-151`).
- **While it waits**, a grant turned on answers it through `GRANT_OF` and
  `offeredGrant` (`shared/schemas/request.ts:209-249`). `GRANT_OF` has no
  `planApproval`: "a plan approval ... need[s] an answer". A command prompt
  for a non-shell tool opens with `offersGrant: false`
  (`agent/runtime/loop/commandApproval.ts:50`).

So `superYolo` approves a plan, or a non-shell command, when it was on
before the request opened, and does not when it is turned on while the
request waits. The two tables disagree, and each comment states its own
rule as the rule.

The grant a waiting request offers is also written by each opener, by its
own rule. Five writers set `offersGrant`:

- `ask.grant === 'bash'` (`agent/runtime/loop/commandApproval.ts:50`);
- `hook !== 'ask'` (`tools/approval/toolEditApproval.ts:121`,
  `agent/runtime/delegation/proposalFlow.ts:191`,
  `agent/runtime/delegation/AgentTool.ts:228`);
- `false` on a kind `GRANT_OF` never reads
  (`packages/texra/src/tools/userQuestion/UserQuestionTool.ts:59`).

The one open door has one caller. `openRequest` is called only from the
guard's `CallRequests.open` (`agent/runtime/loop/toolGuard.ts:364`), and
three askers go around it:

- the model retry builds its own `request.opened` and policy rows
  (`agent/runtime/ModelInvoker.ts:614-634`) and waits with its own tail
  (`:774-797`);
- a script's shared agent request does its own lookup and wait on re-entry
  (`agent/runtime/delegation/AgentTool.ts:205-221`);
- a plugin's non-blocking request builds its row in the guard
  (`toolGuard.ts:386-400`).

`request.opened` is built at three sites (`requests.ts:393`,
`ModelInvoker.ts:627`, `toolGuard.ts:390`). `decisionOf` is waited on at
three run-side sites (`requests.ts:405`, `ModelInvoker.ts:779`,
`AgentTool.ts:210`).

**A plugin request's answer commits its effects before its decision.** For
a plugin's request, the decide path first runs the plugin's record: its
facts in a transaction of their own and a follow-up to the run through the
inbox. Only then does it write `request.decided` (`controllers/session/SessionRequests.ts:212-232`).
A decision is not durable before its effects. An area pass found by
reading, not reproduced, that a run end landing in between gives the run
the answer while the surface is told "No pending request". The inquiry
plugin carries a re-delivery branch to cope with it
(`packages/texra/src/tools/inquiry/inquiryActions.ts`).

### Already designed, and marked landed in part

R7 ([root designs](./2026-11-05-root-designs-effect-native.md), "R7. A
question to a person is a row of the run") designed this module:

- `openRequest(cell, payload, beside?)` for every asker, with the
  invoker's `failed` row passed as `beside`;
- `decideRequest` as the one checked append;
- the request row carries `answeredBy: 'person' | ApprovalBypassKind`;
- the three tail waiters go.

The catalogue marks R7, and the B5 and E2 rows it closes, "landed
(#14769)". Its lanes and `approvePendingUnderBypass` are gone. Its door for
every asker, `answeredBy` (no such field in `packages/*/src`) and its one
waiter are not in the tree. This note takes R7's rest as written.

### What the peers do

Neither has grants that answer a waiting request, so there is no peer shape
to copy. dsh's approval is a one-shot call through answerer listeners,
withdrawn when its step aborts and not durable
(`dsh:packages/interaction/user-approval/README.md`). pi has no approval.
TeXRA's requests are rows with derived ids, so a resumed call rejoins its
request, which is worth keeping.

### The design

R7's rest:

- `request.opened` carries `answeredBy`, decided once at open from the
  operation and the hook's answer, with `OPERATIONS` moved there. The
  answer at open and the grant sweep read the same field, so the two
  tables become one.
- The invoker and the script's shared request open through `openRequest`
  and wait on one waiter.
- A plugin request's decision, its facts and its follow-up commit in one
  checked transaction, then the run is woken. `endIn` already commits a
  child's report this way (`agent/storage/runLifecycle.ts:219-251`).

**What goes:** `GRANT_OF`, `offeredGrant`'s two conditions, `grantAnswers`,
the five `offersGrant` writers, the invoker's `awaitDecision`, the script's
private wait, and `SessionRequests`' `decisionLanes` with its lane.

**Risk:** `request.opened` takes a version bump, so it goes in the storage
batch. A request a hook asked about writes `answeredBy: 'person'`. The
inquiry's cross-project record cannot join the transaction, so it stays an
idempotent step before it.

## 6. Smaller

**A provider's facts in eight files.**

- Adding an API-key provider touches the seven places `packages/harness/AGENTS.md`
  lists ("Agent execution"): eight production files in three packages.
- O9 found it, and its first half landed (#14876). #14894 made a stored
  `binding.backend` a string, so removing a provider bumps no row version.
- What is left:
  - The stored list `MODEL_PROVIDERS` (`shared/schemas/runInput.ts:32-43`)
    stays the writer's closed list, as a checked copy.
  - The endpoint and region rows (`shared/state/providerSettings.ts`) are
    still written by hand, where `EndpointProviderId` and
    `providerDisplayName` already decide them.
  - The manifest's rows are still told apart by which optional fields are
    present.
- pi-ai's shape is the target. A provider is one value,
  `createProvider({ id, name, baseUrl, auth, models, api })`
  (`pi:packages/ai/src/providers/deepseek.ts`, 15 lines). Its quirks are one
  compat object of about thirty flags
  (`pi:packages/ai/src/providers/compat-schema.ts:196-372`), the role
  TeXRA's `RESPONSES_ROUTES` row plays.

**The lane rule written twice.**

- The response's calls are partitioned into lane groups up front
  (`groupsOf`, `loop/toolUseDispatch.ts:845-856`).
- A script's calls take their lanes as they arrive (`inLane`, `:647-672`),
  over three maps of `Deferred`s, a `Semaphore` and a `FiberMap`.
- Replacing the maps with a `Semaphore` stays refused
  (`DISPATCH-script-lanes-semaphore`).
- Another design gives the response's calls the same online lanes as a
  script's, so one scheduler serves both. It deletes `groupsOf` and the two
  `forEach` passes.

It is recorded here and not proposed: the response path would gain the
script path's `Deferred` bookkeeping for no behavior change.

## What the peers do that is still not taken

Round 1's refusals stand: a task scheduler, an event bus with ordered
listeners, YAML composition, documents as a second state owner, and JSONL.
The peers' newest changes add evidence on two points:

- **pi's deferred commits** (`pi:packages/durable/CHANGELOG.md:70`) store
  partial answers and tool progress later than they are shown. TeXRA stores
  none of these: chunks are transient on the live trace.
- **pi retries in two layers.**
  - pi-ai retries a provider request itself
    (`pi:packages/ai/src/utils/provider-retry.ts`), called with the SDK's
    own retries off (`pi:packages/ai/src/api/openai-completions.ts:382-387`).
  - The generation task then retries again under its own policy.

  TeXRA has a single owner: the invoker over its rows, under the process's
  route gate, with provider SDK retries off. That is the better shape and
  stays.

## What is good and stays

- **`nextAttempt` and `failedNext`** (`shared/session/inFlight.ts`): the
  retry loop as a pure function of its rows. Finding 1 extends this shape.
- **The row codec and `ROW_KINDS`** (`shared/schemas/rowVersions.ts`): one
  version per kind and a whole-store gate. Because of them, a stored-shape
  change is cheap before the freeze.
- **The llm failure path:**
  - `ModelError` has six kinds, with `retryable`, `scope`, `retryAfterMs`
    and `quota` (`packages/llm/src/errors.ts:67-127`).
  - One judge reads the vendor's reply (`judgeFailure` and `judgedModel`,
    `packages/llm/src/api/verdict.ts:337`, `:368`).
  - The harness copies the verdict onto its row without classifying it
    again (`modelFailureOf`, `common/errors/sdkError/providerErrorFormat.ts`).
- **The `Model` interface** (`packages/llm/src/turn.ts:489-521`):
  `prepareTurn`, `streamTurn`, optional `uploadFile` and `background`, and
  three event kinds.
- **Durable requests with derived ids**, which neither peer has: a resumed
  call rejoins the request its attempt left standing.
- **The doors:** one launch door (`RunRegistry.start`), one end transaction
  (`endIn`), one publisher, and resume as the same program over the same
  rows.

## Still open

- **Finding 6**, as written above, when the next provider is added.
- **The `takesFollowUps` owner question (#14893).** 4 (a) never resumes a
  run launched to run once into a wait, and words the refusal of a send to
  it as having run once. The send check still reads `takesFollowUps` from
  the view, as #14893 left it, so it skips a run the view has not loaded.
  Whichever rule the owner picks, `openResume` and the refusal change
  together.
- **Found while landing, not fixed here.**
  - **A deletion can outlive its process.** `texra history delete` can
    exit before its session collects the deletion, and the golden
    generator's `--twice` fails for the same reason. The measurements and
    the constraint on a fix are recorded once, in
    [the session surfaces audit](../simplification/2026-11-10-session-surfaces-ad-hoc.md)
    ("`history delete` 的回收是异步的，golden 的生成因此不确定").
  - **Two answers to one inquiry at once** can leave the thread's record
    and the decided row naming different answers, now that `decisionLanes`
    is gone. The run is told what the thread says.
  - **A resume between a result that ends its turn and that turn's end**
    (`submit_output`'s `endTurn`, after its delivering `append` and before
    `turn.end`) calls the model once more. This was read while measuring
    step 2 and not reproduced.

## Verified

- **Golden store counts.**
  - Every `INSERT INTO event VALUES(...)` line of
    `src/test-kernel/fixtures/storage/golden-1.0.sql` was parsed with Node,
    and its `data` column decoded as JSON, at `8281784` (806 rows) and
    again at `521bb189` (749 rows, after #14894).
  - Display kinds are the `TRACE_ROW_TYPES` list (`shared/schemas/sessionEvent.ts`)
    plus `response.finalized`.
  - Position rows are classified by the row before them, in `seq` order on
    their aggregate. The classification is the same at both commits.
  - `run.config` pairs are compared by their `config` object. The counts
    are the same at both commits.
  - The read volume in "Since this note's base" was measured at `8281784`:
    the `data` bytes of the kinds each read would select.
- **Readers of row kinds.** Each kind's literal was searched in
  `shared/session/runState.ts`, `turnRowHandlers.ts`, `runRows.ts`,
  `sessionViewUpdate.ts`, `transcriptUpdate.ts`, `runRowReads.ts` and
  `controllers/session/projections.ts`.
- **Fix counts.** `node scripts/report-fix-churn.mjs` ran on a history
  fetched to 1,604 commits. Per-file counts came from
  `git log --since='30 days ago'`, following the rename of `toolUse.ts`.
- **Findings 3 to 5.** These came from read-only area passes over the
  lifecycle, child, catalog and request modules. Each claim used here was
  then checked in the tree:
  - for finding 3: the collections and flags (`runRegistry.ts:124-152`),
    the `registryOf` count, the unused `programs` and the `FiberMap` in
    `sessionOwners.ts`;
  - for finding 4: the resume's `interactive`, the follow-up refusal, the
    two CLI guards, the missing `log.lost` in `processRun.ts` and the two
    counts in (a);
  - for findings 2 and 5: `childResult`'s second formatting, the two grant
    tables, the five `offersGrant` writers, `openRequest`'s one caller, the
    three `request.opened` builders, the three run-side waiters, the absent
    `answeredBy` and the plugin answer's write order.

  Line references were re-checked after merging `main` at `521bb189`.

- **Reproduced.** Finding 4 (a), and the join after an end in finding 3,
  with a throwaway vitest case beside `src/test-kernel/agent/runtime/resumeRun.vitest.ts`
  (its `texraHosted` and `validationHost` setup, the validation model, a
  persistent session), run at `8281784`, deleted after the run and not
  committed.
- **Peers.** Read at the pinned commits:
  - pi: `generation.ts`, `tool.ts`, `codemode/codemode.ts`, `types.ts`,
    `CHANGELOG.md` and `README.md:894`;
  - pi-ai: the providers and the compat schema;
  - dsh: `agent-loop/src/agent.ts`, `core/tools/src`,
    `core/session/src/repair.ts`, `known-event-types.ts` and
    `interaction/user-approval`.

  No peer was built or run.

- **The implementation.**
  - At each finding and at the branch head: the type check in its three
    parts (the whole of `npm run typecheck` is killed for memory here),
    `npm run lint`, `gate:invariants`, `gate:docs`, `format:check`, and the
    suites the change reaches (`vitest --changed`).
  - At the head: `npm test`, 254 files and 576 tests with 1 skipped, the
    crash project's 7 files and 9 tests among them.
  - The golden store was regenerated after each merge. Three generations
    at the head agree; a generation that differs is the deletion race
    above.
  - The deletion race was measured with a script that runs
    `texra run golden_child` and then `texra history delete` on a fresh
    store and reads whether the run's sequence row is gone. It is not
    committed.
  - Line counts are `git diff --shortstat` over each finding's commits.
- **Not measured or not reproduced (in the design).** The line counts of
  each design are estimates and are marked as such. 4 (c) is read from the code: it needs a
  background process child whose output rows the store refuses. Finding 5's
  end-and-answer interleaving, and the window between the open's policy
  answer and its commit, are read from the code.
