# E. The run loop and the tool engine: design red flags

Area: `packages/harness/src/agent/runtime/loop/*`, `agent/runtime/runApprovalQueue.ts`,
`agent/runtime/requestPolicy.ts`, `agent/runtime/HostInteractions.ts`, `agent/runtime/agentToolResolution.ts`,
`agent/runtime/ToolServices.ts`, `agent/runtime/AgentLaunchContext.ts`, `agent/runtime/sessionDescription.ts`,
`tools/core/*`, `tools/liveTools.ts`, `tools/sessionTools.ts`,
`tools/executions/*`, `agent/core/tools/*`. Read-only, at the working tree of
2026-11-05. Paths below are relative to `packages/harness/src` unless they
start with `packages/`. Consumer counts are over `packages/*/src`.

Note on churn: the checkout is a 50-commit shallow clone, so the brief's
fix-churn measure cannot be taken here; the two fixes visible in `loop/`
(#14758 background progress notices, #14623 `self()` modules) both land in
findings 4 and 7.

Comment-line share of the worst files in the area (`^\s*(/\*|\*|//)` over
total): `agent/core/tools/ToolTypes.ts` 63% (a contract file; acceptable), `tools/core/inputSchema.ts`
53%, `tools/core/result.ts` 47%, `tools/executions/waitCoordination.ts` 42%, `tools/executions/turnAttribution.ts` 41%,
`agent/runtime/sessionDescription.ts` 32%, `agent/core/tools/toolCallParsing.ts` 32%, `agent/core/tools/toolSchema.ts` 27%,
`agent/runtime/HostInteractions.ts` 25%, `agent/runtime/agentToolResolution.ts` 25%, `agent/runtime/loop/step.ts` 23%.
The three that matter for design are `agent/runtime/loop/step.ts` (its 35-line header explains a
hand-over-hand pin protocol, finding 9), `agent/runtime/HostInteractions.ts` (a queue and
replay protocol in prose, finding 8) and `agent/runtime/loop/runProgram.ts:229-237` (a comment
explaining why two stage shapes coexist, finding 1).

---

## Finding 1. The loop holds seven pieces of state beside the rows it says are its state

**Red flags:** two representations of one fact; state machine in a mutable
field; reinvented Effect primitive (`Deferred` as "the cell exists"); comments
substituting for design.

**Evidence.** `packages/harness/AGENTS.md:64` says "State is row data. The loop
holds no copy of the conversation". The conversation is indeed rows. What is
not rows:

1. `openingSystem` (`agent/runtime/loop/toolUse.ts:164,216,256`): a closure variable holding
   the system text "until its opening batch records it", threaded as the fifth
   positional argument of `stepFor` (`agent/runtime/loop/toolUse.ts:167`) into `openStep`
   (`agent/runtime/loop/step.ts:210,362-365`), where it is the fallback when
   `state.input.system === undefined`. Two owners of the base text: a local
   before the opening commits, a blob address after.
2. `controls` with `oneShot` (`agent/runtime/loop/toolUse.ts:172-175`), attached to the registry
   before the cell is open (`agent/runtime/loop/toolUse.ts:536`, before `acquireUseRelease` at
   `:537`). `oneShot` is `run.toolPolicy.stopAfterCycle === true`: the same
   fact as `ToolPolicy.stopAfterCycle` (31 references, 16 files), as the row
   field `followUpSupport` (`agent/runtime/runRegistry.ts:179-184` picks one or the other
   to compute `readsMessages`), and as the `oneShot` refusal reason in
   `agent/followUp/ToolUseFollowUp.ts:327`. Four spellings of "this run reads
   input".
3. `opened = Deferred.makeUnsafe<RunCell>()` (`agent/runtime/loop/toolUse.ts:171,396-397`) exists
   only because the controls are attached before `openRun`: `modelSwitchPort`
   awaits it to read `cell.current` (`agent/runtime/loop/modelSwitch.ts:92-100`). The host
   side already waits for the activation before touching controls
   (`controllers/session/SessionRequests.ts:293-302`: `raceFirst(attempt.answer,
   Deferred.await(attempt.admitted))` then `runs.get(runId)?.controls`). The
   Deferred is a readiness latch for an ordering the caller already observes.
4. `run.steps: SynchronizedRef<OpenStep | null>` with `holding: boolean`
   (`agent/runtime/loop/step.ts:104-120,338-345,449-462`): a three-state machine (no step; a
   step whose "hold on the record is not spent"; a spent step). The rows
   already say this: `RunState.resuming` is "true after a `run.activate`
   until the loop writes its next position" (`shared/session/runState.ts:130-131`),
   and a request step writes a position. `stepFor`'s
   `held = open === null || open.holding` (`agent/runtime/loop/step.ts:452`) is a second
   spelling of `state.resuming`.
5. `stageOpened` / `opensStage` (`agent/runtime/loop/toolUseDispatch.ts:770-772,265-273`):
   a per-activation closure flag for "the script's stage card is open", read
   under the cell's lock. The fold classifies `stage.start` as a card row
   (`shared/session/runState.ts:159`), so whether the stage's card is open after a stop's
   `stage.end` is a question the rows can answer.
6. `reentering` / `opened` counters in `callRequests` (`loop/toolGuard.ts:306-307,
   324-337`): seeded from `resumedAttempt`'s `raised` and `own`
   (`shared/session/inFlight.ts:357-376`, the module the lead auditor judged
   GOOD) and then incremented locally, although every `commit` returns the
   state the next read could take `raised` from.
7. Trace stages: `stagedBy` (`agent/runtime/loop/runProgram.ts:238-253`) closes a turn
   stage from the body's exit; `agent/runtime/childRunLoop.ts:260,775,799` keeps a mutable
   `stage` field and closes it as FAILED on any exit its end did not close;
   `agent/runtime/executeAgent.ts:195` opens the `Run:` stage under `acquireRelease`; and
   the dispatch commits a script's `stage.start`/`stage.end` as display rows
   in the call's batch (`agent/runtime/loop/toolUseDispatch.ts:265-290`). Three writers of
   `stage.*` rows (`agent/trace/TraceEmitter.ts:115-124,214-222`,
   `agent/runtime/loop/toolUseDispatch.ts:265-290`, `controllers/session/runTrace.ts:125`), two
   id schemes (`randomUUID()` vs `script-${logId}`, `:829`), and
   `agent/runtime/loop/runProgram.ts:229-237` explaining why "`childRunLoop` deliberately keeps a
   mutable `stage` field". A nine-line comment justifying a mutable field is
   the structure asking for a different owner.

Also in memory, and acceptable because they are transient by nature:
`accepting`/`streamed` for the card's live text (`agent/runtime/loop/toolUseDispatch.ts:460-470`),
`startedAt` for `duration_ms` (`agent/runtime/loop/hooks.ts:425-428`), and the script door's
`sharedValues` (`agent/runtime/loop/toolUseDispatch.ts:774-785`, documented as "what must outlive
a restart is made from rows").

**The design decision behind it.** The loop is one program over rows, but the
_activation_ (the process's hold on the run: what it attached, what it has
opened, what it rendered before the first commit) has no row and no single
in-memory owner, so each fact about the activation got its own local.

**The better design.**

- Attach controls after `openRun` returns the cell (move `attachControls` into
  `enter`, `agent/runtime/loop/toolUse.ts:394-403`); `modelSwitchPort` then takes the `RunCell`
  as a value and `opened` is deleted (1 Deferred, 2 sites).
- `RunControls.oneShot` becomes a read of the view's `followUpSupport`
  (the row the launch already stamps; `agent/runtime/runRegistry.ts:179-184` already does
  this when no controls are attached), so `RunControls` is only the two
  model-switch methods; `ToolPolicy` (one optional boolean, `agent/runtime/run/AgentRun.ts:84-86`,
  12 `toolPolicy` readers) collapses to a `stopAfterCycle: boolean` field of
  `RunLaunch`.
- `OpenStep.holding` is deleted; `stepFor` reads `state.resuming`
  (consumers of `holding`: 3, all in `agent/runtime/loop/step.ts`).
- `opensStage` is replaced by a fold read: the pending response's record for
  the script call knows whether its stage card is open (the same batch that
  writes `script.call` writes `stage.start`; `recordOf(...) === null` at
  `agent/runtime/loop/toolUseDispatch.ts:274` is already the test for "first row of this call",
  so "first batch of this activation" is `state.resuming` again).
- `callRequests` re-reads `resumedAttempt(yield* cell.current, at, status)`
  in `nextId` and `open` instead of counting; `reentering`/`opened` go.
- Stages: one writer. Either the trace owns every stage (the loop asks the
  trace for a stage handle whose `start` row rides the batch, as `displayRow`
  does today) or the loop owns the script stage and the turn and run stages
  stop being stages (they are positions: `turn.begin`/`turn.end`/`run.end`
  already say what `Tool-use turn` and `Run:` say). The second deletes
  `stagedBy`, `parentStage` on `RunLaunch` (`agent/runtime/run/AgentRun.ts:103`, read by
  `agent/runtime/RunCall.ts:164` for plugins' nesting), `childRunLoop.stage`, and the
  `stageLabel` column of every child strategy (`agent/runtime/childRunLoop.ts:108`; the
  native strategy's comment at `agent/runtime/nativeSubagentStrategy.ts:94-98` says its
  label is "not used as a trace stage").

**What we give up.** The `Run:` and `Tool-use turn` stage cards in the
transcript, unless the renderer groups by `run.position` rows instead (it has
the rows). A plugin's `parentStage.child(...)` nesting loses its parent and
nests under the call's card instead.

**Change amplification.** "A second kind of activation-scoped fact" (say, the
host that attached) today means a new local in `agent/runtime/loop/toolUse.ts`, a new field on
`OpenStep` or `LiveRun`, and a new fallback in `runRegistry.liveRun`: 3 files.
With one activation record (or the rows), 1.

---

## Finding 2. One yes/no travels through ten steps in six files, and "who may answer it" is stored four ways

**Red flags:** pass-through chain; temporal decomposition; two (four)
representations of one fact; a declarative table with a derivable column;
two mechanisms for one rule.

**Evidence.** A `bash` call that needs a person's answer:

1. The tool declares `guard.command` (`agent/core/tools/ToolTypes.ts:44-64`).
2. `guardedToolCall` → `rejection` (`agent/runtime/loop/toolGuard.ts:152-247`) decodes the
   input a second time, computes `asks`, the prompt text, `cwd`, `operation`,
   and calls `approvals.permission(...)` (`:234`).
3. `sessionPermission` (`agent/runtime/loop/toolGuard.ts:85-107`) reads `OPERATIONS[operation]`
   and `decideApproval` (`shared/approvalPolicy.ts:65-73`).
4. `askCommandApproval` (`agent/runtime/loop/commandApproval.ts:33-64`) builds the
   `request.opened` payload, calls `requests.open(...)`, and wraps it in
   `approvals.enqueue('bash', …, { grant, prompt, bypassed })`. One caller
   (`agent/runtime/loop/toolGuard.ts:238`); the file is 85 lines for that and the refusal text.
5. `sessionApprovals.enqueue` (`agent/runtime/runApprovalQueue.ts:121-126`): a per-run lane,
   and at the head of the lane a second read of `bypass(runId, grant)`.
6. `callRequests.requests.open` (`agent/runtime/loop/toolGuard.ts:284-390`): the re-entry
   protocol, then `sessionRequests.ask(..., { open: rows => ... })`.
7. `requestAsks.ask` (`agent/runtime/requestPolicy.ts:338-384`): builds the row, asks
   `decidedRows` (which for `bash` returns `[]`, `:168-173`), commits, then
   tails the log for the `request.decided` row (`:318-336`).
8. A host reads `view.requests` (`effect/requestAnswerer.ts`,
   `packages/cli/src/runtime/approvalAdapter.ts:150-262`) and sends
   `request.decide`.
9. `controllers/session/SessionRequests.ts:270-283` checks `answerMismatch`, then
   `decideUnderGrant` (`agent/runtime/runApprovalQueue.ts:308-333`) → `setPolicy`
   (`:257-301`) → `requests.decide` → `decisionRow` (`agent/runtime/requestPolicy.ts:303-316`).
10. `approvePendingUnderBypass` (`agent/runtime/runApprovalQueue.ts:214-244`) then approves
    every other pending request of the run that the new grant covers.

Steps 5 and 10 are two mechanisms for one rule, "a grant turned on while a
prompt waits answers it": the lane re-checks the grant at its head
(`enqueue`'s `bypassed` branch, `agent/runtime/runApprovalQueue.ts:123-125`,
`shared/session/sessionApprovals.ts:22-36` documents it), and the policy change walks the
view's open requests and decides each (`:226-234`). Each needs the fact "may a
standing grant answer this request", which is stored:

- as `QueuedApproval.grant` in memory (`shared/session/sessionApprovals.ts:29-31`);
- as `allowBypass` on the request row, computed at four writers from two
  different expressions (`agent/runtime/loop/commandApproval.ts:54` `ask.grant === 'bash'`;
  `tools/approval/toolEditApproval.ts:118`, `agent/runtime/delegation/proposalFlow.ts:191`, `agent/runtime/delegation/AgentTool.ts:226`
  `hook !== 'ask'`), read by `approvePendingUnderBypass` (`:230`) and by two
  hosts (`packages/texra/src/shared/session/surfaceDecision.ts:155`,
  `packages/texra/src/ui/progress/components/BashRequestPanel.ts:33`);
- as `RunCall.hook` laid into the context for the body
  (`agent/runtime/loop/toolGuard.ts:268` `Effect.updateService(RunCall, …)`, read back at
  `tools/approval/toolEditApproval.ts:87`, `agent/runtime/delegation/proposalFlow.ts:166`, `agent/runtime/delegation/AgentTool.ts:226`);
- as the first column of `OPERATIONS` (`agent/runtime/loop/toolGuard.ts:71-77`).

`OPERATIONS` itself: its second column is `'executable'` for three of five
rows and equal to the row's key for the other two, so it is derivable; and
`ApprovalOperation` is spelled a second time as a hand literal union
(`shared/session/sessionApprovals.ts:42-47`) rather than `keyof typeof OPERATIONS`.

The three inputs of `decideApproval` (`policy`, `scopedBypass`, `canPresent`)
are gathered at three sites with three sources: `agent/runtime/loop/toolGuard.ts:92-98` (the
`Interactions` getter and the view), `agent/runtime/requestPolicy.ts:92-104` (the same),
and `liveToolGates` (`agent/runtime/requestPolicy.ts:210-238`), which overlays an unborn
run's `run.start` grants on the view (`withUnborn`) because the step runs
before the opening commits. `runProgram.birthRows` (`:52-74`) computes the
grants a fourth way (`grantsKept`) for a child born detached.

`canPresent` is `!interactions.approvalPromptsUnavailable`, a live getter
(`agent/runtime/HostInteractions.ts:208-210`, `attached ?? opened`), read at the step
(withholds tools), at the guard (denies) and at the ask (denies a question or
retry). A host attaching between the step and the guard changes the answer
mid-call; the step's withheld list is then stale, which is why `agent/runtime/loop/step.ts:380-389`
compares `withheld` with the previous in-memory step to decide whether to warn
again.

**The design decision behind it.** "Who answers this request" was decided as a
pipeline of guards, each refining the previous one's answer, instead of once,
as data, when the request row is written.

**The better design.** The request row is the one record of the question _and
of who may answer it_. `request.opened` carries `answeredBy: 'person' |
ApprovalBypassKind` (today's `allowBypass` generalised, which the schema already
versioned once, `shared/schemas/rowVersions.ts:168`). Then:

- `enqueue`'s head-of-lane bypass check and `approvePendingUnderBypass` become
  one rule in the one place grants change: `Approvals.change` commits the
  `approval.policy` row and, in the same transaction, a `request.decided` for
  every open request whose `answeredBy` the new grant covers. One transaction,
  no lane re-check, no view walk. `QueuedApproval` (3 fields), `enqueue`
  (2 callers), `approvePendingUnderBypass`, the `heldHere` parameter of
  `setPolicy`/`decideUnderGrant` ("a run held elsewhere has no fiber here",
  which O1 deletes anyway) go.
- The per-run prompt lane stays only if hosts cannot show two prompts of one
  run; if they can (the view lists every open request), `lanes` and
  `withPerKeyLane` here go too.
- `agent/runtime/loop/commandApproval.ts` folds into `agent/runtime/loop/toolGuard.ts` (one caller); `OPERATIONS`
  loses its second column (`kind` is the operation, `'executable'` is what a
  host prints for three of them: a host-side table, not a core one).
- `sessionPermission`'s three inputs are read once per request at
  `requestAsks.ask`, where the row is written; `decideApproval` keeps one
  caller. The step's `approvalPromptsUnavailable` input and the
  `withheldForApproval` warning stay (a tool a run cannot ask about should not
  be offered), but they read the same function.
- `RunCall.hook` stays as the hooks' answer (it is a different fact: what a
  plugin said), but `allowBypass`'s four writers become one: the ask computes
  `answeredBy` from `(operation, hook)`.

**What we give up.** A host that relied on `allowBypass`'s exact boolean
renders from `answeredBy !== 'person'` instead (2 sites). A grant turned on
answers _every_ open request it covers, including ones a `PreToolUse` hook
asked about, unless `answeredBy: 'person'` is written for those, which the
ask knows.

**Change amplification.** "A fourth bypass kind" today: `APPROVAL_BYPASS_KINDS`,
`OPERATIONS`, `ApprovalOperation`, `QueuedKind`, `lanes`, the four
`allowBypass` writers, `bypassCovers`, `runBypasses`, and two host tables:
about 9 files. After: the kinds list, `OPERATIONS`, and the host's label
table: 3.

---

## Finding 3. `agent/runtime/loop/hooks.ts` is a seam with six single-caller entry points, a sentinel object for a missing hook, and a parent walk over the view

**Red flags:** shallow interface (six exports, one caller each); sentinel
value as a state; information leakage (a closure bundle whose shape another
module derives with `ReturnType`); a rows-vs-view duplicate the owner already
decided (O9).

**Evidence.**

- Consumers: `openingHooks` → `agent/runtime/loop/toolUse.ts:248`; `promptHooks` →
  `agent/runtime/FollowUps.ts:212`; `stopHooks` → `agent/runtime/loop/toolUse.ts:467`; `preToolUse` →
  `agent/runtime/loop/toolUseDispatch.ts:483`; `callHookText` → `agent/runtime/loop/toolUseDispatch.ts:959`;
  `stepHooks` → `agent/runtime/loop/step.ts:298`. Six exports, six callers, one each. The
  producers of hooks are installed Claude Code plugins only; no in-tree
  plugin ships one.
- `staleHook` (`agent/runtime/loop/hooks.ts:72-93`) parses an identity string back into a
  `ConfiguredHook` with `command: ''`, `timeoutSeconds: 0`, `root: ''` and
  `stale: true`, so that `hooksAt` can branch on `step.stale` (`:205,236`) and
  answer `STALE.denial`. A hook that is gone is modelled as a fake hook with a
  flag: a sentinel standing in for a type (`{ identity, gone: true }`).
- `preToolUse` returns `{ ...pre, fromHook, bodyStarts, after }`
  (`agent/runtime/loop/hooks.ts:451`) with a mutable `startedAt` captured by `bodyStarts` and
  `after`; `agent/runtime/loop/toolGuard.ts:110-113` types its own parameter as
  `Pick<Effect.Success<ReturnType<typeof preToolUse>>, 'outcomes' | 'fromHook'>`.
  The dispatch then threads `bodyStarts` as a callback through
  `guardedToolCall` (`agent/runtime/loop/toolGuard.ts:256-257,267`) so that the intent row is
  committed after the hooks and the guard and before the body, and
  `pre.bodyStarts` is called inside it to start the clock
  (`agent/runtime/loop/toolUseDispatch.ts:499-520`). The write-point ordering the guide states
  (`packages/harness/AGENTS.md:68`, "`tool.intent` ... after hooks, guard and
  approval") is enforced by passing a thunk through three functions.
- `guardedToolCall`'s third and fourth parameters have defaults
  (`agent/runtime/loop/toolGuard.ts:255-257`) and one caller that always passes both
  (`agent/runtime/loop/toolUseDispatch.ts:536`): an option for a caller that does not exist.
- `rootOf` (`agent/runtime/loop/hooks.ts:253-258`) walks `view.run(up)?.parentId` to find the
  session id a hook sees. The owner decided (O9, landed 2026-11-04) that a
  writing job reads the parent edge from the rows (`ancestryRows`,
  `shared/session/runRelation.ts`; `agent/runtime/runApprovalQueue.ts:128-129` does). `agent/runtime/loop/hooks.ts` writes
  `hook.outcome` rows from a value it read off the view. `inputBase` recomputes
  `rootOf` and `workAutoApproved` at every point: once per tool call and
  twice per prompt or stop point (`rootOf` is called again outside it).
- `stopHooks` mixes in the script special case: `stop_hook_active` is
  `run.config.script != null || blocked.some(...)` (`agent/runtime/loop/hooks.ts:359-360`).

**The design decision behind it.** The hooks were bolted onto the loop at its
existing points, one function per point, instead of as one value the step
computes ("the hooks of this step, by event") that the loop's three write
points consult.

**The better design.** `hooksAt` is the deep part and stays. The six exports
become one module-level operation over the step: `stepHooks` returns the
`StepHook[]` and a `run(point, input, names)`; the points are called where
they are today but through that value, so `agent/runtime/loop/toolGuard.ts` no longer types
against `ReturnType<typeof preToolUse>`. The intent ordering is expressed
once in `finishCall` as a sequence (`pre` → `rejection` → `commit(intent)` →
`tool.call(input)`), with `guardedToolCall` returning the rejection or the
final input instead of running the body, so `bodyStarts` and its two defaults
disappear. `staleHook` becomes a `gone: Set<identity>` beside `hooks`, and
`hooksAt` writes the denial outcome for each gone `PreToolUse` identity
without constructing a hook. `rootOf` takes `facts.parent` from
`ancestryRows`, and `inputBase` is computed once per step (it changes only
when the policy or the ancestry does) and stored on `StepTools`.

**What we give up.** Nothing a plugin sees; the protocol and the rows are
unchanged.

**Change amplification.** "A seventh hook event" (say `Notification`) today
touches `SUPPORTED_HOOK_EVENTS`, `common/plugins/hookProtocol.ts`, `agent/runtime/loop/hooks.ts` (a new export)
and the loop file at the new point: 4 files. After: the protocol and the loop
point: 2.

---

## Finding 4. A script run is a model-less run dressed as a tool-use run, and the costume shows in five loop branches

**Red flags:** special and general code mixed; a synthetic row impersonating a
model response; a fact (`handedDown`) that five branches test.

**Evidence.** A background script or a task's recipe runs as a tool-use run
whose one "response" is handed down: `rows.handedDown` (`agent/runtime/loop/rows.ts:184-211`)
writes a `model.message` of kind `'handed-down'` with a `randomUUID()`
`responseId` and the fixed call id `'script'` (`:215`), so that the general
dispatch runs it. That part is the general path doing the special case, which
is right. But the turn and the park then test the special case:

- `turnResponse` (`agent/runtime/loop/toolUse.ts:93-94`): a failed handed-down call's error is
  the reply;
- `completeTurn` (`:278-281`): a handed-down error is outcome `failed`;
- the turn loop (`:313`): a handed-down call asks no model, the turn ends;
- the park (`:417`): `if (state.handedDown !== null) return completeTurn(state)`;
- `deliver` (`agent/runtime/loop/toolUseDispatch.ts:935-936`): a handed-down call ends the turn;
- `stopHooks` (`agent/runtime/loop/hooks.ts:360`): `stop_hook_active` for a script run;
- `prepareAgentDefinition` (`agent/runtime/AgentLaunchContext.ts:126-127`):
  `stopAfterCycle = ... || config.script != null`;
- `RunState.handedDown` is a fold field for it (`shared/session/runFacts.ts:79-81,108,156`).

Beside these, `config.script?.kind === 'recipe'` (`isTrustedScript`) is read
at `agent/runtime/loop/step.ts:217`, `agent/runtime/delegation/proposalFlow.ts:56,167`, `agent/runtime/delegation/AgentTool.ts:359`,
`agent/prompt/templateInputs.ts:163`, `tools/plan/PlanTool.ts:105`, `agent/runtime/forkRun.ts:100`,
`agent/runtime/nativeSubagentStrategy.ts:98`: eight sites decide trust from the kind.

The general rule for ending a turn already exists: a settled call's result with
`endTurn: true` (`agent/runtime/loop/toolUseDispatch.ts:200-201`, `endsTurn`), and the outcome
`failed` already follows a failed result elsewhere (`disposition`,
`shared/session/runFacts.ts:141`). The special branches exist because `endsTurn` requires
`status === 'executed'` and because the model-less run has no text answer.

**The design decision behind it.** A run was defined as "a model in a loop";
a script run has no model, so its one call had to be made to look like a
model's.

**The better design.** Keep the handed-down row (it is one row, and the door's
replay already resumes from rows), delete the fold field and the five branches
by making the two general rules cover it: (a) a `tool.result` may end the turn
whatever its status (`endTurn` on either branch of `SettledToolResultSchema`;
`endsTurn` reads it without the `executed` test), and the `script` tool's
result ends the turn when the run is a script run, decided once in the tool
(it reads `call.run.config.script` as `tools/plan/PlanTool.ts:105` already does); (b)
the fold sets `answer` from the ending call's `output` or `error` when the
response had no text (one rule in `shared/session/runFacts.ts`, replacing `handedDown`).
Then `turnResponse` is `at.answer`, `completeTurn`'s outcome is "failed if the
ending result is an error", and the park branch at `:417` is the ordinary
`stopAfterCycle` exit two lines below it. `stopAfterCycle` for a script is the
launch's decision already (`agent/runtime/AgentLaunchContext.ts:127`); the loop needs no
second reading of `config.script`.

For trust, `isTrustedScript` is one predicate with eight readers; what they
decide (fixed tools, no delegation prompt, activated skills, plan refusal)
are four different facts. A trusted recipe is a _launch_ that grants them:
record the grants once as the run's `approval.policy` goal (the mechanism
`tools/codemode/backgroundScript.ts:56-58,113` already uses for a goal's grants) and the
step's `trusted` branch (`agent/runtime/loop/step.ts:217-220`), `agent/runtime/delegation/proposalFlow.ts:167` and
`agent/runtime/delegation/AgentTool.ts:359` read `bypass(runId, …)` like every other grant.

**What we give up.** `kind: 'recipe'` stays a stored discriminator for the
documents plugin (`packages/texra/src/shared/plugins/documents.ts:269`), so the
field is not deleted, only its in-loop readers.

**Change amplification.** "A third kind of model-less run" (say, a run that
replays a stored response) today: `agent/runtime/loop/rows.ts`, `shared/session/runFacts.ts`, `agent/runtime/loop/toolUse.ts` (3
branches), `agent/runtime/loop/toolUseDispatch.ts`, `agent/runtime/loop/hooks.ts`, `agent/runtime/AgentLaunchContext.ts`: 6 files.
After: the row constructor and the tool that ends the turn: 2.

---

## Finding 5. Service bags: the guide's rule holds for the loop and fails one layer down, where a context is carried as a field

**Red flags:** a captured context re-provided (the Effect rule in root
`AGENTS.md` "Forward a captured context only through `Context.pick`" is met
at the pick and broken at the eighteen re-provisions); two tags for one
object; records that mirror the fiber's context.

**Evidence.** The bags, counted:

| Name                                                                         | Kind                       | Where                                                                                                        | Files  |
| ---------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| `RunServices`                                                                | type union (5 tags)        | `agent/runtime/ToolServices.ts:51-56`                                                                        | 7      |
| `PluginToolServices`                                                         | type union                 | `agent/runtime/ToolServices.ts:67-72`                                                                        | 17     |
| `SessionServices`                                                            | type union (13 tags)       | `agent/runtime/rootLaunch.ts:50-63`                                                                          | 21     |
| `AgentRunServices = RunServices \| SessionServices`                          | type union                 | `agent/runtime/runRegistry.ts:700`                                                                           | 12     |
| `TurnServices`, `ActivationServices`, hooks' `Services`                      | local unions               | `agent/runtime/loop/toolUse.ts:97`, `agent/runtime/loop/runProgram.ts:77`, `agent/runtime/loop/hooks.ts:144` | 1 each |
| `ToolContextShape` (+ `ToolEnv`, `ToolRun` augmented with 8 fields)          | value, `Context.Service`   | `agent/core/tools/ToolTypes.ts:192-226`, `agent/runtime/RunCall.ts:156-166`                                  | 38     |
| `RunCallShape` (10 fields, one of them a `Context.Context<SessionServices>`) | value, `Context.Reference` | `agent/runtime/RunCall.ts:197-243`                                                                           | 21     |
| `ChildRunsShape` (8 doors)                                                   | value, `Context.Reference` | `agent/runtime/ToolServices.ts:84-123`                                                                       | 14     |
| `Dispatch` (7 fields) and `Call` (5)                                         | plain records              | `agent/runtime/loop/toolUseDispatch.ts:129-156`                                                              | 1      |

The guide's "No services bag" (`packages/harness/AGENTS.md:65`) is true of
`runToolUse`: it yields `AgentRun`, `ModelInvoker`, `ModelAccess` from
context. One layer down, `RunCallShape.session` is a services bag by another
name: `sessionServices` picks 13 tags from the dispatch fiber
(`agent/runtime/ToolServices.ts:145-162`) into a value that is then carried on every call
(`agent/runtime/loop/toolUseDispatch.ts:1050,524`) and re-provided or read by tag 18 times
(`Effect.provide(session)` in `tools/ExecutionsTool.ts:349`, `tools/codemode/ScriptTool.ts:196`,
`agent/runtime/ToolServices.ts:179-181`; `Context.get(session, X)` for `Runs` 6, `SessionLog`
5, `Interactions` 5, `SessionRequests` 5, `SessionViewAccess` 5, `SessionRoots`
3, `Approvals` 2, `Inbox` 1). Every one of those fibers already carries the
same tags: the tool body runs inside the dispatch fiber with
`Effect.provide(step.services)` layered on top (`agent/runtime/loop/toolUseDispatch.ts:550`), and
a plugin's layer serves only its own tags. The field exists so that the
_type_ `ITool<Error, PluginToolServices>` never names a session tag (the
fence of the 2026-11-01 note), not because the services are absent.

`ToolContext.env.run` and `RunCall.run` are the same object under two tags
(`agent/runtime/loop/toolUseDispatch.ts:543` and `:523` both pass `run`); `requireToolRun`
spreads both into one record (`agent/runtime/RunCall.ts:283-293`), so `run` arrives twice.
The 2026-11-01 note (owner decision 2) keeps `RunCall` as the door and refuses
putting it on `env`; that is settled. What it did not decide is the width of
the door: its decision 1 names `RunCallShape.runs` (one tag); what shipped is
`RunCallShape.session` (thirteen).

**The design decision behind it.** The public tool type must not require
session services, and that was implemented by smuggling the services as data
rather than by typing the built-ins' requirement.

**The better design.** `RunCallShape.session` becomes `runs: Runs['Service']`
(what decision 1 named) and nothing else; a built-in that needs `SessionLog`
or `Approvals` yields the tag, which is in its fiber. The 18 re-provisions go.
If the fence must keep `SessionServices` out of `R` at the type level, the
honest tool is `Effect.Service`-style erasure at the table (`tools/toolTable.ts`
already casts a plugin's layer to `PluginContext`, `tools/sessionTools.ts:123`):
one cast at the boundary instead of a carried context. `ToolEnv.run`
(`agent/core/tools/ToolTypes.ts:197`, 1 reader at `agent/runtime/RunCall.ts:249`) and the `ToolRun` module
augmentation (`agent/runtime/RunCall.ts:156-166`) become `RunCall.run` alone: plugins that
read `callerRun` (23 sites) read the reference's `run` instead.

**What we give up.** The compile-time guarantee that a plugin's tool cannot
name a session tag moves from the type to the table's cast. The note's fence
count stays zero for the app either way.

**Change amplification.** "A fourteenth session service" today: `SessionServices`,
`sessionServices`'s pick list, and every `Context.get(session, …)` reader of
it: 3 files minimum. After: the union: 1.

---

## Finding 6. The provider schema converter's flattening rule is known by twelve tool input schemas

**Red flags:** information leakage; a declarative shape dictated by a
downstream transformation; a derived column stored with a check to keep it in
step.

**Evidence.**

- `flattenTopLevelUnion` (`agent/core/tools/toolSchema.ts:57-130`) merges a
  union's branches into one object, keeps a property `required` only if every
  branch requires it, and collapses discriminators into an `enum`.
  Consequently twelve tool inputs written as `Schema.Union([...])` must each
  know this: `tools/executions/toolInput.ts:134-136` repeats `path` on every branch "because
  the provider-facing schema flattens this union and keeps a field required
  only if every arm requires it"; `tools/executions/toolInput.ts:27-33` puts
  `nullishWithDefault` on the `view` discriminator because an omitted
  `action` must pick that branch and a provider's explicit `null` must too;
  `schemaLiteralValue` (`agent/core/tools/toolSchema.ts:36-43`) peels the `anyOf`/`null` that
  `nullishWithDefault` wraps a discriminator in; and
  `packages/harness/AGENTS.md:93` writes the rule down for every future union
  ("Union branches tolerate the other branches' keys ... never add a check
  that rejects unknown keys to a branch"). What the model is shown (one flat
  object) is not what is validated (a union), and four places compensate.
- `ToolResultPayload.disposition` (`shared/schemas/runHistoryEvent.ts:407`) is
  four-valued; the schema check at `:411-433` enforces `executed ⇔
  result.status === 'executed'` and `duplicate ⇔ duplicateOf != null`. Two of
  its four values are therefore derivable from fields beside it, and the check
  is the proof that two representations are stored. Readers of `disposition`
  outside its writer: `shared/session/runFacts.ts:141` (`ran = executed || failed`) and
  `:190`.

Not a finding: `nullishWithDefault` (32 uses, 17 files) is a deep helper with
a documented reason (`tools/core/inputSchema.ts:8-21`); `EXECUTION_ROUTES`
(`tools/ExecutionsTool.ts:154-290`) is a table whose columns vary per row;
`RELATION_NOUN`, `HIDDEN_CONFIG_FIELDS_BY_CATEGORY` are two-to-five-row
lookups with no constant column.

**The design decision behind it.** The provider converter decided to flatten
unions silently instead of refusing them, so every union-shaped input adapted
to the flattening.

**The better design.** Write what the model sees: a tool with actions is one
`Schema.Struct` with an `action` enum and the union of fields, each
`Schema.optional(NullOr(...))`, and a per-action requirement check at dispatch
(`Schema.makeFilter` on the struct, or the handler's own `requireField`).
`flattenTopLevelUnion`, `schemaLiteralValue`, the `path`-on-every-branch rule
and the guide's "tolerate" paragraph go; `convertToolSchema` refuses a
top-level union with a clear error at tool definition. The typed
`Extract<Input, { action: A }>` that `RouteRequest` enjoys
(`tools/ExecutionsTool.ts:145-150`) is lost; handlers read their fields from one
struct. For `disposition`: store `skipped: boolean` (the one fact not
derivable) or nothing (a skipped call is an error result with no `tool.intent`
at its attempt, which the rows show), and derive the rest.

**What we give up.** Branch-typed handlers; and a `Union` is the natural way to
express "this field exists only for `wait`". Twelve files change; the
flattening code is 75 lines. This is a candidate the owner may refuse on
typing grounds; the leak is real either way.

**Change amplification.** "A sixth executions action" today: `tools/executions/toolInput.ts`
(a branch with `path` repeated), `EXECUTION_ROUTES`, and a re-read of the
flattening rule: 2 files plus a rule. After: the enum and the route: 2 files,
no rule.

---

## Finding 7. A background command's output is smuggled through the human log, its stop is a fabricated exit code, and `wait` re-derives `working`

**Red flags:** two representations of one fact (output; stop); information
leakage (a magic data key and a level-to-stream mapping known by writer and
reader); special and general mixed (a general trace channel filtered three
ways to recover command output); a derived predicate the view already carries.

**Evidence.**

- Output. A background `bash` writes each chunk as a trace `log` row at level
  `info` (stdout) or `warn` (stderr), tagged
  `data.backgroundBashOutputSource` (`tools/bash.ts:258-271`,
  `shared/toolUse.ts:175-194`), capped at 200k chars, and _also_ keeps a
  head/tail capture in memory for the delivery excerpt (`tools/bash.ts:247-256`,
  `:274-282`). `/executions/{id}/output` recovers the output by filtering rows
  with `type === 'log'`, level not `debug`, `messageType` default, then
  re-joining chunks by the tag and, for untagged rows, mapping
  `warn|error → stderr` (`tools/executions/processOutput.ts:59-108`).
  stderr lines render as warnings in every transcript (`tools/bash.ts:270`), and a
  progress bar on stderr is a stream of warnings. The command's stdout and
  stderr, as bytes, are a first-class row nowhere.
- Exit. The exit code and `success` reach rows twice: `buildResultMeta` →
  `run.result` (`tools/bash.ts:328-338`) and the delivery text. A stop produces
  `interruptedTurn()` = `{ exitCode: 130, stderr: 'Command aborted by user',
  success: false }` (`bash.ts:303-309`; 4 consumers of `interruptedTurn`), a
  synthetic turn so that the general "turn result" path can write a record
  for a run that was interrupted. O3 says a stop is the fiber's interruption
  and nothing else; a fabricated 130 is a second representation of "stopped".
- Delivery. The parent hears the end as one follow-up with a 1,000-char
  head/tail excerpt (`BACKGROUND_OUTPUT_HEAD_CHARS`, `tools/bash.ts:61`), which the
  comment at `tools/executions/processOutput.ts:110-120` calls "the only route readable while
  the command runs".
- Wait. `shouldSkipWait` (`tools/executions/waitCoordination.ts:23-45`)
  combines `runs.get(runId) === undefined` (the in-process registry), the
  view's `status` with `'ready' → RUNNING`, `isInFlightPhase`, and the
  special case "a subagent in WAITING is delivered". The view already carries
  `working: Schema.Boolean` (`shared/session/sessionView.ts:159`, O6, landed).
  `awaitStatusChange` (`tools/ExecutionsTool.ts:96-125`) then tails
  `SessionViewAccess.changes` and compares a joined string of statuses to
  detect a change. The harness has six `isInFlightPhase`/`isActivePhase`
  readers outside `shared/runs/runStatus.ts`; this is one of the two in tools.

**The design decision behind it.** A background command was modelled as "a
child run whose trace is its terminal", so its output became log lines and
its result a child turn; nothing was modelled as the command's own record.

**The better design.** A process child's output is its own row kind,
`process.output { stream: 'stdout' | 'stderr', text }`, on the child run's
aggregate, written by the one strategy and read by the one projection; the
trace log keeps its lifecycle lines. The in-memory head/tail capture goes:
the delivery excerpt is projected from the rows (first N and last N chars of
the output rows, one query). The exit is `run.end` with `error` and a
`process.exit { code, signal }` row when the process ended; a stop writes no
exit row (the interruption is the fact), and the delivery says "stopped"
from `run.end`'s reason (O2). `interruptedTurn` and the `cli?: undefined`
/ `interruptedTurn?: undefined` optional-field union in `ProcessChildStrategy`
(`agent/runtime/childRunLoop.ts:160-192`) go. `shouldSkipWait` becomes
`view.runs.get(id)?.working !== true`, one expression, and
`tools/executions/waitCoordination.ts` (45 lines, 42% comments) is deleted;
`awaitStatusChange` waits on `SubscriptionRef.changes` filtered by that
predicate instead of a joined status string.

**What we give up.** The transcript's live view of command output today comes
free from the log channel; a new row kind needs the transcript renderer to
show `process.output` rows (one case in `rowCodec`/the transcript model). The
200k cap stays as the writer's.

**Change amplification.** "A second kind of process child's output" (an agent
CLI's structured events) today: `shared/toolUse.ts` (a new key), the strategy,
`tools/executions/processOutput.ts`'s filter, and the renderer: 4 files. After: the row kind
and the renderer: 2.

---

## Finding 8. `HostInteractions` is an all-optional interface over a hand-rolled sliding queue, with a side channel (`approvalDenied`) beside the rows

**Red flags:** shallow module (every member optional); reinvented primitive
(bounded queue with replay); a second event surface the guide forbids
(`packages/harness/AGENTS.md:75` "no new subscribe surface"); a `Proxy` to set
one boolean.

**Evidence.**

- `HostInteractions` (`agent/runtime/HostInteractions.ts:45-72`): `emit?`,
  `approvalPromptsUnavailable?`, `approvalDenied?`, `dispose?`. Every member
  optional means every caller writes `?.` and every fact about the host is
  "unknown" by default.
- `SessionHostInteractions` (`:118-281`) keeps `attached`, `opened`, a
  `pendingPresentationReplays: PresentationProgram[]` capped at 256 with
  drop-oldest (`:36,241-255`) and a `replayPendingPresentations` loop
  (`:257-280`). That is `Queue.sliding(256)` consumed by a fiber per attached
  host, written by hand with four logged failure paths.
- `approvalDenied` is fire-and-forget, called from `agent/runtime/requestPolicy.ts:189`,
  `agent/runtime/loop/toolGuard.ts:103` and `agent/runtime/loop/step.ts:388`, not a row. For a request it duplicates
  the `request.decided` row written beside it (`agent/runtime/requestPolicy.ts:181-198`);
  for the guard's deny and the withheld tools it is the only record, and the
  CLI dedups it by a string key (`packages/cli/src/runtime/approval/approvalPrompts.ts:157-158`)
  because the step may say it again. `ApprovalPolicyDenial` (6 files) is
  spelled a second time as a Schema in
  `packages/texra/src/controllers/server/hostCalls.ts:62,77`.
- `requestAnswerer.overlay` (`effect/requestAnswerer.ts:218-233`) wraps the
  host in a `Proxy` to answer `approvalPromptsUnavailable: false` when the
  host has `approve`. `canPresent` is thus: `host.approve !== undefined` →
  Proxy → getter → `attached ?? opened` → three readers (finding 2).
- `presentTerminalResult` (`:305-317`) reads `self.includes(end.origin)`;
  slice 3 deletes `event.origin`'s reader with the claims (settled).

**The design decision behind it.** The host was given a method to be _told_
things, instead of the session recording them and the host _reading_ them,
which is the pattern every other fact follows (rows, view).

**The better design.** `approvalDenied` becomes a row: a `request.decided` with
a reason already exists for requests; the guard's deny already becomes a
`tool.result`; the step's withheld set becomes a field of the `tools.offered`
row (`withheld: string[]`), which the view projects and hosts render once per
change, no dedup. `ApprovalPolicyDenial` and its host schema copy go.
`approvalPromptsUnavailable` becomes a plain boolean the host passes at
attach (it is "a fact about the host alone", `:57-62`), stored on the
session's `Interactions` as `canPresent: boolean`, no Proxy, no getter. The
replay queue is `Queue.sliding<PresentationProgram>(256)` drained by
`Effect.forkScoped` on attach; `emit` is `Queue.offer`. `HostInteractions`
then has two members, both required: `emit` and `canPresent`.

**What we give up.** A host that attaches late sees withheld-tool notices as
view state, not as a toast replayed on attach; the toast for a denied request
is already derivable from the row.

**Change amplification.** "A host adds a surface" (a fourth host) today
implements four optional members and the `approvalDenied` switch
(`packages/cli/src/runtime/approval/approvalPrompts.ts:108-119`): 2 files in the host plus `packages/texra/src/controllers/server/hostCalls.ts`'s
schema. After: `emit` and a boolean.

---

## Finding 9. `openStep` has one caller and seven positional parameters, three of which the caller derives from a mode

**Red flags:** overexposure (a mode parameter, `'request' | 'dispatch' |
'park'`); a general path run and its output discarded; a previous-step
comparison held in memory.

**Evidence.** `stepFor(run, state, kind, isChild, openingSystem)`
(`agent/runtime/loop/step.ts:442-463`) computes `held`, then calls `openStep` with
`held ? state.offeredTools : null`, `held && kind === 'park'`, `isChild`,
`openingSystem`, `held && kind === 'dispatch' ? state.offeredWith.hooks : null`
(`:453-461`): three arguments that are functions of `(open, kind)`. `openStep`
has that one caller. For `kind === 'dispatch'` the full step runs (pin,
resolve, skills catalog, delegation targets, system text, blob rows) and the
rows are thrown away (`:462` `{ ...step, rows: [] }`), and the `withheld`
warning compares with `previous?.withheld` held in `run.steps` (`:380-382`)
rather than with what the rows recorded. The 35-line module header
(`:1-34`) describes the hand-over-hand pin, the freeze, the held record and
the description cache in prose.

The 2026-11-01 note kept the four step records and refused a mechanical split
of `resolveStepTools`; this finding is not that. It is the entry's signature.

**The better design.** Two entries that name what they do: `openStep(run,
state)` for a request or a park (held to the record iff `state.resuming`,
finding 1), returning tools and rows; and `dispatchStep(run, state)` for a
resumed pending response, which pins and resolves against
`state.offeredTools`/`offeredWith.hooks` and never computes system text or
rows. `isChild` is `run.entry.parent !== null`, already on `run`;
`openingSystem` is a field of the opening (finding 1). The withheld warning
compares with `state.offeredWith` (add `withheld` to the `tools.offered`
payload, finding 8) so a resume warns the same way a live run does.

**What we give up.** Some shared lines between the two entries (the pin and
`resolveStepTools` call), which a file-local helper keeps.

---

## Finding 10. The script door reinvents a FIFO lane scheduler with three `Deferred` maps

**Red flags:** reinvented Effect primitive (ordering by `Deferred` per
sequence number); a scheduler written inline in a 230-line function.

**Evidence.** `scriptDoor` (`agent/runtime/loop/toolUseDispatch.ts:674-902`) builds `places`
(a `Deferred` per `seq`, `:703,713,718`), `barrier`/`since` (`:704-716`), a
`Semaphore` window (`:706`), `handed` (`:692-699`) with the `replay` list, and
`inLane` (`:708-733`) to make calls take lanes in issue order, barrier calls
wait for everything before them, parallel calls wait for the last barrier and
share the window, and `own` calls wait for the last barrier only. The
`delivered` door (`:899-900`) lets the sandbox release the next replayed
result. This is a read-write lock with FIFO admission and a replay prefix:
barrier = write, parallel = read, own = "after the last write".

**The better design.** Admission in issue order is the sandbox's: it issues
`seq` in order already (`ScriptOp.seq`), so a single `Semaphore.make(MAX)`
where a barrier takes `MAX` permits and a parallel call takes one gives the
same exclusion if admission is FIFO. The refuted candidate
`EFF-ADOPT-per-key-lane-semaphore` records that Effect 4's `Semaphore` joins
its queue one evaluation after the decision, so FIFO under a yield is not
guaranteed; that ruling was about `withPerKeyLane`, whose callers do not
issue in order. Here the issuer does, so the risk is narrower, but it must be
checked against `node_modules/effect` before the Deferred maps are deleted.
`own` lanes need the last barrier's completion, which is one `Ref<Deferred>`
rather than `since[]`. The replay prefix (`handedBack`) stays; it is a real
protocol with the sandbox. Honest verdict: worth a measured attempt, not a
certain win.

---

## Finding 11. Smaller items, batched

- **`callRequests` takes eight positional arguments** (`agent/runtime/loop/toolGuard.ts:284-301`)
  and has two callers; the second (`agent/runtime/loop/toolUseDispatch.ts:746-755`) builds the
  whole door to call `retireStanding` once. The re-entry protocol (which id a
  resumed call reuses, which standing request is retired) is known by
  `callRequests`, `resumedAttempt`, `requestAsks.ask`'s `options.open`
  callback (`agent/runtime/requestPolicy.ts:345-355`, a callback parameter with two shapes)
  and `SessionRequests.decisionRow`. With finding 1's "read the rows each
  time", `callRequests(run, cell, at)` is three arguments and `retireStanding`
  is a free function over `(cell, at)`.
- **`sessionDescription`**: a `Deferred<void> opened` is threaded through
  `buildAgentLaunchContext` and `enterRun` (`agent/runtime/executeAgent.ts:150-160,262-290`)
  so that `settleDescriptionOnExit` (`agent/runtime/sessionDescription.ts:207-222`) can ask
  `Deferred.isDone(opened)`; `activationIfOpened` uses `Deferred.isDoneUnsafe`
  (`agent/runtime/AgentLaunchContext.ts:55`). "The run opened" is `cell.opened` /
  the `run.start` row. Fork the description inside the loop after `enter`
  returns the cell (`agent/runtime/loop/toolUse.ts:394-403`), in the run's scope, and the
  Deferred and the exit-time join/interrupt logic go; the row then lands
  before `run.end` because the scope closes before the end is written.
- **`Call.title?` and `Call.opensStage?`** (`agent/runtime/loop/toolUseDispatch.ts:150-156`) and
  `finishCall`'s `place: { script, scriptCalls }` with exactly two shapes
  (`{ null, door }` or `{ scope, null }`, `:1062,851`): a two-case union
  spelled as two nullable fields and two optional ones. `'scriptCallId' in
  fact` (`:159-160`) is the third spelling of "this call is a script's".
  One `origin: { kind: 'response', door } | { kind: 'script', scope, title }`.
- **`RunLabels`** (`agent/runtime/sessionDescription.ts:87-90`) is a boolean reference
  that is "an option": the app's process layer sets it, the SDK does not. It
  is documented and host-level; fine as it is.

---

## Good modules in this area

- `shared/session/inFlight.ts`'s `resumedAttempt` / `callRequestId` (the brief's GOOD
  example) is used correctly by `finishCall` (`agent/runtime/loop/toolUseDispatch.ts:433-448`);
  the fault in finding 1.6 is the caller copying its output into counters.
- `defineTool` (`tools/core/definition.ts:79-155`): one entry, validates,
  runs, normalises every failure kind into a model-readable result and lets
  interruption and storage refusals through. Deep; the whole tool corpus
  writes against it.
- `nullishWithDefault` (`tools/core/inputSchema.ts`): one helper, 32 uses, the
  provider rule encoded once.
- `hooksAt` (`agent/runtime/loop/hooks.ts:177-250`): one function records a point's outcomes as
  rows and reuses them on resume; the rest of the file is thin wrappers over
  it (finding 3 keeps it).
- `commit` in the dispatch (`agent/runtime/loop/toolUseDispatch.ts:256-291`): every row of a call
  goes through one function that adds the `script.call` and stage rows the
  batch needs; the per-call program never writes elsewhere.
- `requestAsks.ask` + `decisionRow` (`agent/runtime/requestPolicy.ts:287-387`): one writer of
  `request.opened`, one of `request.decided`, the decision read from the log's
  tail. The layers above it (finding 2) are the problem, not this.
- `resolveStepTools` (`agent/runtime/agentToolResolution.ts:111-324`): one policy, read top
  to bottom, with warnings as data; the 2026-11-01 note's refusal to split it
  stands.
- `EXECUTION_ROUTES` (`tools/ExecutionsTool.ts:154-290`): the description, the
  "unknown path" error and the "not valid here" error all render from one
  table.

## Already settled, left alone

- `RunCall` as a `Context.Reference` door, not a slot on `ToolContext.env`;
  one tool type; the three catalog lifetimes; the four step records; no
  `builtins/` fence yet: owner decisions 1–4 of
  `.agents/docs/implemented/architecture/2026-11-01-tool-layer-one-catalog-one-step.md`
  (#14513). Finding 5 proposes narrowing the door's payload, not moving it.
- `ToolRegistry` separate from `ToolCatalog`, `ToolCatalog` separate from
  `ToolCatalogOwner`, `ProcessCatalog` kept: the same note's "Refused
  alternatives" with its evidence. Not re-proposed.
- The hooks protocol as Claude Code's, out of process, typed at the edge:
  `.agents/docs/implemented/architecture/2026-09-28-code-plugins-hooks-v1.md`.
  Finding 3 keeps the protocol and the rows.
- The script's stage opening "in the first batch its calls commit in an
  activation" and closing "in the batch that records its result":
  `packages/harness/AGENTS.md:77`. Finding 1.5 keeps the rows and questions
  only the closure flag that decides "first batch".
- The write points and "every fact the loop branches on is a row field":
  `packages/harness/AGENTS.md:68`. Finding 4 applies that rule to
  `handedDown` rather than disputing it.
- `withPerKeyLane` over a `Semaphore` for the per-key lanes:
  `.agents/docs/refuted-candidates.json` `EFF-ADOPT-per-key-lane-semaphore`.
  Finding 10 names the ruling and the narrower condition under which the
  script door differs.
- The `event.origin` / `self` read in `presentTerminalResult` and `heldHere`
  in `setPolicy` / `decideUnderGrant`: deleted by O1's slice 3; not counted
  here.
- `ChildRuns.parent` reads rows (`agent/runtime/ToolServices.ts:185-189`): O9 landed; the
  remaining view walk is `agent/runtime/loop/hooks.ts:253-258` (finding 3).
