---
created: 2026-11-10
status: proposed
---

# The harness against pi-durable and DeepSeek Harness, round 2: what is still ad hoc

Measured on 2026-11-10 at TeXRA `8281784` (main), pi
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
earlier round recorded, or what the catalogue marks landed while the tree
says otherwise.

## Summary

The core is sound:

- every resumable fact is a row;
- the model invocation's retry is a pure function of its rows
  (`nextAttempt`);
- one publisher commits in order, and a claim owns each run;
- the llm `Model` is a deep door with four members.

What is still ad hoc sits beside the core. In each case one fact has two
owners, and each sits behind a cluster of this month's fixes.

| #   | Finding                                                                                                                                                                     | Red flag (Ousterhout)                                               | What goes                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **One conversation, two records.** Each tool call, model answer and user message is written as history rows the run resumes from and again as display rows the hosts render | repetition, information leakage, a join by adjacency                | the loop's card rows, `settleCards`, the batch rule of `DISPLAY_PAGE_END`, `response.finalized` with `answerFinalized`, the model streams' end rows, the user-message `log`  |
| 2   | **Where the loop stands, three ways.** A stored `run.position`, a derived `RunLoopPhase`, and about fifteen predicates in the turn loop and the per-call program            | two representations, a stored cursor, nonobvious code               | the `response.ready` and `results.ready` positions, `RunLoopPhase`, `PHASE_AT`, `phaseAfter`; then the branch predicates, for one pure next-move function like `nextAttempt` |
| 3   | **A child's result is typed, rendered to XML and parsed back,** and an awaited child's is formatted twice                                                                   | information leakage, format then parse, repetition                  | most of `shared/subagentFollowup.ts` (336 lines), the re-parse in `queuedRow` and `followUpDisplay`, the JSON-in-XML script summary, the second formatter in `AgentTool`     |
| 4   | **A run's life is a state machine spread over seven collections,** with a second map of the same fibers and a cast to reach it                                              | state in maps and flags, two representations, overexposure via cast | five of the seven collections, `heldIds`, `stopEnded`, the dead `programs` member, the 11 `registryOf` casts                                                                 |
| 5   | **What kind of run this is, and its launch, decided at many sites:** two owners of "takes input", `run.config` written twice per launch, two terminals                      | two representations, temporal decomposition, repetition             | `ResumeInput.interactive`, the CLI's two restated guards, one `run.config` per launch (47% of its stored bytes), the process child's own end                                 |
| 6   | Smaller: a provider's facts in eight files (the rest of O9); the lane rule written twice                                                                                    | change amplification                                                | the endpoint and region rows written by hand; the sentinel manifest rows                                                                                                     |

Findings 1, 2, 3 and 5 change stored shapes. Their stored parts land
together before the storage freeze, with one golden-store regeneration, as
round 3's storage batch did ("Order", below).

## What picks the targets

**Fixes this month.** `npm run report:fix-churn` (`scripts/report-fix-churn.mjs`)
over the 30 days to `8281784` counts 159 fix commits:

- 63 scoped `harness` and 8 scoped `llm`.
- Two areas are over the script's line of ten, where an area's rulings are
  to be revisited: stop, resume and ownership (24), and model, retry and
  route (23).

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

#14638 ("an answer the model could not finish says so") is a display fact
the loop writes: `response.finalized.cut`.

**What a run stores.** The golden store (`src/test-kernel/fixtures/storage/golden-1.0.sql`)
is what the CLI writes for 18 runs: 806 `event` rows. Counted by `type`
(the method is under "Verified"):

| Rows                                                | Count | Share |
| --------------------------------------------------- | ----: | ----: |
| history (the run state reads them)                  |   609 |   76% |
| display (only hosts read them)                      |   197 |   24% |
| display rows that restate a history row (finding 1) |   124 |   15% |
| `run.position` (finding 2)                          |   123 |   15% |
| `run.config` (finding 5)                            |    36 |  4.5% |

## 1. One conversation, two records

### What the code does

A run commits its history through its cell: `model.message` (`attempt`,
`response`, `append`), `tool.intent`, `script.call`, `tool.result` and
`hook.outcome`. Beside those rows the loop writes display rows that say the
same things again for the hosts:

