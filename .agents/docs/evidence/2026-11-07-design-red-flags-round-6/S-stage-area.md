# Round 6, area S: the stage, end to end

Read at `main` `fcb53f7` (#14834). The rename PR #14833 (re-run as
`claude/b-names-2`) has not landed and its branch was not on the remote when
this was read, so every file and line below is cited as it stands on
`fcb53f7`, under its old name, while the prose uses the new names:

| New name (#14833)                           | On `fcb53f7`                                                     |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `Stage`, `StageSchema`                      | `TaskGroup`, `TaskGroupSchema` (`shared/schemas/taskGroup.ts:7`) |
| `StageStatus`                               | `TaskGroupStatus` (`shared/schemas/run.ts:50`)                   |
| `TranscriptView.stages`                     | `TranscriptView.taskGroups` (`shared/session/sessionView.ts:63`) |
| `parentStageId`                             | `parentGroupId` (`taskGroup.ts:13`)                              |
| `StageList`, `<stage-list>`                 | `TaskGroupList`, `<task-group-list>` (`TaskGroupList.ts:158`)    |
| `stageIndex`, `lifecycleToStages` (assumed) | `taskGroupIndex`, `lifecycleToTaskGroups`                        |

Paths are relative to `packages/harness/src/` unless they name a package.
Findings already recorded elsewhere are cited, not repeated: E1 item 7 and
item 5 (`../2026-11-05-design-red-flags/E-loop-tools.md:67-87,114-130`), E11
iii, C11, NM4 (`../2026-11-07-design-red-flags-lenses/names.md:282-288`),
and R6 (the run view carries position, outcome, holder; #14789).

## Numbers

- The area is 11 files that own a part of the stage (4,258 lines), and 38
  production files name it (`TaskGroup|taskGroup|parentGroupId|StageKind|stage.start|stage.end|StageHandle|stageId|groupId`).
  Largest: `agent/runtime/loop/toolUseDispatch.ts` 1,099,
  `packages/texra/src/ui/progress/components/TaskGroupList.ts` 599,
  `shared/session/transcriptUpdate.ts` 408, `shared/session/transcriptState.ts` 398,
  `controllers/session/runTrace.ts` 353.
- Comment share: `transcriptState.ts` 86/398 (22%), `TaskGroupList.ts` 89/599
  (15%), `transcriptUpdate.ts` 61/408 (15%), `shared/transcript/scriptStage.ts`
  60/342 (18%).
- Writers of a `stage.start`: 5 (`executeAgent.ts:198`, `loop/toolUse.ts:407`
  through `stagedBy`, `processRun.ts:105`, `loop/toolUseDispatch.ts:269-277`,
  `packages/texra/src/tools/documents/documentTools.ts:196`). Writers of a
  `stage.end`: 8 (finding 2). Places that know which stages are open: 4
  (finding 3).
- Representations of one stage: 12 (the first question below).

## The area's questions

**What is a stage, and how many representations exist?** A stage is a
labelled span of a run's transcript that other rows nest under: the run
(`Run: <agent>`, `kind: 'run'`, `executeAgent.ts:194-206`), each tool-use
turn (`Tool-use turn`, `kind: 'session'`, `loop/toolUse.ts:406-409`), a
process run's one turn (`Background command`, `Claude Code session`, no kind,
`processRun.ts:105`, `tools/bash.ts:252`), a script's calls (`kind: 'script'`,
`loop/toolUseDispatch.ts:269-277`) and a plugin's section (the documents
plugin's `Revision 1`, no kind, `documentTools.ts:196`). One stage is held as:

1. the `stage.start`/`stage.end` rows (`shared/schemas/traceEvent.ts:43-49`,
   versions at `shared/schemas/rowVersions.ts:224-225`);
2. the trace's `StageHandle` with its `ended` flag
   (`agent/trace/TraceEmitter.ts:210-232`);
3. the publisher's open-work entry (`agent/runtime/SessionEvents.ts:75-110`);
4. the dispatch's per-activation `stageOpened` flag, for a script
   (`loop/toolUseDispatch.ts:779-780`);
5. the fold's `Slot` of kind `stage` (`shared/session/transcriptState.ts:61-65`);
6. the view's `Stage` entry and its position in `stageIndex`
   (`transcriptUpdate.ts:56-85`, `transcriptState.ts:97`);
