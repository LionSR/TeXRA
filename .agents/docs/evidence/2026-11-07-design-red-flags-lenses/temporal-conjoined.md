# Lens: temporal decomposition and conjoined code (ch. 5, 9)

Read at HEAD `9c54678` (branch `claude/optimistic-albattani-9ntdac`; its source
tree is merge base `7cad8b1`, the docs commits since `03c2f51` touch no
source). Checked against `origin/main` `eee74bf` (#14794 and #14795 merged
since): of the files cited below only
`packages/extension/src/progressView/extensionHostRequests.ts` differs, and
its one cited line is given at main's number. Open PRs at reading time:
#14796 (documents revision record), #14797 (tooling), #14741 (blob link
kinds), #14773 (held). None of them touches a file a finding below rewrites.

Paths are `packages/<pkg>/src/...` unless they start with something else.
Every Effect API named was checked in `node_modules/effect` 4.1.2 `.d.ts`
(table at the end).

## Numbers

Function and method definitions named for a moment (`grep` of
`const|function <prefix>[A-Z]` over `packages/*/src`): `open*` 83, `close*`
18, `stop*` 16, `start*` 14, `prepare*` 13, `init*` 13, `after*` 13, `post*`
11, `end*` 11, `finish*` 7, `setup*` 5, `pre*` 2, `finalize*` 2,
`complete*` 2, `before*` 2, `teardown*` 1, `begin*` 1. Most `open*` and
`post*` are host verbs (open a file, post a message), not phases; the
`prepare*` in llm's four protocol modules are the `Model.prepareTurn`
contract (settled, below). Read in full: every `prepare*`, `finish*`,
`finalize*`, `after*`, `before*`, `begin*` and every class or closure that
returns `{ open, close }`, `{ start, stop }`, `{ init, dispose }` or a
teardown method.

Lifetime primitives per package (`Effect.acquireRelease|acquireUseRelease` /
`Effect.addFinalizer|Scope.addFinalizer` / `Effect.ensuring` /
`Effect.onExit` / `Scope.make()|makeUnsafe()`):

| Package   | acquire | finalizer | ensuring | onExit | hand-made scope |
| --------- | ------- | --------- | -------- | ------ | --------------- |
| harness   | 24      | 12        | 18       | 6      | 3               |
| texra     | 8       | 14        | 11       | 5      | 6               |
| llm       | 6       | 2         | 4        | 1      | 0               |
| cli       | 11      | 9         | 13       | 4      | 7               |
| extension | 8       | 7         | 3        | 1      | 4               |
| desktop   | 7       | 9         | 5        | 0      | 5               |

The repo mostly writes a lifetime as one primitive: `RunRegistry.start(runId,
{ open, run })`, `acquireRelease` around listeners and temp directories, and
ordered finalizers on one shutdown scope. The lens found **few** instances
the area audits missed: six findings and four batched items. The worst
shapes are where a teardown is a method someone must remember to call
(`initialize`/`dispose`, `releaseUploads`, `shutdown`, `failOpen`,
`entered`) or where a batch caller must sequence a module's phases itself
(`prepareBuildDisplay` + `scheduleViewerDisplay`).

Teardown or second-phase calls made by hand in the findings below:
`entered` 3 sites, `failOpen` 2, `HostDraftRequests.shutdown` 2 (one a
no-op), `ProgressViewProvider.initialize` 1, `releaseUploads` 1,
`scheduleViewerDisplay` 2, `compaction.settle` 1 (through a callback),
`Fiber.pollUnsafe` 3 (all in `compaction.ts`).

Comment share of the files the findings rewrite: `agent/runtime/run/AgentRun.ts`
38% (126/328), `latexdiffCommands.ts` 27% (35/126), `agentCliShared.ts` 27%
(79/288), `uploadCache.ts` 26% (66/246), `openBuild.ts` 25% (86/341),
`executeAgent.ts` 25% (99/388). In the first four, the comments explain the
hand-off between phases.

---

## Finding 1. Showing a built PDF is two phases, and the one batch caller must sequence them around LaTeX Workshop's current document