- **Each tool call's card.** `cardRows` (`agent/runtime/loop/toolUseDispatch.ts:305-346`)
  writes two rows:
  - `tool.start`, with the tool name, the input the body ran on, the tool's
    declared `card`, `section` and `attempt`;
  - `tool.end`, with the status and edited files.

  A slow tool's card opens with its `tool.intent` (`:484-501`). A fast
  tool's opens and closes with its `tool.result` (`:604-644`). A skipped
  call closes its card in `skipCall` (`:350-370`).

- **Each model answer's text.** The invoker opens two trace streams per
  attempt (`agent/runtime/ModelInvoker.ts:260-263`). They commit
  `stream.start` and, at the end, `stream.end` with the whole `finalText`
  (`agent/trace/TraceEmitter.ts:156-161`, `:262-278`). The same text is in
  the `response` row committed a few lines later (`ModelInvoker.ts:360-374`).
- **The answer shown as final.** `afterTextResponse` writes
  `response.finalized` with the turn's text and its `cut`
  (`agent/runtime/loop/runLoop.ts:126-127`, `loop/rows.ts:40-53`). The cut
  is the `response` row's finish reason, and the text is that row's text.
  The run state then records `answerFinalized` (`shared/session/runState.ts:399-402`)
  so that the loop writes the display row only once. A display fact is
  tracked by the run state.
- **The user's message.** `logUserMessage` writes a `log` row with the
  message's text (`agent/trace/traceLogs.ts:141-163`, called at
  `runLoop.ts:219-223`). The text is in the opening `append`.

The readers never meet the history rows directly:

- Of the 37 row kinds, the session view update (`shared/session/sessionViewUpdate.ts`)
  and the transcript update (`shared/session/transcriptUpdate.ts`) name
  none of `model.message`, `tool.intent`, `tool.result`, `script.call`,
  `context.edit`, `tools.offered`, `context.blob` or `hook.outcome`.
- The one history row a card needs, its `tool.result`, reaches the
  transcript glued onto the card's `tool.end` at read time.
  `settleCards` (`controllers/session/rowReader.ts:363-398`) takes "the
  `tool.result` committed just before it in the same batch".
- That join by adjacency then constrains the store. A display page must not
  split a batch, so `DISPLAY_PAGE_END` (`controllers/session/databaseLayer.ts:149-165`)
  ends a page where the row's `at` changes. Its comment gives the reason:
  "a card's `tool.end` and the settlement it projects from share one batch
  (`settleCards`) and a batch's rows share one `at`".

The store review proposed storing a batch column (F3 in
[the session store review](./2026-11-03-session-store-review.md)). That
treats the symptom. The cause is the second record.

In the golden store, 124 display rows restate a history row:

- the 16 `stream.end` rows, each of whose `finalText` equals a `response`
  row's text or reasoning in the same run, with their 16 `stream.start`
  rows;
- the 16 `response.finalized` rows, each equal to a `response` row's text;
- 29 of the 31 `tool.start` rows, which name a call a `response`,
  `handed-down` or `script.call` row records, with their 28 `tool.end`
  rows (the other two cards are an agent CLI's own);
- the 19 user-message `log` rows, whose text is an `append`'s, a
  `run.config` instruction's, or a follow-up's `displayText`.

### Why it costs

- **Two representations of one fact**, against the harness's own invariants:
  "A fact is one row type", and transient observations "are never rows"
  ([core concepts](../../implemented/architecture/2026-09-26-core-concepts.md),
  invariants 2 and 9). A card's name, input, attempt and outcome each have
  a history row and a display row. The model's answer is stored three
  times: in `response`, `stream.end` and `response.finalized`.
- **Change amplification.** A new fact a card shows takes four edits: a
  write in the loop beside the history write, a row field, a row version
  and a handler in the transcript. #14638 (the cut answer) and #14591 (the
  stage a resumed script reopens) were fixes to display state that the loop
  maintains beside history.