7. for a run that is not a plain agent's, a plain log row with the same label
   (`transcriptState.ts:330-333`);
8. `groupId` on every member row, from `stageId` on every trace row's
   envelope (`traceEvent.ts:19`, `sessionEvent.ts:105`,
   `transcriptState.ts:290-308`);
9. `stageId` stored on every `script.call` payload
   (`shared/schemas/runHistoryEvent.ts:359-360`);
10. the progress view's `GroupTree` (`TaskGroupList.ts:87-156`);
11. for a script, the `ScriptStageView` (`shared/transcript/scriptStage.ts:305-340`);
12. for a document task, a CLI detail line (`packages/cli/src/chat/tui/panes/WorkflowRunDetails.tsx:50-98`).

The CLI's transcript pane reads no stage at all: `transcriptEntryLayout.ts`
and `ConversationPane.tsx` render rows flat, and stages reach the terminal
only as the document task's detail lines (`ConversationPane.tsx:66-72`), the
Ctrl-O availability test (`App.tsx:193-196`) and the headless NDJSON stream,
which forwards every `stage.*` row (`runtime/headless/sessionProgressSubscription.ts:25-37`).

**Which facts are derived at render time?** The stage tree, each stage's
rows, the order of stages among rows (by wall clock, finding 7), the
duration (two hosts), whether a stage is a root (by its place in the tree),
and whether an open stage is still running (rows get the run's interrupted
fact, stage headers do not: finding 2's defect).

**Does `StageStatus` duplicate the run's vocabulary?** Yes: it is
`'running' | RunOutcome` (`run.ts:45-54`), so it folds position and outcome
into one field, the shape R6 split for the run. Eight writers map an exit to
it, four tables map it to glyphs, and nobody maps "open, but the process
died" (finding 2).

**Is `kind` a special case written as data?** Yes (finding 5): `run` has one
reader, a dead fallback; `session` has one, a reset `turn.begin` already
gives; `script` has three; two stage sources write no kind.

**Is the parent/child nesting one fact?** No: four (finding 4).

**Where does the loop decide when a stage opens and closes?** In five
writers and eight closers, with the run's end closing open stages twice
(findings 1 to 3).

**What does the trace emitter restate?** The run's and the turn's bounds
(finding 1), an idempotency flag the publisher also keeps (finding 3), and a
two-literal `kind` set beside the schema's three (finding 5); its `child()`
has one caller outside the emitter (finding 8).

## Findings

### 1. The run and turn stages restate rows the run already writes

**Red flags:** two representations of one fact; temporal decomposition.
**Status:** found as E1 item 7 (`E-loop-tools.md:76-87,121-130`, option two).
The catalogue records E1 as "landed (#14769, R2)" (`catalogue.md:639`), but
item 7 did not land: every writer it names is still on `main`. This finding
is that record's correction plus what was added since.

**Evidence.**

- The run stage opens in `executeAgent.ts:194-206` under `acquireRelease`,
  closes in `AgentRunLifecycle.ts:153-164` with `verdict.outcome`, and again
  as FAILED in the release (`executeAgent.ts:203-205`). The rows already say
  the same: `run.activate` and `run.end` with its `outcome`
  (`shared/session/runRowReads.ts:252-265`).
- The turn stage is `stagedBy(() => logger.openStage('Tool-use turn', { kind: 'session' }), …)`
  (`loop/toolUse.ts:406-409`, `loop/runProgram.ts:184-205`). The loop writes
  `run.position` at `turn.begin` (`loop/toolUse.ts:312`) and at `turn.end`
  with `turn.outcome` (`loop/toolUse.ts:481`): the same span and the same
  outcome.
- A process run's stage (`processRun.ts:105,115`) is the run's one turn,
  ended with the outcome its `run.end` carries in the next statement
  (`processRun.ts:116-117`). Its label is a `stageLabel` column on every
  process turn (`processRun.ts:61`; set at `tools/bash.ts:252`,
  `packages/texra/src/tools/agentCli/claudeAgent.ts:394`, `codex.ts:323`,
  `agentCliShared.ts:216,246,284`).
- `parentStage` threads the run stage to plugins: `run/AgentRun.ts:123`,
  `RunCall.ts:172`, `executeAgent.ts:235`, `AgentRunLifecycle.ts:155`,
  `packages/texra/src/tools/documents/documentState.ts:71`,
  `documentTools.ts:196` (7 refs, 6 files; 4 in tests, including
  `src/test-kernel/support/nativeToolTestLayer.ts:97`).

**Design decision behind it.** The trace was the transcript's only
structure before the run history existed; the history now bounds every run
and turn, and the trace kept its copy.

**Better design.** A run and a turn are not stages. The fold groups a plain
agent's rows by turn from the `run.position` rows it already applies
(`applyStandingToTranscript`, `transcriptUpdate.ts:289-330`), and the run's
own header is the run tab's. Deleted: `stagedBy` (3 refs, 2 files), the run
stage's open and its two closes, `RunLaunch.parentStage`/`RunCall.parentStage`
(7 refs), `processRun`'s stage and the `stageLabel` column (8 refs, 6 files),
`StageOptions.kind`. `stage.start` bumps to v3 (an earlier build's run stage
reads as that build's); the golden store loses 46 `stage.start` rows
(`src/test-kernel/fixtures/storage/golden-1.0.sql`).

**What we give up.** The headless stream's `Run:` and `Tool-use turn` lines
(the CLI `contract: 2` projection forwards rows verbatim): it bumps the
contract, and a consumer reads `run.position` instead. The progress view
keeps its per-turn disclosure, now built from positions.

**Size.** About -150 lines in the harness, -20 in the app; one row version.

**Change amplification.** "Rename the turn heading": today the label lives
in `loop/toolUse.ts:407`, the fold's reset keys on its kind
(`transcriptUpdate.ts:108`); after, one copy string in the UI.

**Depends on.** #14833 (every file is renamed there).

### 2. A stage's status has eight writers and four painters, and an interrupted run's open stage reads "Running"

**Red flags:** two representations of one fact; repetition; a renderer that
compensates for the data, applied to rows and not to stages (UI
anti-pattern). Contains a **defect**.

**Evidence.**

- Writers of a stage's outcome: `TraceEmitter.ts:220-227` (default
  COMPLETED), `runProgram.ts:198-203` (`outcomeFromCause`),
  `executeAgent.ts:203-205` (FAILED), `AgentRunLifecycle.ts:155`,
  `processRun.ts:115`, `loop/toolUseDispatch.ts:286-292`
  (`'executed' ? 'completed' : 'failed'`, so a stopped script's stage reads
  failed, never cancelled), `documentTools.ts:199-205` (its own ternary),
  `controllers/session/runTrace.ts:124-125` (the run's outcome), plus the
  fold's own close (`transcriptUpdate.ts:323-328`). Five distinct mappings.
- Painters: `terminalStatusIcon` with `TerminalStatusKind`, which restates
  `StageStatus` literally (`packages/texra/src/ui/wa/statusIcons.ts:14-27`);
  `runStatusLabel` (`TaskGroupList.ts:416-421`); the CLI borrows the
  compaction table "whose values are a subset"
  (`packages/cli/src/chat/tui/panes/transcriptEntryLayout.ts:122-134`) and
  ranks with `lifecyclePriority` (`WorkflowRunDetails.tsx:72-76`); and an
  `is-${group.status}` class no stylesheet reads (`TaskGroupList.ts:506`;
  `grep -rn "is-running\|is-failed"` finds no rule).
- **Defect.** A run whose process died mid-turn has no `run.end`, so its open
  stages stay `running` (the fold closes stages only on `run.end`,
  `transcriptUpdate.ts:322-328`; the publisher's open work is per process,
  `SessionEvents.ts:47-53`). The list paints rows with the run's interrupted
  fact (`TaskGroupList.ts:358-363`, `isInterrupted` at
  `shared/session/sessionView.ts:216-218`), so the turn's cards read stopped,
  while the stage header above them reads "Running" with the running glyph
  (`TaskGroupList.ts:416`). The CLI's document-task details do the same
  (`WorkflowRunDetails.tsx:66`). Before R6 the header read
  `taskGroupDisplayStatus(group, durableOutcome)`; #14789 moved the run-end
  close into the fold and the interrupted case fell between them.

**Design decision behind it.** "Is this stage still going" is the run's
position-and-holder question asked of a span, but the stage stores it as a
literal of its own.

**Better design.** A stage stores `outcome: RunOutcome | null` (null is
open), never `running`, so `StageStatus` is deleted (7 refs, 5 files). An
open stage reads as its run reads: one function in `@ui/copy/runStatus.ts`,
`stageStatusKey(stage, run)`, gives `interrupted` when the stage is open and
`isInterrupted(run)`, used by the progress list, the CLI details and the
script stage. `TerminalStatusKind` becomes `RunStatusKey`'s icon column
(R6's "words are one function"); the CLI's borrowed table and the dead
class go. Writers: after finding 1 and finding 6 only the plugin stage
(scoped, finding 8) and the fold remain.

**What we give up.** Nothing a user sees except the fix.

**Size.** About -40 lines; one failing-first regression (the list, or the
copy function, over an interrupted run with an open stage).

**Depends on.** #14833.

### 3. The run's end closes open stages twice, and four places know which stages are open

**Red flags:** two representations; reinvented primitive (an idempotency
flag beside a tracker beside the fold); error handling that the shape could
define away.

**Evidence.**

- Durable close: the publisher tracks every open `stage.start` per aggregate
  (`SessionEvents.ts:75-110`), and `closure(runId, outcome)` writes a
  `stage.end` for each into the `run.end` batch (`runTrace.ts:110-127`,
  called at `agent/storage/runLifecycle.ts:298`). That needs the overload and
  the `ClosureFact` union (`shared/session/sessionLog.ts:33-38,74-78`).
- Fold close: the transcript closes every open stage on the same `run.end`
  (`transcriptUpdate.ts:289-330`, "as the drain that ends a run no driver
  holds does"), which it must do anyway for a stage an earlier process left.
- Open-ness held four times: `StageHandleImpl.ended`
  (`TraceEmitter.ts:211,221-222`), the publisher's open work, the fold's
  `isOpenGroup` (`transcriptUpdate.ts:330`), the dispatch's `stageOpened`
  (`loop/toolUseDispatch.ts:779-780`). A script stage closed by a stop's
  durable close is then reopened on resume with the same id
  (`toolUseDispatch.ts:254-258`; `transcriptUpdate.ts:75-83` overwrites the
  closed entry).

**Better design.** The fold's close is the one: the view closes a stage on
its run's `run.end`. Deleted: the `stage` branch of `closure` and its
overload, `ClosureFact`, `OpenWork.kind` (the publisher tracks streams
only), `StageHandleImpl.ended`. With finding 6 the script stage's reopen
goes too.

**What we give up.** A headless consumer no longer sees a `stage.end` for a
stage the run's end closed; it sees the `run.end`.

**Size.** About -50 lines. **Depends on.** Finding 1 (fewer stages to
close), #14833.

### 4. The parent edge is one fact spelled four ways, and the script stage has none

**Red flags:** information leakage (an id grammar); two representations.
Borders C11 (run topology spelled five ways, `C-row-model.md:604-611`): the
same disease one level down.

**Evidence.**

- `stage.start.parentId`, kept on the view only when the fold already holds
  the parent (`transcriptUpdate.ts:68-70`), while the stage's own heading
  row takes the same id as `groupId` unconditionally
  (`transcriptUpdate.ts:111-118`): two rules for one edge.
- Every member row's `groupId`, from `stageId` on every trace and durable
  row's envelope (`traceEvent.ts:19`, `sessionEvent.ts:105`), threaded by
  `LogOptions.stageId` (`agent/trace/AgentTrace.ts:88-92`) and by
  `cardRows` (`loop/toolUseDispatch.ts:336-341`).
- `script.call.stageId`, stored on every call a script issues
  (`runHistoryEvent.ts:359-360`) though it is `script-${script.logId}` for
  all of them (`loop/toolUseDispatch.ts:837`): a derived value persisted per
  row.
- The script stage writes no `parentId` (`toolUseDispatch.ts:270-276`), so it
  is a root of the transcript beside the run, while it belongs under the
  `script` call's card. The link from card to stage is the id grammar
  `script-<card id>`; the link from a child run to its card is a third
  spelling, `RunView.parentCard`, which `dispatchedChildren` and
  `scriptStages` join back by walking rows (`scriptStage.ts:271-297,321-327`).

**Better design.** A stage sits under a card: `Stage.card` (the call's
`logId`, or null for none). A script's stage is its `script` call's card,
so its id is that card's id; a plugin's stage is under the call that opened
it. Deleted: `parentStageId` (5 refs, 3 files) and `stage.start.parentId`,
`script.call.stageId` (row version bump), the `script-` id grammar. A
member row keeps `groupId` (its stage), the one edge rows need.

**Size.** About -40 lines; `script.call` v-bump. **Depends on.** Finding 6.

### 5. `kind` is a special case written as data

**Red flags:** no option for a special case (a column constant or derivable
across its rows); repetition of a literal set.

**Evidence.** `StageKindSchema = ['run', 'session', 'script']`
(`taskGroup.ts:5`) and `StageOptions.kind?: 'run' | 'session'`
(`AgentTrace.ts:23`): two sets sharing two members.

| Value     | Readers | Where                                                                                                                                                                                     |
| --------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     |       1 | `WorkflowRunDetails.tsx:93`, the fallback of `group.name \|\| …`; every stage has a non-empty label, so it never runs                                                                     |
| `session` |       1 | `transcriptUpdate.ts:108`, resets the turn's response stream, which `turn.begin` marks already                                                                                            |
| `script`  |       3 | `scriptStage.ts:279,310`, `packages/cli/src/chat/tui/App.tsx:195`                                                                                                                         |
| (absent)  |       – | process and plugin stages (`processRun.ts:105`, `documentTools.ts:196`), a fourth value spelled as `undefined`, and `Schema.optional(Schema.NullOr(...))` on the row (`traceEvent.ts:47`) |

**Better design.** After finding 1 the only stages are script stages and
plugin sections, and a script stage is the stage of a `script` card
(finding 4), so the readers ask the card. `kind`, `StageKindSchema`,
`StageOptions.kind` and the dead fallback are deleted.

**Size.** About -25 lines. **Depends on.** Findings 1 and 4.

### 6. The loop opens and closes a script's stage with a closure flag and restates the script call's result

**Red flags:** state outside the rows (a flag the rows could answer);
two representations. **Status:** E1 item 5 and E11 iii
(`E-loop-tools.md:67-71,114-118`) are recorded as landed in #14825
(`catalogue.md:649`): `Call.opensStage?` became `Call.stage: { title, opens }`
(`loop/toolUseDispatch.ts:146-160`), but the flag it reads is the same
per-activation `let stageOpened` (`:779-780`). The new angle is that the
stage needs no rows at all.

**Evidence.** The stage opens in "the first batch its calls commit in an
activation" (`toolUseDispatch.ts:254-277`, the rule in
`packages/harness/AGENTS.md` "Event channels and cards") and closes in the
batch that records the `script` call's result, with an outcome mapped from
that result (`:282-292`). Everything the script stage view shows comes from
cards already: `scriptStages` builds each stage from the tool rows under it
and the child runs of their cards (`scriptStage.ts:305-340`); its status
has one reader (`packages/cli/src/runtime/headless/scriptPlainOutput.ts:53`).
Its label is the script's title (`toolUseDispatch.ts:840-845`), which the
`script` call's input carries.

**Better design.** A script's stage is a projection of its `script` call's
card and the `script.call` rows that card issued: open while the card is,
ended with the card's result. The dispatch writes no stage row. Deleted:
`Call.stage`, `stageOpened`/`opensStage`, the stage cases of `displayRow`
(`loop/rows.ts:141-152`), the stage rows in `commit`, the "a resumed script
reopens its stage" rule (one AGENTS.md sentence).

**What we give up.** The headless stream's script `stage.*` lines; the
script's `tool.start`/`tool.end` and its calls' cards say the same.

**Size.** About -60 lines in the loop. **Depends on.** Finding 4.

### 7. The progress view rebuilds the tree, the membership and the order at render, three times

**Red flags:** a renderer that compensates for the data model (UI
anti-pattern); repetition.

**Evidence.**

- `transcriptTimeline` (`TaskGroupList.ts:122-156`) builds the tree from
  `parentStageId`, partitions every row by `groupId` with `Map.groupBy`, and
  interleaves roots and ungrouped rows by `startTime`/`timestamp`, wall-clock
  milliseconds, though the fold numbers the stage's slot (`seqNo`,
  `transcriptState.ts:298-301`) and drops it from the `Stage` entry;
  `compareGroups` passes `() => undefined` for the sequence
  (`TaskGroupList.ts:107-114`).
- `scriptStages` partitions the same rows by `groupId` again
  (`scriptStage.ts:310-320`), and `dispatchedChildren` rebuilds the set of
  script-stage ids and script cards (`scriptStage.ts:276-290`).
- Duration `endTime - startTime` in two hosts (`TaskGroupList.ts:411-412`,
  `WorkflowRunDetails.tsx:56-58`).
- A stage's root-ness is its place in the tree (`TaskGroupList.ts:472-484`),
  where it writes the stage id into `data-run-id` (`:481`); `data-group-id`
  is written at seven sites in three formatter files (`bannerFormatters.ts:120,124`,
  `toolFormatters/helpers.ts:101`, `messageFormatters.ts:70,97,118,138`).
  Nothing reads either attribute (`grep -rn "dataset.groupId\|data-group-id]\|data-run-id]"`:
  no hit in `packages/*/src`, `src`, or the E2E suites).

**Better design.** The fold already holds every fact: the stage entry
carries its `seqNo`, and one `stageTree(transcript)` in
`@texra-ai/harness/transcript` returns the ordered tree with each stage's
rows, which the list and `scriptStages` both read. Deleted:
`transcriptTimeline`'s grouping and `compareGroups`, the second and third
partitions, the dead attributes and class.

**Size.** About -60 lines. **Depends on.** Findings 1, 4.

### 8. The trace's stage API is a hand-rolled resource with one outside caller of `child()`

**Red flags:** reinvented primitive (an idempotent `end` flag instead of a
scope); shallow module; overexposure (a public `/plugins` type,
`packages/harness/src/plugins.ts:195-196`).

**Evidence.** `StageHandle` = `id`, `end(status?)` and `child()`
(`AgentTrace.ts:28-36`); `end` is idempotent by a flag
(`TraceEmitter.ts:211-227`) because three owners may close one stage
(finding 1). `child()` has one caller outside the emitter
(`documentTools.ts:196`), which opens a stage only for the first revision
and then passes `stage?.id` as a parameter whose presence also means "this
is the first revision" (`documentTools.ts:212-221,231-236`), and maps the
exit with its own ternary (`:199-205`).

**Better design.** A plugin's section is `trace.stage(label, body)`: an
`Effect.acquireUseRelease` whose release reads the body's exit
(`outcomeFromCause`, as `stagedBy` does today), opened under the calling
card. Members are logged inside it, so `LogOptions.stageId` goes too. The
documents plugin passes `revision === 0` as the fact it is. Deleted:
`StageHandle`, `StageOptions`, `StageHandleImpl` (16 refs, 6 files; 5 in
tests), `LogOptions.stageId`; API report regenerated.

**Size.** About -50 lines. **Depends on.** Finding 1.

### 9. One stage, two renderings, picked by a context flag

**Red flags:** special and general code mixed; a boolean that a fact
decides elsewhere.

**Evidence.** `TranscriptContext.lifecycleToStages`
(`transcriptState.ts:41-51`), set from `isPlainAgentIdentity` in two places
(`transcriptUpdate.ts:402`, `sessionViewUpdate.ts:1004`), decides whether a
stage's label also becomes a plain log row (`transcriptState.ts:330-333`).
For a process run or a full-log child the label prints twice: once as a row,
once as the stage. The `stage` slot kind exists for this row
(`transcriptState.ts:61-65`, `transcriptUpdate.ts:111-128`).

**Better design.** After finding 1 the remaining stages always render as
stages, so the flag, the `stage` slot kind and the heading row are deleted
(4 refs of the flag, 3 files).

**Size.** About -30 lines. **Depends on.** Finding 1.

### 10. Names the rename leaves

**Red flags:** two names for one thing. **Status:** NM4 is #14833's; this is
the residue, to check against its diff when it lands. The member rows' edge
is `groupId` (`shared/transcript/transcriptRow.ts:61`), the styles are
`groupStyles.ts` with `.log-group*`, `.group-title`, `.group-time`, the
toggle is `dispatchGroupToggle` and `Surface.groups`, the tree is
`GroupTree`, and `WorkflowRunDetails.tsx` names a document task "workflow"
(X-R5, `catalogue.md:844`). A wire string (`Surface.groups` if persisted)
keeps its spelling. **Size.** Rename only; fold into finding 7's PR.

## Design it twice

**Design A: the stage is the trace's general primitive, with one writer.**
Every span the transcript groups (run, turn, process turn, script, plugin
section) is a stage; the loop asks the trace for a scoped stage whose
`stage.start` rides the batch; the view carries a tree. It keeps `kind`
(the UI needs to tell a script stage apart), keeps the run and turn rows
twice (positions and stages), keeps the durable close at the run's end, and
moves the script stage from the dispatch to the trace: rows 2 kinds, writers
1, representations about 8.

**Design B: a stage is only a span no other row bounds.** The run and the
turn are bounded by `run.activate`/`run.end` and `turn.begin`/`turn.end`,
and the fold groups by them; a script's stage is a projection of its
`script` card and the calls it issued; the one span nothing else bounds is a
plugin's section inside a call, which stays a `stage.*` pair written by one
scoped trace call under its card. The view's `stages` carry `seqNo`,
`card`, `outcome | null`, and an open stage reads as its run reads.

| Measure                      | Today | A   | B                      |
| ---------------------------- | ----- | --- | ---------------------- |
| Sources of `stage.start`     | 5     | 1   | 1 (plugin sections)    |
| Closers of a stage           | 8     | 2   | 2 (scope, fold at end) |
| Stage kinds                  | 3+1   | 3+1 | 0                      |
| Edges to a parent            | 4     | 2   | 1 (`card`)             |
| Representations of one stage | 12    | ~8  | ~5                     |
| Stored per-row derived ids   | 1     | 1   | 0                      |

**Chosen: B.** It deletes where A moves, and every fact it drops is already
a row. It costs the headless stream's stage lines (contract bump) and two
row versions (`stage.start`, `script.call`), both allowed before 1.0 ships.

## Good, left alone

- `applyTranscriptEvent` as the one fold for live and cold reads
  (`transcriptUpdate.ts:1-12`, `:388-408`): one reducer, a cold read that
  refuses history without its creation row. Findings shrink its input.
- `scriptStages` as the one script-stage model the progress view, the TUI
  popup and headless read (`scriptStage.ts:1-14`): a deep module; finding 6
  feeds it from the card instead of a stage entry, its interface unchanged.
- The card's monotone machine (`transcriptUpdate.ts:87-92`): a shape, not a
  compensation.
- `stagedBy`'s use of `acquireUseRelease` to read the body's value
  (`runProgram.ts:184-189`): the right primitive; finding 8 moves it to the
  one place a stage still needs it.
- `RunOutcome` and `outcomeFromCause` (`run.ts:12-31`): the one verdict;
  finding 2 makes stages use it instead of a superset.
- The headless stream forwarding rows verbatim
  (`sessionProgressSubscription.ts:25-37`): one projection, no second
  vocabulary; it shrinks with the rows.

## Effect-native mapping

| Finding | Primitive or structure                                      | Checked                                                                                                    |
| ------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1       | Rows as the one record; the fold groups by `run.position`   | `RunState`, `applyStandingToTranscript` (no Effect primitive)                                              |
| 2       | One function over `outcome \| null` and the run view        | R6's `RunStatusKey` table (`packages/texra/src/ui/copy/runStatus.ts:45,73,97`)                             |
| 3       | The fold as the one closer                                  | –                                                                                                          |
| 6       | A projection from rows, no fiber-local flag                 | –                                                                                                          |
| 8       | `Effect.acquireUseRelease` (release sees the body's `Exit`) | `effect` 4.1.2 `dist/Effect.d.ts`: `acquireUseRelease(acquire, use, release: (a, exit: Exit<A, E2>) => …)` |

## Owners

All findings are the harness's E package plus the app's progress view
(`packages/texra/src/ui/progress/`) and the CLI panes; one session owns them,
after #14833 lands. Finding 10 is #14833's reviewer's to check.

## Fix plan

Every file below is renamed by #14833, so both PRs wait on it. Ranked by
what they delete and the defect first.

**PR 1, `simplify: stages are the spans no row bounds (round 6 S, part 1)`**
(findings 2, 1, 3, 5, 9, in that order; the regression test is written first
and fails on `main`):

- `packages/harness/src/shared/schemas/stage.ts`, `run.ts`, `traceEvent.ts`,
  `rowVersions.ts` (`stage.start` v3; `StageStatus`, `StageKindSchema`
  deleted)
- `packages/harness/src/agent/trace/AgentTrace.ts`, `TraceEmitter.ts`
- `packages/harness/src/agent/runtime/executeAgent.ts`,
  `AgentRunLifecycle.ts`, `processRun.ts`, `RunCall.ts`, `run/AgentRun.ts`,
  `loop/toolUse.ts`, `loop/runProgram.ts`, `SessionEvents.ts`
- `packages/harness/src/controllers/session/runTrace.ts`,
  `shared/session/sessionLog.ts`, `transcriptUpdate.ts`, `transcriptState.ts`,
  `sessionViewUpdate.ts`
- `packages/harness/src/tools/bash.ts`, `packages/texra/src/tools/agentCli/`
  (`claudeAgent.ts`, `codex.ts`, `agentCliShared.ts`),
  `packages/texra/src/tools/documents/` (`documentTools.ts`,
  `documentState.ts`)
- `packages/texra/src/ui/copy/runStatus.ts`, `ui/wa/statusIcons.ts`,
  `ui/progress/components/StageList.ts`, the CLI's
  `WorkflowRunDetails.tsx` (or `DocumentTaskRunDetails.tsx`),
  `transcriptEntryLayout.ts`, `App.tsx`
- `src/test-kernel/fixtures/storage/golden-1.0.sql` regenerated,
  `src/test-kernel/support/nativeToolTestLayer.ts`; the CLI's headless
  contract number.

**PR 2, `simplify: a script's stage is its card (round 6 S, part 2)`**
(findings 4, 6, 8, 7, 10):

- `packages/harness/src/shared/schemas/runHistoryEvent.ts` (`script.call`
  without `stageId`, version bump), `stage.ts` (`card`, `seqNo`)
- `packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`,
  `loop/rows.ts`, `agent/trace/*`, `plugins.ts` and the API reports
- `packages/harness/src/shared/session/transcriptUpdate.ts`,
  `shared/transcript/scriptStage.ts` (`stageTree`), `transcriptEntry.ts`
- `packages/texra/src/ui/progress/components/StageList.ts`,
  formatters (`bannerFormatters.ts`, `messageFormatters.ts`,
  `toolFormatters/helpers.ts`), `styles/groupStyles.ts`
- `packages/harness/AGENTS.md` "Event channels and cards" (the script-stage
  sentence).

### Landed (PR 1, `simplify/s-stages-part-1`)

Re-read on `main` `4f35cec`, after #14836's renames. In order:

- **Finding 2.** A `Stage` stores `outcome: RunOutcome | null`;
  `StageStatus` is deleted. `stageStatus(stage, run)` in
  `packages/texra/src/ui/copy/runStatus.ts` reads an open stage as its run
  reads (interrupted when nobody drives the run), used by `StageList` and
  the CLI's `DocumentTaskRunDetails.tsx`, with one regression test
  (`packages/texra/test/ui/stageStatus.vitest.ts`, failing on `main`). The
  dead `is-${status}` class went. `terminalStatusIcon` stays for script
  calls' statuses (`ScriptStage.ts`), which are not stage statuses.
- **Finding 1.** The run, turn and process-run stages, `stagedBy`,
  `parentStage` and `stageLabel` are deleted. Re-verification showed the run
  and turn stages grouped no rows at all (no writer stamped their ids on a
  member), so no fold grouping by `run.position` was needed; the turn
  stage's one reader (resetting the turn's response stream) is now
  `turn.begin` and `run.activate`. With the run stage gone nothing wrote a
  parent edge, so `stage.start.parentId`, `Stage.parentStageId` and
  `StageHandle.child` went too (finding 4's `card` edge is still PR 2's).
  The documents plugin's `Revision 1` section is one `acquireUseRelease`
  span closed on the call's exit (`outcomeFromCause`, now exported from
  `@texra-ai/harness/schemas`); every non-script stage renders as a
  collapsible section in the progress view, a script stage as before.
- **Finding 3.** The publisher tracks streams only; `closure` has no
  outcome overload and `ClosureFact` and `StageHandleImpl.ended` are gone.
- **Finding 5.** `StageKindSchema` and `StageOptions` are deleted. Finding
  4 was not needed for it: only the script dispatch puts a card under a
  stage, so `isScriptCall` (a tool card under a stage) answers the three
  `script` readers.
- **Finding 9.** `TranscriptContext.lifecycleStages`, the `stage` slot kind
  and its heading row are deleted.

Format: `stage.start` v3, the CLI NDJSON contract 3, the golden store
regenerated. Left for PR 2: findings 4 (`Stage.card`, `script.call.stageId`,
the `script-` id grammar), 6, 7, 8 (`StageHandle`, `LogOptions.stageId`)
and 10.