**Red flags:** temporal decomposition (`prepare*` then `schedule*`, split by
when the viewer may open); conjoined modules (`latexdiffCommands.ts` cannot
be read without `openBuild.ts`'s rule about the argument-free viewer); an
option for a special case (`scheduleViewer`, one caller, always `false`); a
return value no caller reads, documented as if one did.

**Evidence.**

- `extension/src/frontend/latex/openBuild.ts` exports three entry points over
  one operation: `openBuildDisplayIfTex` (`:125-143`, prepare, then await the
  viewer), `prepareBuildDisplay` (`:156-185`, prepare, then optionally fork
  the viewer) and `scheduleViewerDisplay` (`:322-341`, the viewer alone). The
  phases share `prepareFileForDisplay` (`:200-239`), which answers a
  two-kind result (`PrepareFileForDisplayResult`, `:196-198`) so that the
  next phase knows whether to run.
- `prepareBuildDisplay`'s doc states the protocol (`:145-155`): "Set
  `scheduleViewer: false` to prepare several files sequentially … then run
  `scheduleViewerDisplay` once after the final file so LaTeX Workshop's
  current document/root is the intended viewer target (#10553)."
  `prepareBuildDisplay` has 1 caller (`commands/latex/latexdiffCommands.ts:42`),
  which passes `scheduleViewer: false`; the default branch (`:173-182`) has
  no caller.
- The batch caller then re-implements the rest of the operation
  (`latexdiffCommands.ts:84-126`): two `let`s (`lastViewerLocation`,
  `lastProcessedLocation`, `:88-89`), a third (`viewerTargetReady`, `:106`),
  a restore of the last viewer-ready file (`restorePreparedViewerTarget`,
  `:56-71`, which re-opens the editor so the argument-free
  `latex-workshop.view` acts on it), and its own `Effect.forkScoped(scheduleViewerDisplay)`
  (`:118-120`). It also checks the file exists (`:29-35`) before
  `prepareFileForDisplay` checks it again (`openBuild.ts:213-218`).
- `openBuildDisplayIfTex` documents its boolean as "so presentation callers
  can report non-delivery truthfully" (`:114-117`). Both callers discard it:
  `frontend/events/agentEventListeners.ts:242-245` (`Effect.asVoid`) and
  `frontend/approval/VscodeToolEditApprovalHost.ts:42-46` (`Effect.asVoid`,
  typed `BuildDisplayFn`, which returns `void`, `texra/src/tools/latex/latexPreview.ts:43-46`).

Consumers: `openBuildDisplayIfTex` 2, `prepareBuildDisplay` 1,
`scheduleViewerDisplay` 2 (1 outside `openBuild.ts`), `openLatexdiffs` 1
(`progressView/extensionHostRequests.ts:358` on main).

**The design decision behind it.** "Which PDF does the argument-free viewer
open?" is LaTeX Workshop's ambient state (its current document). The module
that knows this, `openBuild.ts`, exposes the phases around that state and
leaves the ordering to whoever shows more than one file.

**The better design.** One `Effect.fn` in `openBuild.ts` owns the whole
operation: `openBuilt(roots, locations: readonly [FileLocation, ...FileLocation[]], { preserveFocus })`
returning `Effect<void, DisplayFailure, PreparedFileServices | Scope>`. It
shows and builds each file in order; under `Effect.onExit`, it re-opens the
last viewer-ready file if a later one replaced it as the current document,
then forks the viewer once with `Effect.forkScoped` in the caller's scope.
The single-file callers write `openBuilt(roots, [location])`, and the
latexdiff verb writes `openBuilt(roots, diffs)`.

Deleted: `prepareBuildDisplay` and its `scheduleViewer` option,
`openBuildDisplayIfTex`'s boolean and the doc at `:110-124`,
`PrepareFileForDisplayResult`, the `scheduleViewerDisplay` export,
`openLatexdiffResult` (`latexdiffCommands.ts:22-47`) with its duplicate
existence check, `restorePreparedViewerTarget` (it moves inside), and the
three `let`s. About 60 lines across the two files.

**What we give up.** The single-file path stops waiting the 5 s viewer delay
(`LATEX_VIEWER_OPEN_DELAY_MS`) before its presentation event returns. No
caller reads that wait. A failed viewer open is still logged at warn.

**Change amplification.** "A fourth surface shows several built PDFs (a
document task's compiled outputs)": today a fourth file re-implements
`latexdiffCommands.ts:84-126` (prepare with the flag, track the last
viewer-ready file, restore it, fork the viewer once). After: one call.

**Depends on:** none.

---

## Finding 2. The extension's progress view is built in its constructor, wired to its owner in `initialize()`, and torn down by a `dispose` only `initialize` registers

**Red flags:** temporal decomposition (construct / initialize / dispose);
"call X first" (nothing tears the view down unless `initialize()` runs after
`new`); a forward reference into a field the constructor assigns later; a
second release beside a scope's (`HostDraftRequests.shutdown`).

**Evidence.**

- `extension/src/progressView/ProgressViewProvider.ts:108` holds its own
  `Scope.makeUnsafe()`. The constructor (`:142-302`) fills it through five
  synchronous runs: `runtime.runSync` at `:161` (the recorder), `:221` (the
  whole GUI window, `openGuiWindow`), `:298` (the attention follower), and
  `:367` and `:374` (the workspace watchers, via `watchWorkspace()` at
  `:301`).
- The scope's close is registered only by `initialize` (`:304-339`), as a
  finalizer of the caller's scope (`:309-311`: `Effect.addFinalizer(() =>
  withProcessServices(this.runtime, this.dispose()))`). `initialize` also
  starts a follower and runs the first refresh. Its one caller
  (`extension/src/extension.ts:472-490`) must call it after `new` and after
  the `forkScoped` at `:483-487`. An activation that fails between the two
  never closes the view's scope.
- `launcher: () => this.runValidated` (`:287`) reads a field the
  constructor assigns ten lines later (`:297`) from the value it is still
  building. A comment explains the order (`:285-286`).
- `dispose` (`:696-708`) closes the surfaces' scopes, then `this.scope`,
  then calls `this.draftRequests.shutdown`. The recorder was made in
  `this.scope` (`:161-163`), and `FiberHandle.make` is an `acquireRelease`
  whose release interrupts and awaits its fiber (`effect/dist/FiberHandle.js:107-114`).
  So the scope's close has already stopped the take, and `shutdown`
  (`FiberHandle.clear`, `texra/src/controllers/session/hostDraftRequests.ts:152-155`)
  then hits a closed handle, where `clear` is `Effect.void`
  (`FiberHandle.js:386-389`). The desktop calls `shutdown` as its own
  shutdown finalizer (`desktop/src/main/index.ts:123-126`), because it made
  the recorder in `processScope` (`:92-94`), which closes later than the
  recording should stop.

Consumers: `ProgressViewProvider` constructed once; `initialize` 1;
`HostDraftRequests.shutdown` 2 (extension, a no-op; desktop).

**The design decision behind it.** VS Code wants a class for
`WebviewViewProvider`, and the class was given the lifetime as well: it
allocates in its constructor, outside any caller's scope, and hands the
close back to the caller as a second call.

**The better design.** `ProgressViewProvider.make` is one `Effect.fn` that
builds every part in the caller's scope (the activation scope it already
runs in): the recorder (`HostDraftRequests.make`), `openGuiWindow`, the
followers with `Effect.forkScoped`, and the VS Code listeners with
`Effect.acquireRelease`. It then constructs the class over the built parts,
as `HostDraftRequests.make` already does (`hostDraftRequests.ts:59-67`).
The launcher reference stays local to `make`, as a `Deferred` the window's
host reads (the pattern `extension.ts:471` already uses for the settings
view). Each surface's scope is a `Scope.fork` of the view's. The recorder's
early stop on the desktop is the close of a `Scope.fork(shutdownScope)`
taken where `shutdown` is registered today, so the shutdown order stays the
same.

Deleted: `this.scope`, the five `runSync`s, `initialize`, `dispose`,
`HostDraftRequests.shutdown` (2 callers), and the order comments at `:285-286`
and `:693-695`.

**What we give up.** Nothing. Risk: `resolveWebviewView` is a synchronous
VS Code callback and still runs its `attach` with `runSync` (`:457`). That
is a host boundary, which is fine.

**Change amplification.** "The view gains a per-window resource (a second
watcher)": today a `runSync` into `this.scope` in the constructor, kept
correct only by `initialize` running later. After: one `yield*` in `make`.

**Depends on:** none. In B's files; R8's second half does not touch it.

---

## Finding 3. A model attempt is opened, consumed and finished by three functions over a mutable record, and both callers repeat the sequence

**Red flags:** temporal decomposition (`openTrace` / `eventSink` /
`finishAttempt`); conjoined functions (one writes a mutable record the
other reads); a seven-parameter tail; an open handle closed by hand on every
failure path. Round 1 found the record's two writers (D3, D8 "one mutable
record, two writers"). This lens adds the sequence those writers sit in.

**Evidence.** In `harness/src/agent/runtime/ModelInvoker.ts`:

- `openTrace` (`:251-256`) opens two deferred `StreamHandle`s. `eventSink`
  (`:265-312`) writes `completed.streamedText` (`:303-305`) and
  `completed.value` (`:309`) on an `AttemptOutcome` it is handed.
  `submitAndObserve` (`agent/runtime/run/backgroundTurn.ts:113-131`) is
  handed the same record and writes `completed.value` (`:131`).
  `finishAttempt` (`:320-407`, seven positional parameters `:321-327`) reads
  it and closes the handles: `finalize` on the stream-failure path
  (`:334-335`), the empty-turn path (`:354-355`) and the success path
  (`:370-371`).
- Both attempt kinds write the same six-line opening and the same closing:
  `attemptOnce` (`:480-506`: `openTrace()`, `Clock.currentTimeMillis`, a
  fresh `{ value: null, streamedText: '' }`, `eventSink(...)`,
  `Effect.exit(stream)`, `finishAttempt(7 args)`) and `observeAccepted`
  (`:534-556`, the same sequence over `observeBackground`).

**The design decision behind it.** "What one attempt's events leave behind"
is computed by mutation during the stream, so the stream, the sink and the
tail must be called together in this order, and each caller writes the
order out.

**The better design.** One `Effect.fn('ModelInvoker.consume')(cell,
invocation, bound, events)` owns the attempt from the first event to the
`response` row. Inside it:

1. The two handles are acquired with `Effect.acquireRelease`, released by
   finalizing them. `finalize` is idempotent (`agent/trace/TraceEmitter.ts:275`),
   so the success path still finalizes with the turn's text and the release
   is a no-op after it.
2. The events fold with `Stream.runFoldEffect(events, () => ({ value: null,
   streamedText: '' }), step)`, where `step` appends the `identified` row
   and streams deltas as `eventSink` does, returning the next accumulator.
3. The body of `finishAttempt` runs over the fold's `Exit`.

`attemptOnce` passes `bound.model.streamTurn(resolved)` or the background
stream, and `observeAccepted` passes `observeBackground(...)`. For the
submit path, D3's own fix (`submit`'s completed result fed as a
`{ kind: 'completed' }` event) is what lets `submitAndObserve` stop taking
`completed`.

Deleted: the mutable `AttemptOutcome` writes (3 sites in 2 files),
`openTrace` as a helper, the duplicated opening (2 sites), four failure-path
`finalize` calls, and `finishAttempt`'s parameter list from 7 to 4.

**What we give up.** Nothing. The accumulator copies the 4 KB-bounded tail
per delta, as the mutation does now.

**Change amplification.** "A third source of an attempt's events (resuming
a streamed background operation by its stream id)": today the six-line
opening and the seven-argument tail a third time. After: one call with its
stream.

**Depends on:** D3's submit-as-event half, unclaimed in round 1 and now
package E's R24 (round-3 plan, "Strategic, not tactical"). The foreground
and observe paths can land alone. `attemptStarts` (D8) goes with E's R2 PR
in the same file.

---

## Finding 4. Background compaction is four entry points named for the loop's moments over a polled `let`, and the model switch must settle it through a callback

**Red flags:** temporal decomposition (`atBoundary`, `finish`, `settle`,
`afterOverflow`); conjoined modules (`loop/modelSwitch.ts` takes
`beforeSwap` only so that `run/compaction.ts` can settle first); a
reinvented primitive (`pollUnsafe` ×3, and an interrupt-then-poll-again
race, where `Fiber.interrupt` then `Fiber.await` returns the final exit).

**Evidence.** In `harness/src/agent/runtime/run/compaction.ts`:

- `BackgroundCompaction` (`:269-293`) documents each method by when the
  loop calls it: "At a request boundary", "At the end of a turn", "Before
  another edit of the view", "After a request the window could not hold".
  Its state is one closure `let pending: { base, fiber } | null`
  (`:301-304`), set at `:371` and cleared at `:313` and `:341`.
- `settle` (`:326-346`) polls the fiber (`:333`), interrupts it (`:336`),
  then polls again because "It may have finished as the interrupt landed"
  (`:337-340`). `atBoundary` polls a third time (`:363`). `landPending`
  (`:307-324`), `finish` (`:383-386`) and `settle` are three forms of "land
  the pending summary": always, after waiting, and if done (else cut).
- The loop calls the object at five sites in `loop/toolUse.ts`: it creates
  it at `:277-282` and calls it at `:318`, `:370`, `:401` and `:466`. The
  call at `:318` goes through `applyPendingModelSwitch(cell, (at) =>
  compaction.settle(at, 'the model is switching'), …)`, whose `beforeSwap`
  parameter (`loop/modelSwitch.ts:26-28, 54`) has exactly that one shape
  and that one caller. The reason is the binding: the summary's call runs
  on the binding the switch's `ScopedRef.set` closes.

**The design decision behind it.** The summary in flight is a value the
loop's moments must each account for, so the module exposes one method per
moment, and the one precondition other code must honour (settle before a
rebind) travels as a callback.

**The better design.** The summary in flight is one fiber that completes
its own `Deferred` (`Deferred.into`), with its `base` carried in its
result.

- "Land if done" reads `Deferred.isDone`. "Land, waiting" is
  `Deferred.await`. "Cut, keeping a summary that finished first" is
  `Fiber.interrupt` then `Fiber.await`: the exit is the summary's when it
  finished before the interrupt, so the second poll goes.
- `settle`, `finish` and `landPending` become one `land(cell, { cut })`.
  `atBoundary` keeps the threshold start and the `/compact` branch, and
  `afterOverflow` stays (it decides whether the turn fails).
- `applyPendingModelSwitch` takes the compaction value and calls
  `land(cell, { cut: true })` itself, so the reason is stated where the
  binding is replaced, and the `beforeSwap` callback goes.

Deleted: 3 `pollUnsafe`, `landPending`, two of the four methods, the
`beforeSwap` parameter, and 4 writes of `pending`.

**What we give up.** Nothing. The gain is modest: the loop still calls
compaction at its boundaries, which is where the decisions are.

**Change amplification.** "Another operation must not run under a summary
in flight (a fork cut mid-turn)": today a second external caller of
`settle` with a `why` string, or a fifth method. After: one `land` call.

**Depends on:** none. In the run loop's files (package E's area).

---

## Finding 5. A fresh run's trace is held by three closures over two `let`s, and three call sites must pair `opening` and `entered` in order

**Red flags:** conjoined functions (`opening` sets `carried`, which
`entered` reads); a sequence every caller repeats; comments substituting
for design; a false comment.

**Evidence.**

- `enterRun` (`harness/src/agent/runtime/executeAgent.ts:94-147`) builds a
  `TraceEmitter` whose sink pushes into `held` until `entered` sets it to
  `null` (`:115-118`). `opening` (`:121-128`) takes the events up to the
  first stream as drafts and records how many it took in `carried`
  (`:120, 123-124`). `entered` (`:129-133`) publishes the events after
  `carried` and stops holding. The protocol is explained twice: at
  `:88-93`, and in `LaunchEntry`'s doc (`agent/runtime/run/AgentRun.ts:63-71`).
- Every entry into a run's cell must pass `opening` as the batch's
  alongside, tap `entered` after it, and mask both:
  `loop/toolUse.ts:183-185` (a fork) and `:253-255` (a fresh run) write
  `cell.append(rows, run.entry.opening).pipe(Effect.tap(run.entry.entered),
  Effect.uninterruptible)`, and `loop/runProgram.ts:118-125` (a resume)
  writes `.pipe(Effect.tap((cell) => resume ? run.entry.entered(cell.opened)
  : Effect.void), Effect.uninterruptible)`. A fourth entry that forgot
  `entered` would hold the run's trace forever, with no error.
- `entered: (state: RunState) => Effect.Effect<void>` (`AgentRun.ts:85`) is
  documented "Fails when a fresh run's claim, its birth's, cannot be held"
  (`:84`). That is false: its error channel is `never`, and the
  implementation is `() => Effect.sync(...)` (`executeAgent.ts:129-133`).
  It ignores the `state` it is typed to take. The comment survives from the
  claims that R1 deleted.

**The design decision behind it.** "A fresh run's first trace events commit
in its opening batch, and the rest publish after it" is one rule, split into
a before-commit half and an after-commit half that the module hands to
three callers.

**The better design.** `enterRun` returns one combinator in place of the
two members: `enter: <A, E, R>(commit: (alongside: Alongside) => Effect<A, E, R>) => Effect<A, E, R>`.
It is `commit(opening).pipe(Effect.tap(entered), Effect.uninterruptible)`,
with `held` and `carried` local to it. The three sites write
`run.entry.enter((alongside) => cell.append(rows, alongside))` and, for a
resume, `run.entry.enter(() => runHistory.open(...))`.

Deleted: `LaunchEntry.opening` and `.entered` (3 consumers), the unused
`state` parameter, the false comment, and three repetitions of
`Effect.uninterruptible`.

**What we give up.** Nothing.

**Change amplification.** "A fourth way into a run (a run born from a
template's stored rows)": today it must know three facts: pass the
alongside, tap `entered`, mask. Forgetting the second loses the trace
silently. After: one call.

**Depends on:** none. Compatible with round 1's C8 (one `opening` effect for
`RunHistory.open`), which would be the commit this wraps.

---

## Finding 6. The upload cache's end of life is a method on the public `Model`, which the one binder must remember to call

**Red flags:** temporal decomposition (`uploadFile` now, `releaseUploads`
at the end, wired in another file); overexposure (a teardown on a public
interface); a release flag (`released`) beside the scope that already
bounds the binding.

**Evidence.**

- `Model.uploadFile?` and `Model.releaseUploads?` (`llm/src/turn.ts:460-466`)
  are on the public interface, with the exported `UnreleasedUpload`
  (`turn.ts:441-445`, `llm/src/index.ts:44`, `config/api-reports/llm.api.md`).
- `filesApiUploads` (`llm/src/api/uploadCache.ts:84-245`) is a plain
  function. Its `releaseUploads` (`:198-243`) sets `released` (`:148, 199`),
  which `uploadFile` reads (`:170, 179`). The two protocol models pass it
  through (`api/anthropicMessages.ts:592, 670-671`;
  `api/openaiResponses.ts:76, 355-356`).
- `bindModel` adds the finalizer (`llm/src/node.ts:205-218`). Its 1
  production caller reads `releaseUploads` off the model it just built,
  although `construct` already runs in the binding's scope (`node.ts:131-137`
  returns `Effect<Model, ModelError, Scope.Scope>`, and the WebSocket model
  uses that scope).

**The design decision behind it.** The cache's acquisition and release were
put in different modules: the protocol model creates the cache, and the
binder ends it through the interface the harness also sees.

**The better design.** `filesApiUploads` is `Effect.acquireRelease` in the
binding's scope: the release deletes the uploads and logs what it could
not delete (today's `node.ts:207-216`). The two protocol constructors
become `Effect.fn`s, as `openaiResponsesWebSocketModel` already is.

Deleted: `Model.releaseUploads?`, the `UnreleasedUpload` export (0
consumers outside llm), `bindModel`'s 13-line finalizer block, and the two
pass-through lines in each model. `released` stays as a guard for an upload
called after the scope closed.

**What we give up.** An embedder that built a `Model` by hand could release
its uploads early. There is no such caller, and an embedder closes the
binding's scope instead.

**Change amplification.** "Google's files endpoint gains uploads": today it
returns `releaseUploads` on its model and relies on `bindModel` reading it
(2 files). After: it builds the cache in its scope (1 file).

**Depends on:** none. In llm (R3-E's package by the round-3 table).

---

## Finding 7. Batched: smaller instances, each one PR-sized

- **The agent-CLI tool cards are opened in a driver and torn down by an
  `ensuring` each driver writes.** `StreamedToolCards`
  (`texra/src/tools/agentCli/agentCliShared.ts:32-79`) says the fail-if-open
  teardown "lives in one place" (`:36-39`), yet its `failOpen` is "Call once
  when the turn tears down" (`:74`). Both drivers call it by hand:
  `claudeAgent.ts:197-198, 259-264` (with `ClaudeBackgroundTaskTracker.finish()`,
  `claudeAgentBackgroundTasks.ts:53-57`) and `codex.ts:205, 295-300` (with a
  `let turnCard` and `finalizeTurnCard('failed')`, `:212-227`). Better:
  `StreamedToolCards.scoped(logger)` and the tracker as `Effect.acquireRelease`
  (release = `failOpen` / `finish`) in the turn's scope (codex already ends
  in `Effect.scoped`, `:301`), and the Codex turn card as one keyed card of
  the set. Deleted: 2 `ensuring` blocks, `turnCard`, and
  `finalizeTurnCard`'s teardown branch. Owner: H's package.
- **`prepareWorkflowInputExpansion` / `finishWorkflowInputExpansion`**
  (`cli/src/runtime/workflowInputs.ts:216-244, 246-281`) split one
  expansion so that every `--input` and `--context` spec is checked before
  stdin is read. The two run in a fixed order in their one caller
  (`:325-349`), joined by `PreparedWorkflowInputExpansion` (`:70-73`), which
  carries `flagLabel` from one to the other. Better: `expandRunInputs`
  expands both flags' specs in one `Effect.forEach`, then reads stdin once
  if any spec is `-` (at most one flag may name it, `:313-321`), then
  assembles. Deleted: the record type and the two names. Owner: K's package.
- **A root run's description is forked in one file and settled in
  another.** `executeAgent.ts:343-353` forks it, `:378` wraps the flow in
  `settleDescriptionOnExit(fiber)` (`agent/runtime/sessionDescription.ts:207-220`:
  join, or interrupt on a cancel), and `:382` adds `Effect.ensuring(Fiber.await(...))`
  as a backstop. Better: one `withSessionDescription(spec)(flow)` in
  `sessionDescription.ts`, as `Effect.acquireUseRelease(Effect.forkChild(generate),
  () => flow, (fiber, exit) => cancelled(exit) ? Fiber.interrupt(fiber) :
  Fiber.join(fiber))`. The release runs on every exit, so the backstop's
  stated reason (a generator `finally` skipped after a failed `yield*`) does
  not apply. Verify that against a stop test before deleting it. Owner: E.
- **The settings panel's ready hand-off is split between the show method
  and the message listener.** `SettingsViewProvider` holds `_view?`,
  `viewListeners?`, `viewReady` and `pendingTab?` for one panel
  (`extension/src/settingsView/SettingsViewProvider.ts:22-30`).
  `showSettingsView` stores the tab when the panel is not ready (`:103-107`),
  and the `WEBVIEW_READY` handler sets `viewReady` and posts the stored tab
  (`:137-143`). Better: per panel, a `Scope` and a `Latch`. Ready opens the
  latch, and a tab request is `Latch.whenOpen(ready)(postTab)` forked in the
  panel's scope (latest wins through `FiberHandle.run`). Deleted:
  `viewReady` and `pendingTab`. Owner: B.

## Found by rounds 1 to 3; this lens's angle only

Temporal decomposition already reported, not repeated: A1 and A5 (the child
loop's nine-step turn, gone with R5), B1 (the session assembled by time;
R8's second half), C8 (registration, activation and end drafts in three
modules), D5 (the binding's renewal), E2 (one yes/no through ten steps),
G8 (the settings body's post-then-follow), H2 (a polling tick's staged
cache), I1 (the revision record, in #14796), J9, K5 (the chat's exit), N3
(the onboarding funnel wired twice), O1 (the route decided in three steps)
and O4. The run's birth and death across ten modules were named before
round 1 (`.agents/docs/evidence/2026-10-30-harness-design-against-pi-durable-and-deepseek/texra.md:68`)
and are what R2 to R5 replaced. The only new angle on them is Finding 5's
held trace, which those roots did not touch.

## Good modules for this lens

- `RunRegistry.start(runId, { open, run })` (used by
  `agent/runtime/processRun.ts:198-201`): the open-in-the-caller /
  run-on-the-fork split is one call that owns its order, so no caller can
  run `run` without `open`. Finding 5's `enter` copies it.
- `whilePrompting` (`cli/src/runtime/approval/approvalPrompts.ts:34-42`):
  a host hook that returns its own release, wrapped once in
  `Effect.acquireUseRelease`.
- `HostDraftRequests.attach` (`hostDraftRequests.ts:84-93`) and
  `materializeStdinWorkflowInput` (`workflowInputs.ts:96-127`): the acquire
  and its release are in one expression.
- Desktop's shutdown (`desktop/src/main/index.ts:104-132`): one scope, with
  finalizers registered in the reverse of the order they must run, and the
  order stated once.
- `supervisedSpawner` (`harness/src/platform/defaults/nodePlatform.ts:203-235`):
  the process `exit` listener is `acquireRelease`d with the layer.

## Already settled, left alone

- **`executeAgent`'s two phases** (the opening in the caller's fiber, the
  run on the registry's fork, with a hand-made `Scope` handed across): the
  lifecycle contract in `packages/harness/AGENTS.md` "Run loop
  architecture". The same holds for `openToolUse` / `runToolUse` and for
  the run loop's write points.
- **`Model.prepareTurn` then `streamTurn`/`submit`**
  (`llm/src/turn.ts:449-452`): the split exists so that the `attempt` row
  commits the resolved turn before the billed request leaves (the
  write-point contract). `callModel` (`agent/runtime/run/modelCall.ts:63-68`)
  pays the two calls without a row, a cost of one line.
- **The extension's module-level `activationScope`**
  (`extension/src/extension.ts:99-102, 295-325, 615-619`): VS Code's
  `activate` and `deactivate` are two host callbacks, and one `Scope`
  between them is the minimal bridge.
- **`sessionLayer`'s `rootLanes` around `openSession`/`closeSession`**:
  settled by round 1 (B, "Already settled": a close holding the entry for
  its budget while an open lands).
- **The code sandbox's `begin` / `settle`**
  (`harness/src/agent/codeSandbox/worker.ts:97-102`): a coroutine's first
  step and its resumption, not an operation split by time.
- **The TUI's `suspend` / `resume`** (`cli/src/tui/terminalCleanup.ts:71-121`):
  SIGTSTP and SIGCONT are two OS events.
- **`modelAccessChanged` emitted after each model-access write** (4 CLI
  sites, 1 listener, `cli/src/chat/tui/panes/StatusBar.tsx:61`): a write and
  its announcement are two calls. But `packages/harness/AGENTS.md`
  "Configuration, storage, and workspace files" rules out a config
  change-notification API, and the signal is within `AppSignals`'
  documented scope.
- **citty's `setup` / `run`** (`cli/src/commands/_helpers/defineCliCommand.ts:44-48`):
  the framework's lifecycle.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

| Finding | Today                                                                                                      | Effect-native                                                                                                                     | `.d.ts` (4.1.2)                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `prepareBuildDisplay` + `scheduleViewer:false` + caller's restore and fork                                 | one `Effect.fn`; restore under `Effect.onExit`; viewer `Effect.forkScoped` once                                                   | `Effect.fn` Effect.d.ts:18880; `Effect.onExit` :13262; `Effect.forkScoped` :17216                                                                                                                              |
| 2       | constructor `runSync`s into `Scope.makeUnsafe()`; `initialize` registers `dispose`; `shutdown` after close | `static make` as `Effect.fn` in the caller's scope; listeners `Effect.acquireRelease`; surfaces `Scope.fork`; launcher `Deferred` | `Effect.acquireRelease` Effect.d.ts:12676; `Effect.forkScoped` :17216; `Scope.fork` Scope.d.ts:493; `Deferred.make` Deferred.d.ts:152; `FiberHandle.make` (release interrupts and awaits) FiberHandle.d.ts:110 |
| 3       | `openTrace` / `eventSink` / `finishAttempt` over a mutable record                                          | handles `Effect.acquireRelease`; events `Stream.runFoldEffect`; tail over `Effect.exit`                                           | `Effect.acquireRelease` Effect.d.ts:12676; `Stream.runFoldEffect` Stream.d.ts:15821; `Effect.exit` Effect.d.ts:3648; `Stream.make` Stream.d.ts:648 (D3's completed event)                                      |
| 4       | `let pending` + `pollUnsafe` ×3 + interrupt-then-poll                                                      | the summary fiber completes a `Deferred`; `Deferred.isDone` / `Deferred.await`; cut = `Fiber.interrupt` then `Fiber.await`        | `Deferred.into` Deferred.d.ts:1642; `Deferred.isDone` :1324; `Deferred.await` :153; `Fiber.interrupt` Fiber.d.ts:355; `Fiber.await` :177; `Effect.forkIn` Effect.d.ts:17126                                    |
| 5       | `opening` and `entered` closures paired at 3 sites                                                         | one combinator `enter(commit)` = `commit(opening)` + `Effect.tap(entered)` + `Effect.uninterruptible`                             | `Effect.uninterruptible` Effect.d.ts:14415; `Effect.fn` :18880                                                                                                                                                 |
| 6       | `Model.releaseUploads?` called by `bindModel`'s finalizer                                                  | `filesApiUploads` as `Effect.acquireRelease` in the binding's scope                                                               | `Effect.acquireRelease` Effect.d.ts:12676; `Effect.addFinalizer` :12852 (what it replaces)                                                                                                                     |
| 7a      | `new StreamedToolCards` + hand `ensuring(failOpen)` ×2                                                     | `Effect.acquireRelease` in the turn's `Effect.scoped`                                                                             | Effect.d.ts:12676; `Effect.scoped` :12567; `Effect.ensuring` :12892 (what it replaces)                                                                                                                         |
| 7c      | fork + `settleDescriptionOnExit` + `ensuring(Fiber.await)`                                                 | `Effect.acquireUseRelease(forkChild, use, release(fiber, exit))`                                                                  | `Effect.acquireUseRelease` Effect.d.ts:12804; `Effect.forkChild` :17089; `Fiber.join` Fiber.d.ts:288                                                                                                           |
| 7d      | `viewReady` + `pendingTab`                                                                                 | per-panel `Latch`; `Latch.whenOpen`; latest wins by `FiberHandle.run`                                                             | `Latch.make` Latch.d.ts:189; `Latch.open` :209; `Latch.whenOpen` :351; `FiberHandle.run` FiberHandle.d.ts:542                                                                                                  |

There is no `Layer.scoped` in 4.1.2. None of the designs above needs a
layer; where one would, `Layer.effect` (Layer.d.ts:1166) provides a `Scope`
to its program.