- **Unknown unknowns.** The card's output depends on two rows staying
  adjacent in one batch, and the pager depends on a batch sharing one clock
  reading. Neither is visible where the rows are written.

### What the peers do

Both keep one record per fact and render from it:

- **dsh.** The session log holds `assistant/message`, `tool/call` and
  `tool/result` (`dsh:packages/core/session/src/known-event-types.ts:29`,
  `:76`, `:79`). A tool declares `presentCall` and `presentResult`
  (`dsh:packages/core/tools/src/contracts.ts:93`, `:101`), and the card is
  computed from the stored result on replay. In
  `dsh:packages/web/tool-web/src/search.ts:120-127`, the `tool/result`'s
  `meta` "is persisted with the session log, so `presentResult` reproduces
  the search card on replay".
- **pi.** 1.5.0 removed its event stream for renderers outright: "A renderer
  renders state instead of assembling it from events"
  (`pi:packages/durable/CHANGELOG.md:76`). Its in-flight presentation
  (partial answers, a tool slot's progress) lives in one document whose
  commits are deferred, and the entries are the transcript (`:70`, `:184`).

### The design

**Design A (chosen): the transcript is a projection of the history rows.**
The transcript update reads the rows the run state reads, and the loop
writes no display row for a fact a history row holds:

- **A call's card comes from its rows:**
  - Name and issued input come from the `response` row's call or the
    `script.call` row, whose `section` and issuing script give the card's
    section and stage.
  - The input the body ran on is a PreToolUse rewrite, stored in
    `hook.outcome.updatedInput` (`shared/schemas/hookOutcome.ts:55`).
  - The start and attempt come from `tool.intent`. The outcome, output and
    edited files come from `tool.result`.
  - One presentation fact has no history row: the tool's declared `card`,
    computed from the input the call ran on. It moves onto `tool.intent`,
    or onto `tool.result` for a call that never started. The browser has no
    tool definitions to compute it with, so it stays stored.
- **A model answer's entry** comes from its `attempt` row, which names the
  stream ids its live chunks use, and its `response` row, which closes them
  with its content and finish reason (the `cut`). Chunks stay transient on
  the live trace, as now.
- **The user's message** comes from the `append` and the `followup.*` rows
  that carry it.
- **Display rows remain** for facts no history row holds: `log` notices,
  `process.*` output, the cards an agent CLI's turn reports (`TraceEmitter`'s
  tool cards, `agent/trace/TraceEmitter.ts:165-215`), a plugin's stage,
  `context.state` and `usage`.

Rows arrive decoded, and the stored turn schema imports nothing from
`@texra-ai/llm` (`shared/schemas/storedTurn.ts:1-14`). The browser
transcript entry gains no dependency.

**Design B: keep the display rows, strip them to what history lacks.**
`tool.start` would carry only `{ logId, card }`, `stream.end` no text, and
`response.finalized` would go. The transcript would join the stripped rows
to the history rows by `logId`. Less of the transcript changes, but every
call still has two rows and a join, and `settleCards` becomes a join by id.
It is the same leak behind a better key. B is the fallback if A's read
volume measures badly.

**What goes (A):**

- `cardRows` and the card halves of `finishCall`, `skipCall` and the script
  door's finalizer;
- `settleCards` and `cardResult`;
- the batch rule in `DISPLAY_PAGE_END`, so a page may end at any commit;
- `response.finalized` (the row kind, and its handlers in the run state,
  the view and the transcript) and `RunFacts.answerFinalized`;
- the invoker's two trace streams;
- `logUserMessage`'s row.

That is 124 of the golden store's 806 rows (15%). A rough estimate is 250
to 350 lines net: the transcript's card handlers are rewritten over history
rows, not added beside them.

**Risks:**

- **The SDK's event vocabulary changes.** `run.events` consumers in the
  examples (`packages/harness/example/_evidence.ts:53-55`,
  `packages/harness/example/acceptance.ts:473-488`) correlate `tool.start`
  and `tool.end` by `logId`. The package is 0.x, and the examples move with
  the API report (`npm run docgen`).
- **Read volume.** A display read reads `model.message` rows, which are
  larger than the card rows. Measure the transcript's first paint on the
  golden store before and after.
- **Other readers.** The trace viewer and the history-query copy
  (`agent/runtime/historyQuery/`) read display rows and need the same
  projection.

**Done when:**

- no loop path writes `tool.start`, `tool.end`, `stream.*` or
  `response.finalized` for its own call or answer;
- `settleCards` and `answerFinalized` do not exist;
- a display page may end at any commit;
- the regenerated golden store has no row that restates another.

## 2. Where the loop stands, three ways

### What the code does

**A stored cursor.** `run.position` is "the one record of the loop's
position" (`shared/schemas/runHistoryEvent.ts:95-99`), with six values
(`:86-93`). It is 123 of the golden store's 806 rows. Two of its values only
restate the row they are committed with:

| Value            | Writer                                                                 | Rows | Always right after       | Readers                                                           |
| ---------------- | ---------------------------------------------------------------------- | ---: | ------------------------ | ----------------------------------------------------------------- |
| `response.ready` | `ModelInvoker.ts:373`, in the batch of the `response` row              |   28 | `model.message response` | one: `runLoop.ts:330`                                             |
| `results.ready`  | `loop/toolUseDispatch.ts:997`, in the batch of the delivering `append` |   13 | `model.message append`   | none outside `PHASE_AT`                                           |
| `turn.ready`     | `runLoop.ts:175`, `:244`; `agent/runtime/FollowUps.ts:281`             |   21 |                          | `forkRun.ts:66`, `runLoop.ts:411`, `delegation/agentChild.ts:123` |
| `turn.begin`     | `runLoop.ts:306`                                                       |   21 |                          | `runState.ts:335`, `transcriptUpdate.ts:387`                      |
| `turn.end`       | `runLoop.ts:472`                                                       |   19 |                          | the follow-up receipt (`runHistoryEvent.ts:103-105`)              |
| `waiting`        | `runLoop.ts:425`, `:474`; `agent/runtime/forkRun.ts:264`               |   21 |                          | four sites                                                        |

The writers and readers come from a grep of the literals over
`packages/*/src`, with tests excluded. The row counts come from the golden
store.

The harness's own rule is that "no row restates loop state"
(`packages/harness/AGENTS.md`, "Run loop architecture"). `response.ready`
and `results.ready` do restate it. Nothing else commits them, so the run
state can set `at` when it applies the row that implies it.

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
(`loop/toolUseDispatch.ts:382-645`) decides keep, derive, skip or run at
`:393-430`, and the script door's finalizer decides its own skip at
`:715-749`.

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
- The view needs neither value. It shows `running` for every position but
  `waiting` (`shared/session/runRowReads.ts:187`).
- `RunLoopPhase`, `PHASE_AT` and `phaseAfter` go. Readers read `at`. A run
  is open once its first position is applied, as `requires: 'opened'`
  checks today.
- `run.position` takes a version bump.

In the golden store this removes 41 of the 123 position rows.

**Step 2 (no stored change).** The turn loop's next move becomes one pure,
total function of the run state and the few facts outside it: whether input
is queued, and the run's kind and policy (finding 5's role). It is the
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
  step 1 and finding 5's role. Its gate is the crash-point suite and the
  golden store, with no behavior change.

## 3. A child's result is typed, rendered to XML and parsed back

### What the code does

A child's end builds the envelope its parent's model reads, from the
child's typed facts:

- `formatDelivery` (`agent/runtime/deliveryEnvelope.ts:66`) is called from
  12 sites:
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

## 4. A run's life is a state machine spread over seven collections

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

A design with stops only in rows does not work. `stopRun` cannot write a
row for an id that has none yet (`agent/storage/runLifecycle.ts:356`), so
the `pending` state is real.

**What goes:** five collections, `heldIds`, the rebuild in `liveRun`,
`stopEnded` and the 11 casts. That is about 80 lines, measured by the area
reader, not by an implementation.

**Risk:** the stop-during-open orderings the isolation suites pin. This
lands with no behavior change, gated by those suites.

## 5. What kind of run this is, and its launch, decided at many sites

**(a) "Does this run take input" has two owners.**

- `run.start.takesFollowUps` is stamped once, at registration.
- Each resume's caller decides `stopAfterCycle` again through
  `ResumeInput.interactive` (`effect/sessionPrograms.ts:218-232`:
  `stopAfterCycle: interactive !== true`; `agent/runtime/resumeRun.ts:248-262`).
- `submitFollowUp` refuses every message to a run whose `takesFollowUps`
  is false (`agent/followUp/ToolUseFollowUp.ts:193-196`).

So, as the code reads, an interactive resume of an ended one-shot root is
accepted. The run opens its input reader anyway (`agent/followUp/Inbox.ts:128-142`)
and waits for input nothing may send, until it is stopped. The CLI
restates the rule twice to avoid this ("a run launched to run once reads no
messages",
`packages/cli/src/chat/chatSessionController.ts:579-590`,
`packages/cli/src/commands/resumeRun.ts:159-162`). The run's kind is
recombined by its readers: `stopAfterCycle` is read on 23 lines in 11 files
and `takesFollowUps` on 17 lines in 11 files.

**Design.** One `RunRole` (root, awaited child, background child, process
child), derived once from the run's `run.start` and activation rows. The
questions each reader asks are answered by one module:

- does it take a later turn;
- does it count against the budget;
- does its end deliver to a parent;
- does it read input when it waits.

A root's one-shot policy is read from its `takesFollowUps`, so
`ResumeInput.interactive` and the CLI's two guards go.

**(b) The registration is built before the model binds and committed after
it.**

- `enterRun` builds the registration rows (`agent/runtime/executeAgent.ts:94-102`)
  before the binding exists (`:308-318`).
- The opening batch then writes a second `run.config` that adds only the
  binding (`runLoop.ts:243`). A forked child writes a third (`forkRun.ts:321-323`,
  `runLoop.ts:174`).
- In the golden store, 14 of 18 runs write two `run.config` rows and 2
  write three. In 15 of the 18 consecutive pairs the second row repeats the
  same `config` and adds `binding`.
- The repeats are 15,133 of the 32,228 bytes the store spends on
  `run.config`.

**Design.** `enterRun` returns the registration's options. `openToolUse`
builds the rows once the binding is known, as one `run.config`.

**(c) Two terminals.** A native run ends through `endRun`, which fails a
run whose rows the store refused unless a stop ended it
(`agent/runtime/AgentRunLifecycle.ts:148-153`, `log.lost`). A process child
ends through `runProcessChild` (`agent/runtime/processRun.ts:98-164`), which
builds its end from its own verdict and does not ask `log.lost`. As read
(not reproduced), a process run whose output rows the store refused ends
with its own verdict where a native run in the same state ends failed.

**Design.** Each program keeps its own verdict. One shared end commits it:
the lost-rows check, the log, `endRunRows`, and re-raising an interrupt. If
the asymmetry reproduces, it is a defect and its fix gets one regression
test, written to fail first.

## 6. Smaller

**A provider's facts in eight files.**

- Adding an API-key provider touches the seven places `packages/harness/AGENTS.md`
  lists ("Agent execution"): eight production files in three packages.
- O9 found it, and its first half landed (#14876).
- What is left:
  - The stored list `MODEL_PROVIDERS` (`shared/schemas/runInput.ts:32-43`)
    is a persisted vocabulary. It stays, as a checked copy.
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
  (`groupsOf`, `loop/toolUseDispatch.ts:887-898`).
- A script's calls take their lanes as they arrive (`inLane`, `:689-714`),
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
The peers' newest changes add evidence on three points:

- **pi's deferred commits** (`pi:packages/durable/CHANGELOG.md:70`) store
  partial answers and tool progress later than they are shown. TeXRA stores
  none of these: chunks are transient on the live trace. Finding 1 keeps
  that, and removes the stored copies of the final text instead.
- **pi retries in two layers.**
  - pi-ai retries a provider request itself
    (`pi:packages/ai/src/utils/provider-retry.ts`), called with the SDK's
    own retries off (`pi:packages/ai/src/api/openai-completions.ts:382-387`).
  - The generation task then retries again under its own policy.

  TeXRA has a single owner: the invoker over its rows, under the process's
  route gate, with provider SDK retries off. That is the better shape and
  stays.

- **dsh's approvals are not durable.** A request is a one-shot call through
  answerer listeners (`dsh:packages/interaction/user-approval/README.md`),
  withdrawn when its step aborts. TeXRA's requests are rows with derived
  ids, so a resumed call rejoins its request. Its 4,208 lines across 15
  files were not audited this round, and their size alone is not a finding.

## What is good and stays

- **`nextAttempt` and `failedNext`** (`shared/session/inFlight.ts`): the
  retry loop as a pure function of its rows. Finding 2 extends this shape.
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
- **The doors:** one launch door (`RunRegistry.start`), one end transaction
  (`endIn`), one publisher, the claim as the one owner of a run, and resume
  as the same program over the same rows.

## Order

1. **One storage-format PR, before the freeze**, with one golden-store
   regeneration. It carries:
   - finding 2's step 1 (two position values and `RunLoopPhase`);
   - finding 3 (the typed delivery on `followup.queued`);
   - finding 5 (b) (one `run.config` per launch).
2. **Finding 1, design A**, as one PR. It changes the transcript, the view,
   the trace viewer and the SDK's event vocabulary. Landing it whole means
   no release writes both records.
3. **Findings 4 and 5 (a) and (c)**, with no stored change. This is the
   stop, resume and ownership area.
4. **Finding 2's step 2**, with no stored change, once finding 5's role
   exists.
5. **Finding 6's first item** when the next provider is added.

Each PR deletes more than it adds and adds no test file, except one
regression test if 5 (c) reproduces. The crash-point suite and the golden
store are the gate.

## Verified

- **Golden store counts.**
  - Every `INSERT INTO event VALUES(...)` line of
    `src/test-kernel/fixtures/storage/golden-1.0.sql` was parsed with Node,
    and its `data` column decoded as JSON.
  - Display kinds are the `TRACE_ROW_TYPES` list (`shared/schemas/sessionEvent.ts:511`)
    plus `response.finalized`.
  - A `stream.end` restates a response when its `finalText` equals the text
    or the reasoning of a `model.message` `response` on the same aggregate.
  - A `tool.start` or `tool.end` restates a call when a `response`, a
    `handed-down` or a `script.call` row on the same aggregate has its
    `logId`.
  - Position rows are classified by the row before them, in `seq` order on
    their aggregate.
  - `run.config` pairs are compared by their `config` object.
- **Readers of row kinds.** Each kind's literal was searched in
  `shared/session/runState.ts`, `turnRowHandlers.ts`, `runRows.ts`,
  `sessionViewUpdate.ts`, `transcriptUpdate.ts`, `runRowReads.ts` and
  `controllers/session/projections.ts`.
- **Fix counts.** `node scripts/report-fix-churn.mjs` ran on a history
  fetched to 1,604 commits. Per-file counts came from
  `git log --since='30 days ago'`, following the rename of `toolUse.ts`.
- **Findings 4 and 5.** These came from a read-only area pass over the
  lifecycle, child and catalog modules. Each claim used here was then
  checked in the tree: the collections and flags (`runRegistry.ts:124-152`),
  the `registryOf` count, the unused `programs`, the `FiberMap` in
  `sessionOwners.ts`, the resume's `interactive`, the follow-up refusal, the
  two CLI guards, the missing `log.lost` in `processRun.ts`, `childResult`'s
  second formatting, and the two counts in 5 (a).
- **Peers.** Read at the pinned commits:
  - pi: `generation.ts`, `tool.ts`, `codemode/codemode.ts`, `types.ts`,
    `CHANGELOG.md` and `README.md:894`;
  - pi-ai: the providers and the compat schema;
  - dsh: `agent-loop/src/agent.ts`, `core/tools/src`,
    `core/session/src/repair.ts`, `known-event-types.ts` and
    `interaction/user-approval`.

  No peer was built or run.

- **Not measured.** The transcript's read time under finding 1's design A,
  the line counts of each design, and whether 5 (a) and 5 (c) reproduce.
  The line counts are estimates and are marked as such.
