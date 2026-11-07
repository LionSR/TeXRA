# K. The CLI: design red flags in `packages/cli/src`

Area: `packages/cli/src/` except what round 1's F report and the CLI-service
note found (the chat's run claim F1, the approval surface F2, the CLI as a
third host-request handler F3, `CliRunReads` F4 (gone), the exit-code writers
and the headless shutdown race F5, the NDJSON drainer F6, the reset-hook
singletons and `runningTasks` F7; the service's lifetime, wire, windows and
attach, `linkCliService`, `taskAttach.ts`, `commands/service.ts`,
`runtime/cliService.ts`). Read-only, at the working tree of 2026-11-06, every
line cited read. Paths are relative to `packages/cli/src` unless they start
with `packages/`. Consumer counts are `grep -rn '\bSYMBOL\b' packages/*/src`
(production) and `src/test-kernel packages/*/test` (tests).

## Numbers

Lines by directory (45,907 total): `runtime/` 11,741 (60 files; `approval/`
495, `history/` 119), `chat/` 24,895 (`chatSessionController.ts` 1,074;
`chat/tui/` root files 2,497, `panes/` 6,322, `forms/` 3,962, `commands/`
2,852, `state/` 2,555, `modals/` 2,078, `render/` 1,695, `input/` 1,486,
`hosts/` 253), `commands/` 6,841 (`_helpers/` 1,735), `tui/` 1,738
(`ui/` 1,002), `schemas/` 287, `init/` 229, `bin/` 109, `onboarding/` 42,
`config/` 33.

Five largest files: `chat/chatSessionController.ts` 1,074;
`chat/tui/panes/statusBarDisplay.ts` 958; `chat/tui/panes/staticTranscriptRing.ts`
770; `chat/tui/runChatTui.tsx` 751; `chat/tui/App.tsx` 658.

Comment share of the worst five files of 200+ lines (`^\s*(/\*|\*|//)` over
total): `runtime/cliProcessRuntime.ts` 50% (114/226),
`commands/_helpers/defineCliCommand.ts` 47% (100/209),
`runtime/initPlatform.ts` 39% (165/414), `chat/tui/sessionExitController.ts`
33% (119/352), `chat/tui/state/sessionRunState.ts` 30% (84/279, F1). Next:
`runtime/cliConfig.ts` 27%, `chat/tui/state/approvalQueue.ts` 27% (F2),
`runtime/logSinks.ts` 26%, `runtime/updateChecker.ts` 25%,
`chat/tui/commands/slashRegistry.ts` 25%, `runtime/executeCli.ts` 25% (F5).
The three bootstrap files together carry 379 comment lines explaining when a
runtime exists, who may join it and what refuses in its place (finding 4).

Primitives: `new Promise` 0; `.then(` 0; `Deferred.*` 30 refs/6 files (13 of
them `makeUnsafe`, 5 `doneUnsafe`, 3 `isDoneUnsafe`); `uninterruptible*` 9/4;
`addObserver` 3/3; `interruptUnsafe` 8/5; `Effect.never` 2/2; `Scope.makeUnsafe`
2/2; `Semaphore.makeUnsafe` 3/3; `Effect.run*` 5/5 (the pinned edges);
`queueMicrotask` 2/2; `setTimeout` 4/2; one real `setInterval` (the shared
clock); `Date.now` 8/5; hand-rolled once-flags (`let settled|echoed|persisted|
released|disposed|resolved|seen = false`) 10/8; module-level `let` state
16/13 files; `registerCliStateResetHook` 10/5 (F7); `process.exit` 4 call
sites in one file (met); `runtime.runSync/runFork/runPromise` 8 in
`runChatTui.tsx` and 6 in `chatSessionController.ts`; `FiberHandle` 3/1,
`FiberSet` 4/1, `Stream.*` 38/15, `useSignal(` 44/12, `useLayoutEffect` 11/5.

---

## Finding 1. "What the terminal already shows" is held as three epochs, a render key, a scan cursor and an equivalence oracle across four modules

**Red flags:** reinvented primitive (three generation counters); information
leakage (the repaint protocol known by five files); a renderer compensating
for its own double print; comments substituting for design (nine- and
thirteen-line comments explaining ordering).

**Evidence.**

- The ring's state carries two counters beside its items:
  `repaintEpoch` ("incremented whenever items change non-append-only ... so
  the `<Static>` identity remounts", `chat/tui/panes/staticTranscriptRing.ts:43-46`)
  and `eraseRequest` ("the last `staticTranscriptEraseEpoch` the state was
  rebuilt for", `:47-50`). `advanceStaticTranscriptState` (`:616-770`) bumps
  the first on an erase (`:648-650`), a hard reset (`:653`), a non-append
  scan (`:711-713`), a header insert (`:723-728`) and a trim (`:746-751`),
  and compares the second to the signal.
- A third and fourth counter live in `chat/tui/state/staticTranscriptRepaint.ts:10,22`
  (`staticTranscriptRepaintEpoch` for SIGCONT, `staticTranscriptEraseEpoch`
  for `/clear`), with the file's comments (`:1-6`, `:16-21`) explaining why
  one is not enough: "an erase must re-emit the transcript even when the
  rebuilt state matches the current items".
- The component folds them into a key: `ConversationRegion.tsx:99-100`
  builds `${ownerKey}:${repaint}`, `StaticConversationTranscript.tsx:240`
  appends `:${state.repaintEpoch}`, `:252` keys `<Static>` on
  `${renderKey}:${width}:${repaintEpoch}`, and `:242-248` fires
  `onRenderKeyChange` from a `useLayoutEffect` when the key moved. The state
  is advanced and `setState` called during render (`:230-238`).
- `onRenderKeyChange` reaches `chat/tui/render/tuiViewportController.ts:122-145`,
  which, when the Ink instance is not yet set, re-enters the epoch through
  `queueMicrotask(invalidateStaticTranscriptForRepaint)` (`:136-141`), with
  thirteen lines (`:123-135`) explaining the cycle and a "defensive only"
  guard against looping forever (`:137-139`).
- The hard-reset branch (`staticTranscriptRing.ts:652-672`) rebuilds, then
  compares the rebuilt items to the current ones with
  `staticTranscriptItemsEquivalent` (`:451-473`, which compares `SessionMeta`
  field by field because `patchSessionMeta` always spreads a fresh object)
  so as not to bump the epoch, because a bump during Ink's initial render
  "would replay the session header through Ink's append-only static write
  ... doubling the header" (`:654-663`). A dedup at render time for a
  double print the render caused.
- `/clear` erases the terminal outside Ink and then bumps the erase epoch
  with a six-line comment on why (`runChatTui.tsx:540-547`); SIGCONT bumps
  the other (`sessionExitController.ts:317-320`); `appLayout.ts:284-291`
  keeps `ownerKey` at `'root'` "so Ink's append-only `<Static>` cache does
  not remount". Consumers: `repaintEpoch` 15 refs/2 files,
  `staticTranscriptRepaintEpoch` 4/2, `staticTranscriptEraseEpoch` 5/3,
  `invalidateStaticTranscriptForRepaint` 4/2, `notifyStaticTranscriptErased`
  3/2, `onRenderKeyChange` 8/5, `onStaticTranscriptChange` 6/3.

**The design decision behind it.** "From which origin must the scrollback
be repainted, and what has been printed since?" has no owner: the ring
knows the items, the region knows the owner key, two signals know two of
the reasons, the viewport controller knows the Ink instance, and the
component derives the fourth fact (the Ink key) from all of them.

**The better design.** The primitive that IS the thing: one
`SubscriptionRef<Scrollback>` per chat, made in the chat's scope
(`SubscriptionRef.make`, Effect 4.1.2 `SubscriptionRef.d.ts:93`), holding
`{ origin: number, ownerKey, width, items, totals, printedThrough }`. The
printer (`chat/tui/panes/scrollback.ts`) is two programs over that ref:
`advance(source)` (`SubscriptionRef.update`: append the settled delta; keeps
the ring budget and the `StaticTranscriptTotalsAccumulator`) and
`restart(reason: 'clear' | 'resume' | 'owner' | 'width' | 'reorder')`, which
increments `origin` in the same update. The one repaint is a forked
`Stream.runForEach(SubscriptionRef.changes(ref).pipe(Stream.changesWith((a, b)
=> a.origin === b.origin)), repaint)` in the chat scope, built after
`render()` returns the instance (`runChatTui.tsx:617-666` already assigns
`inkRef.current` synchronously, so the microtask re-entry has no case). The
component subscribes to the ref through one `useStream` hook (the mapping
section) and renders `<Static key={origin}>` over `items`, nothing else; the
initial state is the ref's initial value (no "advance from empty" on the
first render, so no equivalence oracle). Deleted:
`repaintEpoch`, `eraseRequest`, both signals in `staticTranscriptRepaint.ts`
(26 lines), `invalidateStaticTranscriptForRepaint`, `notifyStaticTranscriptErased`,
the `renderKey`/`onRenderKeyChange` props (5 files), `tuiViewportController.ts`
(66 lines), `staticTranscriptItemsEquivalent`, the `queueMicrotask`
re-entry, and about sixty comment lines. Kept: the ring budgets and their
accumulator, the width in the `<Static>` key (the vendored Ink patch's
resize path, `texra-cli` skill).

**What we give up.** The belt-and-braces re-invalidation for an instance set
late, which the code already calls defensive. Risk: none user-visible; the
SKILL's rules (no reprint except from a known origin, dedupe by the row's
id) hold by construction, since the printer is the only writer.

**Change amplification.** A fourth reason to repaint from a known origin
(say, a theme change): today `staticTranscriptRepaint.ts` (a third epoch or a
reuse), `staticTranscriptRing.ts` (a branch of `advance`),
`StaticConversationTranscript.tsx` (read the signal, key),
`ConversationRegion.tsx` (key), `tuiViewportController.ts` (a method) and the
caller = 6 files; after: `restart('theme')` at the caller = 1.

**Depends on:** none.

---

## Finding 2. The TUI prints the fold's settled prefix in a second order and keeps an oracle and an incremental scan to detect when the two disagree

**Red flags:** two representations of one fact (the print order); a renderer
compensating for the data model; special and general code mixed (the
incremental path with a full-rebuild fallback).

**Evidence.**

- The fold defines the prefix as print order: "`settledRows`, the contiguous
  leading prefix of settled rows: an append-only scrollback prints rows in
  order, so a row is settled for printing only once every row before it is"
  (`packages/harness/src/shared/session/sessionViewUpdate.ts:586-590`);
  `settlementSeqNo` is "order in which the source row became printable"
  (`packages/harness/src/shared/transcript/transcriptRow.ts:56`), handed out
  at settle time (`transcriptState.ts:306,313`).
- The TUI re-sorts that prefix by `settlementSeqNo`:
  `chat/tui/panes/transcriptEntries.ts:177-183` (`transcriptOrderKey`:
  `settlementSeqNo ?? seqNo ?? index + 1`, local-after-source tiebreak),
  `:197-214` (`inSettlementOrder`, "used identically by the append-only scan
  and its rebuild oracle so the two paths can never disagree"), `:229-249`
  (`orderedStaticTranscriptEntries`, which "skips the O(n log n) sort
  whenever the filtered slice is already ordered", `:224-227`: the sort is
  a no-op on all but "the rare reorder").
- The incremental scan carries a five-field cursor (`:295-309`: `entriesRef`,
  `scannedIndex`, `lastScannedEntry`, `working`, `lastAppendedKey`) and
  returns `rebuild: true` when "a suffix whose first row belongs before rows
  an earlier tick already printed cannot be appended at all" (`:410-425`);
  the ring then rebuilds through the oracle (`staticTranscriptRing.ts:711-713`).
- The pane's own comment says the fold already prevents the reorder the sort
  guards: "Tool entries defer finalization until the stream itself finalizes
  — promoting them earlier would let a fast tool jump ahead of still-streaming
  assistant text in `<Static>` scrollback, where insertion order is fixed"
  (`transcriptEntries.ts:255-258`).
- Local notices are already placed by index: `mergeLocalNotices`
  (`chat/tui/state/transcript.ts:170-201`) splices a notice after the last row
  at or below its `afterSeq` and stamps `seqNo`/`settlementSeqNo` on it
  (`:188-192`) only so the TUI's sort keeps it where the merge put it.

**The design decision behind it.** "In what order does the scrollback print
settled rows?" is answered by the fold (index order within `settledRows`)
and again by the TUI (settlement order), and the TUI keeps machinery to
notice when its answer differs from the fold's.

**The better design.** The fold's answer survives; the primitive is finding
1's `SubscriptionRef<Scrollback>` (no new one). The printer of finding 1
prints `rows.slice(printedThrough, settledRows)` filtered by
`isRenderableTranscriptEntry` (the `ROW_KIND_IS_WIDGET` table stays) and the
`userPromptAwaitsLiveContinuation` rule (a presentation choice over the
source's `working`, not a cursor field). The cursor is `{ entriesRef,
printedThrough }`: a different array identity or a shorter array restarts
from a known origin (`restart('reorder')`). Deleted: `transcriptOrderKey`,
`compareTranscriptOrderKeys`, `inSettlementOrder`, the sort in
`orderedStaticTranscriptEntries` (it becomes a filter), `lastAppendedKey`,
`lastScannedEntry`, `working` on the cursor, `restartScan`'s second cause,
the `seqNo`/`settlementSeqNo` stamping of notices (the merge's index is the
order). Consumers: `orderedStaticTranscriptEntries` 7 refs/2 files,
`incrementalStaticTranscriptEntries` 6/2.

**What we give up.** A defence against a fold that settles out of index
order. If the fold ever did, `settledRows` would be wrong by its own
definition and the fix belongs there (one owner); the TUI's sort would
only hide it. Risk: a settled row whose `settlementSeqNo` is lower than its
predecessor's today prints in a different place after; the pane's comment
says this does not occur.

**Change amplification.** "The fold replaces settled rows" (a compaction
block cleanup): today `restartScan`, the oracle rebuild, `plan.rebuild` and
`advanceStaticTranscriptState`'s branch = 4 sites in 2 files; after: the
array-identity check = 1.

**Depends on:** finding 1 (shares the cursor); can land alone as a smaller
cut.

---

## Finding 3. The user's typed message has five homes between the input and the run

**Red flags:** state machine in optional fields and sentinels (a once-flag, a
clear epoch, a module `let`); two (four) representations of "what rides
with a line"; information leakage (the attachment chip grammar re-parsed
from submitted text).

**Evidence.**

1. In the composer: `InputBar.tsx:126` `useState('')`, `:129` `draftValueRef`,
   `:133-135` `historyBrowseRef`, `:141` `attachmentsRef` (`DraftAttachmentStore`),
   `:166-168` `imagePasteQueueRef`; `handleSubmit` (`:290-330`) expands text
   chips, resolves images, writes history, clears, and calls
   `onSubmit(trimmed, mediaFiles, images, holdUntil)`, four positionals
   declared again in `App.tsx:112-117` and consumed in `runChatTui.tsx:622-627`.
2. Before a model is connected: `chat/tui/modelConnection.ts:57` `let
   heldMessage` ("the latest wins", `:64-74` `holdUntilConnected`, which also
   opens `/login`), sent later by `connectChatModel` through a `send`
   callback (`:146-149`) that `runChatTui.tsx:555-564` threads in as
   `registerBuiltinSlashCommands.onAccountChanged`. A third shape,
   `HeldMessage` (`:48-52`).
3. In the controller: `MessageSettlement { sent, undelivered }`
   (`chatSessionController.ts:241-246`), a `settled` once-flag (`:965-982`),
   `Effect.ensuring(message.undelivered())` as "if not sent, give back"
   (`:1029`), a fourth shape `ChatAttachments` (`:193-197`).
4. Skill activations: a `Map` and a clear epoch on the controller
   (`:308-309`), taken into a `<user_request>` wrapper at submit
   (`:254-278`), restored on an undelivered message only if the epoch did
   not move (`:952-963`), bumped by `clearPendingSkills` (`:1069-1072`).
5. On the way back: `draftRestoreRequest`, a queue signal with
   `requestDraftRestore`/`takeDraftRestoreRequests` (`cliState.ts:331-352`,
   a fifth shape `DraftRestoreRequest`), drained by an `InputBar` effect
   (`:213-248`) that rebuilds image chips by matching `[Image #N]` in the
   submitted text (`:228-244`) — the grammar `draftAttachments.ts:106`
   (`CHIP_RE`) owns, known by a second module.

Consumers: `pendingSkillActivations` 11 refs/1 file, `clearPendingSkills`
3/2, `draftRestoreRequest` 8/2, `requestDraftRestore` 3/2,
`takeDraftRestoreRequests` 3/2, `MessageSettlement` 3/1, `holdUntilConnected`
2 files. `ChatSessionCallFailed` (`:103-109`, 3/1) exists only to carry a
selection failure's message through `toErrorMessage`.

**The design decision behind it.** "Where is the message right now, and what
goes with it?" is answered at each hand-off with a new shape, because the
draft is React state the controller cannot hold, so each stage copies what
it needs and each failure path rebuilds the copy it lost.

**The better design.** One `Draft` value in a `SubscriptionRef<Draft>`
owned by the composer (`cliState.ts`, where the `texra-cli` skill puts view
state): `{ text, attachments: the store's entries, skills: SkillActivation[],
holdUntil? }`. Submit hands the value to `controller.submit(draft):
Effect<'sent' | Draft>`, run through the existing `FiberSet` (`sending`,
`chatSessionController.ts:854-856`); a returned draft is `SubscriptionRef.set`
back by the composer as is (its entries travel with it, no regex). A skill
activation is an attachment, as a pasted image is, so the `<user_request>`
wrapper is built from the draft at send and a returned draft restores it by
construction. "Held until a model is connected" is the primitive that IS
the thing, a `Latch` (`Latch.make`, members `open`/`close`/`await`/`whenOpen`,
`Latch.d.ts:21-45,109`): `modelConnected.whenOpen(send)` inside the existing
`inOrder` lane (`:848-852`, which already makes a message wait for a run to
exist); `connectChatModel` opens the latch; `heldMessage`, the `send`
parameter and the `onAccountChanged` thread go. `MessageSettlement` is the
Effect's result; the once-flag goes. Deleted:
the five shapes but one, the epoch, the queue signal and its two functions,
the chip re-parse, `ChatSessionCallFailed` (the selection's message is the
error's). Tests touching them: `src/test-kernel/cli/InputBar.vitest.ts`,
`chatSessionController.vitest.ts`.

**What we give up.** "Latest held message wins" becomes "every message
waits in order", which is what the lane already promises after the run
exists. Risk: the composer's restore-on-refusal appends to whatever was typed
since (`:245`); the value design keeps that rule in one place.

**Change amplification.** "A new thing rides with a message" (a file
reference chip): today `draftAttachments.ts`, `InputBar.tsx` (resolve and
restore), `App.tsx` and `runChatTui.tsx` (`onSubmit`), `modelConnection.ts`
(`HeldMessage`), `chatSessionController.ts` (`ChatAttachments`, `sendMessage`),
`cliState.ts` (`DraftRestoreRequest`) = 7 files; after: the store and the
send = 2.

**Depends on:** none (F1 rewrites `route`'s claim branch, not the draft).

---

## Finding 4. The runtime install and the platform init are two memoized singletons, a refusing stand-in and an `install` literal, re-entered by every command

**Red flags:** special and general code mixed (refusing services for two
entries); an option for a special case (`install: 'noPlatform' | 'service'`);
shared mutable state (two module `installed`s and `shutdownQuiet`); comments
substituting for design (379 comment lines over three files); a pass-through
(`cliPlatformShutdown`).

**Evidence.**

- `runtime/cliProcessRuntime.ts:161` `let installed`; `:184-207` returns it
  when set; `:219-226` clears it on dispose. `:54-148` builds
  `refusingStateStore` (reads `Effect.die`, writes a tagged failure) and
  `refusingGlobalDatabase` (every member dies) into the frozen
  `NO_PLATFORM_INSTALL`, with `:57-65`, `:89-98` and `:127-148` explaining
  why a refusal is a defect rather than an absence. `texraProcessLayer`
  already takes `globalStores` as optional
  (`packages/texra/src/controllers/texraProcessLayer.ts:77,141-143`): the
  stand-ins exist because the CLI always passes something.
- `commands/_helpers/defineCliCommand.ts:81` `install?: 'noPlatform' |
  'service'` (twenty doc lines `:71-80`), branched at `:148-169`; users:
  `clone.ts:173`, `installGithubAction.ts:402` (`noPlatform`),
  `service.ts:137,198,216,234` (`service`).
- `runtime/initPlatform.ts:56-65` a second `installed` with six fields,
  `:50` `shutdownQuiet`, `:69-71` `cliPlatformShutdown = Effect.suspend(() =>
  installed?.shutdown ?? Effect.void)`; the init runs `withProcessServices`
  with the memo check inside (`:287-292`), opens the session under
  `Effect.cached` (`:328`, `:351`), makes a scope by hand with three
  finalizers (`:373-376`) and caches its close (`:383`); "Double init is the
  normal path (every command runs this)" (`:276-277`); the thirty-three
  comment lines `:254-286` explain who builds and who finds.
- `initCliPlatform(` is called at 36 sites in 18 command files
  (`history.ts` four times, `agents.ts` five, `models.ts` three,
  `config.ts` three, `team.ts` three, …), each inside the command's
  program, so every command restates "bring the platform up" and the memo
  makes the second and later calls a lookup.
- The runtime is carried as a value through eight interfaces
  (`CliPlatformServices.runtime` `:109`, `SlashCommandContext.runtime`,
  `AppProps.runtime`, `StatusBarProps.runtime`, `InputBarProps.runtime`,
  `BaseTextInputProps.onImagePaste.runtime`, `registerBuiltinSlashCommands`,
  `ChatSessionControllerInit.runtime`); `withProcessServices(runtime, …)`
  has 42 refs in 16 files.
- Three places know the two-step shutdown: `bin/texra.ts:270-272`
  (`cliPlatformShutdown` then `disposeCliProcessRuntime`),
  `bin/texraServe.ts`, and `initPlatform.ts:373-376`.

**The design decision behind it.** "What does this command run over, and
who tears it down?" is answered as "whoever got here first built it; the
rest join" (two memos), "two commands must not touch the global stores"
(a refusing stand-in and a literal) and "every command asks for the platform
itself" (36 calls), instead of as the command's declared requirement.

**The better design.** `defineCliCommand` is already the one run edge
(`:173`). It builds the command's runtime once from what the command's
program requires: `ManagedRuntime.make(Layer.provide(CliPlatform.layer(context),
texraProcessLayer(...)))` (`ManagedRuntime.d.ts:276`), where
`CliPlatform.layer` is `Layer.effect(CliPlatform, program)` over the current
body of `initCliPlatform` minus the memo and the hand scope: in 4.1.2 the
effect given to `Layer.effect` "is executed in the scope of the layer"
(`Layer.d.ts:1130-1140`; there is no `Layer.scoped`), so
`Effect.acquireRelease` inside it releases sessions, project and runtime in
reverse order, and `ManagedRuntime.dispose` (`:188`) is the one shutdown.
The primitive that IS the thing is the layer's scope. A command `yield*`s
`CliPlatform` (or nothing). `clone` and `install-github-action` declare an
`R` without `AppState`/`GlobalDatabase`, so `texraProcessLayer` is built
without `globalStores` and a read fails to type-check: no refusing stores,
no `install` literal (`service`'s "no workspace" is the absence of
`workspace` in the layer input). `holdSignals(platformSignalPolicy)` is an
`acquireRelease` of that layer. The React side keeps one `RuntimeContext`
(callbacks are the edge) instead of five prop threads. Deleted (prod
refs/files): both `installed`, `shutdownQuiet`, `NO_PLATFORM_INSTALL` (3/2)
and its two stand-ins, `install` (7 sites/4 files), `cliPlatformShutdown`
(6/3), `disposeCliProcessRuntime` (8/4, becomes `dispose`),
`CliPlatformServices` (21/10, becomes the service), the 36 `initCliPlatform(`
calls, `src/test-kernel/support/cliInitPlatformMock.ts` (becomes a test
layer), about 280 comment lines.

Not a re-proposal of `RT-install-cli-process-runtime`
(`.agents/docs/refuted-candidates.json`): the install stays a plain function
at the one citty edge; what changes is that it is per command rather than a
process memo, and the platform is a layer of that runtime rather than a
second memo.

**What we give up.** "Join a runtime an earlier entry installed": the update
check (`runtime/updateChecker.ts:234` `updateNotifyStarted`) becomes the
first step of the command's program on the same runtime; `texra doctor`'s
report after a failed init (`commands/doctor.ts:99-111`) runs in the layer
build's `catch` instead of borrowing a disposed runtime. Risk: six test
files pin the memo (`ExecuteCli`, `ResumeCommand`, `WorkflowRunCommand`,
`InstallGithubAction`, `OverleafCloneCommand`, `SlashCommandDispatch`).

**Change amplification.** "A command that needs neither global store":
today `defineCliCommand` (the option), `NO_PLATFORM_INSTALL`, the two
stand-ins, the command = 4 files; after: the command's `R` = 1. "A new
command over the project": today the command restates `initCliPlatform`
and the service decision; after: `yield* CliPlatform`.

**Depends on:** none; lands after PR 14771's `linkCliService`, which the
layer keeps as its one door.

---

## Finding 5. The chat's exit is decided in `leave` and run from three places, around two awaits of Ink's exit and two timers for one window

**Red flags:** reinvented primitives (`exited ??=`, a `releaseSignals` let, a
`Deferred.makeUnsafe` exit, `Date.now()` beside a notice TTL); temporal
decomposition (sync part in `leave`, async part in `exitProgram`, a
graceful second decision in `runChatTui`'s `finally`); comments
substituting for design (33%).

**Evidence.**

- `chat/tui/sessionExitController.ts:116-121`: `secondCtrlCExitsUntil`
  (wall clock), `releaseSignals`, `exited: Promise | undefined`. `leave`
  (`:254-267`) guards with `session.leaving` (`Deferred.isDoneUnsafe`,
  `sessionRunState.ts:96-98`), unmounts, completes `session.exit`
  (`Deferred.makeUnsafe`, `:92`) and starts `exited ??= runCliExit(exitProgram)`;
  `gracefulTeardown` (`:340-343`) calls `leave` and `exited ??=` again;
  `runChatTui.tsx:736-750` awaits `ink.waitUntilExit()` and then
  `gracefulTeardown()`, while `exitProgram` awaits `ink.waitUntilExit()` a
  second time (`:173-175`).
- The double-tap window is two timers: `Date.now() + 800` (`:269`) and a
  transient notice with `ttlMs: 800` (`:270-274`), the latter a `setTimeout`
  in `cliState.ts:411-417`; `:113-116` explains that replacing the notice
  "must not change whether that second Ctrl-C confirms".
- `interruptPendingRun` runs twice around `ctx.submitted` (`:204-206`), then
  `Effect.ignoreCause(session.runSettled)` (`:212-214`), then
  `resetCliState()` (`:226`) after reading the exit code because "resetCliState()
  below clears the claim" (`:220-222`). A graceful exit of a resumable idle
  root ends in `cliExit` (`process.exit`) mid-program because "the run
  waiting at the WAIT node keeps the event loop alive" (`:227-241`): the
  chat's scope does not own what keeps the loop alive.
- `holdSignals` (`runtime/processSignals.ts`, 51 lines, a good module) gives
  a release; the controller stores it in a `let` and calls it from `leave`.

**The design decision behind it.** "How does the chat end, and in what order
do its holds release?" is answered by a Deferred, three entry points and a
hand-rolled once, because the chat is Promise choreography around Ink's
`render` rather than one fiber whose scope holds what the chat holds.

**The better design.** The primitive that IS the thing is a `Scope`
(`Effect.scoped`, `Effect.d.ts:12567`; `Effect.acquireRelease`, `:12676`,
whose finalizers run in reverse registration order). The chat is one scoped
Effect on the process runtime: `Effect.acquireRelease(render(<App/>), unmount

- terminal.release)`inside a scope that holds, in registration order, the
  service link, the view binding, the terminal, the transcript watch, the
  credential watchers, the controller's attachment, the`sending` `FiberSet`
  and the signal hold (`holdSignals`as`acquireRelease`); the body is
  `Effect.raceFirst(Effect.promise(waitUntilExit), Deferred.await(exit))`
  (`raceFirst`, `:8868`: first to finish, failure included). An exit is the
  one `Deferred<ChatExit>` (`Deferred.make`, `Deferred.d.ts:152`) completed by
  a key, a slash command or a signal handler (the handler does its synchronous
  terminal restore first, so the "before the first await" guarantee of
  `:247-253`is kept where it is made); the drain is the scope's finalizers;
  the resume hint is printed by the finalizer registered after the terminal's.
  The confirmation window is one`FiberHandle`running`Effect.sleep('800
  millis')` (`FiberHandle.run`supersedes the previous fiber,`FiberHandle.d.ts:542-549`;
  `Effect.sleep`, `Effect.d.ts:8625`); the notice shows while the handle holds
  a fiber (the notice's TTL and `Date.now()`go). Deleted:`exited`, `releaseSignals`, `secondCtrlCExitsUntil`, `leave`'s once, the
  second `waitUntilExit`, `gracefulTeardown`, `TuiSession.exit`/`leaving`(2 files),`requestInputExit`(becomes`Deferred.done`), about seventy
  comment lines; `runChat`becomes an Effect`defineCliCommand` runs on the
  same runtime.

**What we give up.** Nothing user-visible. The `cliExit` inside a graceful
exit stays until the chat's scope owns the local session's hold (R10/F1).
Risk: `src/test-kernel/cli/SessionExitController.vitest.ts` pins the
controller's shape.

**Change amplification.** "A new hold the chat must release before the hint
prints" (an MCP server the chat started): today `runChatTui.tsx`
(`onChatClose`), `exitProgram`'s ordering and `leave`'s sync part = 2-3
places with an ordering comment; after: one `acquireRelease` = 1.

**Depends on:** R10 (F1 for `interruptPendingRun` and `isResumableIdle`, F5
for the code); the scope and fiber shape can land first.

---

## Finding 6. The status bar polls two facts on wall-clock timers and a hand-bumped version counter where the process already publishes the change

**Red flags:** reinvented Effect primitives (a generation counter with
`addObserver` and `interruptUnsafe` where `FiberHandle`/`switch` is the
thing; a cache-busting counter with six writers where a signal exists);
two triggers for one fact.

**Evidence.**

- `chat/tui/panes/StatusBar.tsx:72-122` `usePolledRead`: `generation`,
  `inFlightKey`, `reading` fiber, `interruptUnsafe` (`:91,:101`),
  `addObserver` with a generation check (`:109-114`); used twice (`:166-174`
  the route every 10 s, `:206-211` the quota every 30 s, `:39-40`).
- `:163-165` folds `codexPreferenceVersion` into the read key;
  `cliState.ts:431-442` defines the counter so the bar "re-reads it
  immediately instead of waiting for its periodic poll"; six writers:
  `hosts/cliProviderKeys.ts:77` (inside `onAppSignal('credentialChanged')`:
  a signal turned into a counter), `state/subscriptionPreference.ts:24` (a
  25-line module whose job is the bump), `forms/CliConfigForm.tsx:144`,
  `commands/handlers/modelAccessCommands.ts:59`, `loginCommands.ts:128`.
- The process publishes the changes: `AppSignals` carries
  `credentialChanged` and `approvalPolicyChanged`
  (`packages/harness/src/platform/appSignals.ts:33,77`) with
  `appSignalStream`/`onAppSignal` (`:229,:248`); `toSignal(runtime, stream,
  initial)` (`packages/texra/src/shared/signals.ts:18-22`) is the bridge
  `bindSessionView` already uses (`state/sessionView.ts:62`).
- `:177-189` a `reportedProbeFailureKeysRef` Set deduping a `writeStderr`
  from inside the component (`useStderr`, `:129`); `:125-128` a
  `SubscriptionUsageService` constructed in `useMemo` in the component.

**The design decision behind it.** "When does the bar's route and quota text
change?" is answered by time plus a counter every writer must remember to
bump, because the two facts are read with one-shot Effects instead of
followed as streams.

**The better design.** The primitive that IS the thing is a `Stream` with
`switchMap`: one stream built where `stores` are,
`Stream.merge(Stream.tick('30 seconds'), appSignalStream('credentialChanged'),
preferenceChanges)` (`Stream.tick`, `Stream.d.ts:457`; `Stream.merge`,
`:3377`) → `Stream.switchMap(() => Stream.fromEffect(read))` ("switches to
the latest stream ..., interrupting the previous stream when a new element
arrives", `:2505`: the in-flight read is superseded, which is what the
generation counter emulates) → `Stream.changes` (`:13273`, so a repeat is
not a re-render) → the `useStream` hook of the mapping section (or
`toSignal`); the bar reads `{ route, quota }`. A probe failure is one
`Effect.logWarning` per change inside the stream, not a Set in a ref. A
preference write becomes the `AppSignal` it is (the `PubSub` behind
`appSignalStream` is the publish primitive already in place).
Deleted: `usePolledRead` (3 refs/1 file, 50 lines), `codexPreferenceVersion`
and `bumpCodexPreferenceVersion` (11/6), `subscriptionPreference.ts`,
`reportedProbeFailureKeysRef`, `useStderr` in the bar,
`CODEX_SUBSCRIPTION_REFRESH_MS`; `tui/usePollingInterval.ts` keeps the 1 Hz
clock only.

**What we give up.** The 10 s re-read for "external config changes" survives
as the tick (`settings.ts:78` says nothing may cache a read, so a tick is
honest). Risk: none.

**Change amplification.** "A seventh writer that changes model access": today
the writer plus a `bumpCodexPreferenceVersion()` it must remember (a
forgotten bump reads stale until the next poll); after: the writer's own
signal.

**Depends on:** none.

---

## Finding 7. `statusBarDisplay.ts`: two fitting algorithms over segments whose "never drop" rule is a priority number, a sentinel colour, and facts arriving on two channels

**Red flags:** special and general code mixed (a 117-line notice fitter
beside the general sweep); sentinel values (`compactPriority === 85` means
"a bypass badge", `'dim'` means "use `dimColor`"); information leakage (App
computes facts the bar derives from the same view).

**Evidence.**

- `chat/tui/panes/statusBarDisplay.ts:486-539` `fitStatusBarLeftSegments`:
  compact by ascending priority, then drop. `:368-484`
  `fitTransientNoticeStatusBarLeftSegments`: takes three indexes
  (`noticeIndex`, `livenessIndex`, `discardWarningIndex`), defines
  `isBypassBadge` as `compactPriority === STATUS_BAR_COMPACT_PRIORITY.bypassBadge`
  (`:389-390`), and runs seven ordered sweeps with exemptions (`:395-399`,
  `:403-412`, `:415-419`, `:421-435`, `:439-446`, `:448-460`, `:462-475`,
  `:481`), each with a comment on what must not be lost first. The caller
  picks one by `transientNoticeIndex !== undefined` (`:943-952`).
- `:298-323` the priority table's comments say "every segment carries SOME
  priority: ... a priority-less segment is unfittable", a rule
  `compactPriority?: number` (`:112`) does not enforce.
- `:87-93` "`'dim'` is not an Ink color name — it is a sentinel this file's
  own renderer reads"; `StatusBar.tsx:296-297` reads it.
- `buildStatusBarDisplay` (`:782-958`) records positions as identities
  (`left.length` captured at push, `:809`, `:850-851`, `:857`).
- Two channels: the bar reads eight signals (`StatusBar.tsx:130-140,163,222`)
  and takes twelve props (`:41-62`), of which `runningSessions`
  (`App.tsx:205-208`), `scriptAvailable` (`:211-213`), `transcriptAvailable`
  (`:632`), `childListSelectionKillable`/`Resumable` (`:217,627-629`) and
  `childNavigationAvailable` are derived in App from the view the bar already
  holds; `StatusBarChrome` has 16 fields (`:125-157`). No test pins the fit
  sequence (`src/test-kernel/cli` has no `StatusBar` suite).

**The design decision behind it.** "Which segment yields when the row is
narrow?" is answered twice, with "never yields" written as a magic number,
and "who computes a fact the bar shows" is split between App and the bar.

**The better design.** A segment declares `{ text, compact?, color, dim?,
priority, policy: 'drop' | 'compact-only' | 'truncate' | 'keep' }` and one
fitter runs: compact by priority, drop `drop` by priority, truncate the
`truncate` ones into the remaining width, `keep` never leaves. The notice
case is the general case (the notice is `truncate`, the discard warning
`keep` + `truncate`-last, badges `keep`). `'dim'` is `dim: true`. The bar
derives every view fact itself; App passes only what it alone knows
(`childListFocused`, `foregroundInputActive`, `commandName`). Deleted: the
notice fitter (2 refs/1 file), the three index locals, `isBypassBadge`, the
sentinel, nine of twelve props, `runningSessions`/`approvalDepth`/`approvalKind`
from the chrome input; about 150 lines.

**What we give up.** The exact order of sacrifice at extreme widths is
re-expressed as policies, not preserved sweep by sweep. Risk: display only,
unpinned.

**Change amplification.** "A new segment that must never be dropped" (a
service-offline badge): today a priority above 85, an exemption in the
notice fitter, the push site and the general sweep's assumption = 3-4 edits,
plus App if the fact arrives as a prop; after: one push with `policy: 'keep'`.

**Depends on:** none.

---

## Finding 8. The child list's focus and highlight are a React reducer reconciled against the signal store during render and in three effects

**Red flags:** two representations of one fact (the reducer's `selectedValue`
beside the Surface's `selected`); view state outside the signal store (the
`texra-cli` skill: "any view-level toggle (collapse/expand, focus) belongs in
shared signal state"); a renderer compensating (a dispatch during render).

**Evidence.**

- `chat/tui/App.tsx:144-147` `useReducer(reduceChildListSelection)`; `:148`
  `childListActiveRunRef`; `:218-228` computes `reconcile` and dispatches it
  during render when the reducer would change; `:232-241` a `useLayoutEffect`
  dispatching `syncActiveRun` behind the ref; `:242-246` an effect blurring
  when the list empties; `ConversationRegion.tsx:165-174` a fourth effect
  cancelling focus when the panel is not visible; `snapshot`
  (`ConversationRegion.tsx:46-53`) carries `selectedChildValue`/`childListFocused`
  down and `StatusBar` takes three derived props.
- `state/childListSelection.ts` (85 lines): six action kinds, two of which
  (`syncActiveRun`, `reconcile`) exist to follow the signal store.
- The store already does this job for the selection: `cliState.ts:99-142`
  (`surfaceChoice`, `actOnSurface`, `pruneSurface` with the chat's
  `SelectionRule`, "the vocabulary the webview and desktop dispatch too"),
  resolved against the view on every read (`:121-125`); `sessionListRunIds`
  (`:202-206`) is the list's order.

**The design decision behind it.** "Which row of the child list is
highlighted, and does the list own the keys?" is answered by component
state that must be kept in step with the store, so every way the store can
move gets an effect.

**The better design.** The primitive that IS the thing is the one the
selection already uses: the surface record, written through `actOnSurface`
and resolved against the view on read. Two entries beside it in
`cliState.ts`: `childListFocus` (a `RunId | null`, null: the input owns
keys; a `SubscriptionRef` once `cliState.ts`'s signals become refs under
the mapping section, a `signal` until then) and a derived
`childListHighlight` resolved against `sessionListRunIds` and `selectedRunId`
with `resolveChildSelectionValue`'s rule, the way `selectedRunId` is
resolved by `pruneSurface`; one writer `focusChildList`. A run leaving the
list resolves away in the derivation, so the blur and cancel effects go;
`focusSession` is `actOnSurface({ kind: 'select' })`. (If the owner prefers
the shared `Surface`, a `childList` field beside `expanded` is the same
deletion.) Deleted: `childListSelection.ts` (2 consumers), the reducer, the
ref, three effects in App and one in the region, the `snapshot` fields and
the `onChildSelectionChange`/`onCancelChildList` props,
`focusRunAndPromoteApprovals` (promotion is F2's).

**What we give up.** Nothing. Risk: `SubagentList` reads `selectedValue` as
a prop today; it reads the signal after.

**Change amplification.** "A second keyboard-owning panel" (a navigable
plan panel): today a second reducer, effects, snapshot fields and StatusBar
props across App, Region, StatusBar and a new state file = 4; after: one
signal and the panel = 2.

**Depends on:** none.

---

## Finding 9. The slash-command registry is a process-global table filled from a 21-field bag of optional callbacks with one caller, forms opened by string name, and a three-mode completion option

**Red flags:** overexposure (18 optional callbacks whose values are constant
per the one caller); shared mutable state (`installedCommands`); information
leakage (command names as a protocol in four modules); an option for a
special case (`completion: 'busy'`); a second façade over the controller.

**Evidence.**

- `chat/tui/commands/registerBuiltins.tsx:89-139`: 21 option fields, 18
  optional, with defaults at `:136-148` (`onAgentSelect ?? patchSessionMeta`,
  `onTeamSelect ?? "Teams can only be chosen in texra chat"`,
  `canSelectAgent ?? (() => true)`); the one production caller
  (`runChatTui.tsx:552-613`) passes twenty of them; the defaults serve
  `src/test-kernel/cli/SlashCommandDispatch.vitest.ts:72`, which passes
  `{ ...services }`.
- `slashRegistry.ts:75` `let installedCommands`; `installSlashCommands`
  (`:83-108`) replaces it; `findSlashCommand` by name (`:121-128`).
  `openCliSlashCommandForm('login' | 'agent' | 'key' | 'model')` from six
  sites in four files (`modelConnection.ts:72,149`, `runChatTui.tsx:668`,
  `modelAccessContribution.tsx:153,206`, `registerBuiltins.tsx:204`).
- `handlers/slashContext.ts:449-476` `SlashCommandContext`: 11 fields
  (`session: TuiSession`, `resetSession`, `resumeRun`, `setApprovalPolicy`,
  `processCwd?`), a second façade beside `ChatSessionController`
  (`chatSessionController.ts:153-188`), built as a lazy thunk "so the closures
  it captures ... are all defined before the first use"
  (`runChatTui.tsx:375-390`), a construction-order workaround.
- `formSelection.ts:215-380` `completion: 'afterAction' | 'beforeAction' |
  'busy'`: the `busy` branch is 115 lines (`:241-356`) used by one caller
  (`modelAccessContribution.tsx:122`, the only `busyTitle`); `SlashCommandOutput`
  has two implementations (`slashContext.ts:486-496`, `formSelection.ts:286-313`).

**The design decision behind it.** "What can a slash command do, and with
which services?" is answered by a global filled through a bag of optional
callbacks, because the registry is installed before the thing it needs (the
controller) exists in the file that installs it.

**The better design.** The primitive that IS the thing is a service built
by a `Layer.effect` in the chat's scope, not a process global:
`SlashCommands` (`Context.Service`), its layer `Layer.effect(SlashCommands,
build)` over the controller and services the chat scope already holds, read
with `yield* SlashCommands` by the dispatcher and handed to `App` through
the one React context the mapping section names. Concretely
`createSlashCommands(deps: { controller, services, link?, cliContext })`
returns a value `{ commands, find, match, parse }`
built in `runChatTui` after the controller exists and passed to `App` (one
context) and `handleTuiSlashCommand`; every callback is a method of the
controller or a service, so the optionals and defaults go; a form is opened
by reference (`commands.login.form`); `SlashCommandContext` is `deps` (the
controller gains `setApprovalPolicy`/`resetSession`, which `runChatTui.tsx:337-374,
520-549` defines today). `completion` becomes two functions, or `busy`
becomes a property of the action's program (the frame shows while its fiber
runs, F2's pattern). The test builds the value with a fake controller.
Deleted: 18 fields and 5 defaults, `installSlashCommands`/`installedCommands`/
`listSlashCommands` (3 consumers), `openCliSlashCommandForm` (6/4), the lazy
thunk, `completion`/`busyTitle`, one `SlashCommandOutput` implementation.

**What we give up.** Nothing; a plugin-contributed command keeps
`SlashCommandContribution`'s shape as data. Risk:
`SlashCommandDispatch.vitest.ts`.

**Change amplification.** "A new slash command with a form": today the form,
`registerBuiltins.tsx` (adapter and table), a new `onXSelect?` option with a
default, `runChatTui` passing it, and any `openCliSlashCommandForm('x')`
caller = 3-4 files; after: the form and the table entry = 2.

**Depends on:** none (F3's `createHostRunActions` supplies controller
methods; the value shape is independent).

---

## Finding 10. "Which of several reads, pastes or timers is current" is hand-rolled per site: counters, Sets with observers, `interruptUnsafe`, `setTimeout` and ten once-flags

**Red flags:** reinvented Effect primitives (`FiberHandle`, `FiberSet`,
`Deferred`, `Effect.race`, `Effect.sleep`); state machine in flags.

**Evidence.**

- `chat/tui/input/imagePasteQueue.ts:8-69`: a `Set<Fiber>` with `addObserver`
  (`:23`), a `deferredAction` once-slot (`:10,:34-38`), an `interruptUnsafe`
  loop (`:47`) — a `FiberSet` plus `FiberSet.awaitEmpty`, which the controller
  already uses for `sending` (`chatSessionController.ts:854-856,1064-1067`);
  8 refs/3 files.
- `forms/_shared/useAsyncListForm.ts:152-207` `useAsyncResource`: `sequence`
  (`:154`), `mounted` (`:155`), `current()` (`:170-171`), `reloading` with
  `interruptUnsafe` (`:196,:205`) — "only the latest read lands, none after
  unmount" is `FiberHandle.run` in a scope closed at unmount; 10 refs/4 files,
  with `useAsyncListForm` (12/9) on top. `StatusBar.tsx:72-122` is the same
  shape a third time (finding 6).
- `state/subscribeApprovals.ts:148-149` `switches.add(fiber);
  fiber.addObserver(() => switches.delete(fiber))` (F2 names the module; this
  is the primitive).
- `terminalTitle.ts:70-77,90-95` `disposed`/`suspended`/`stopSharedTick` lets
  around the shared clock: a forked animation fiber interrupted on idle.
  `runProgressRenderer.ts:98,138-146,241-244` a `heartbeat` fiber with
  `interruptUnsafe` beside the `forkScoped` that already owns it,
  `stopHeartbeat` from four places.
- `App.tsx:387-394,457-465` an escape-chord `setTimeout` in a ref, plus
  `chordResolvedBy` cleared by `queueMicrotask` (`:510-512`): a 500 ms race
  between the next key and a timeout. `cliState.ts:387-425` a notice TTL
  `setTimeout`.
- Ten once-flags in eight files: `runProgressRenderer.ts:177`,
  `tui/terminalCleanup.ts:93`, `terminalTitle.ts:70-71`,
  `hosts/tuiUiHost.tsx:68`, `state/attachedTask.ts:81`,
  `commands/handleSlashCommand.ts:38`, `commands/slashForms.tsx:168`,
  `chatSessionController.ts:476,965`.

**The design decision behind it.** The React side has no shared way to hold
a fiber for a component's lifetime, so each site rebuilds "supersede,
interrupt on unmount, run once" with the nearest JavaScript tool.

**The better design.** The primitives that ARE the thing: `FiberHandle`
for "the latest one wins" (`FiberHandle.make` needs a `Scope`,
`FiberHandle.d.ts:110`; `FiberHandle.run` "interrupts the previous fiber",
`:542-549`; `FiberHandle.clear`, `:504`), `FiberSet` + `FiberSet.awaitEmpty`
for "all of these, then" (`FiberSet.d.ts:106,686`), `Effect.raceFirst` +
`Effect.sleep` for a timed race, `Deferred` for a result two paths may
complete, `Effect.cached` for "at most once" (`Effect.d.ts:13539`). One
hook, `useFiberHandle(runtime)` (the mapping section): a `FiberHandle` made
in a scope the component's mount owns and closed at unmount (closing the
scope interrupts the fiber: no `interruptUnsafe`); `useAsyncResource` is
that hook plus a result state; the paste queue is a `FiberSet` and the
submit `Effect.andThen(FiberSet.awaitEmpty(pastes), submit)` run through the
handle (so a second submit supersedes the first: say which rule); the escape
chord is `Effect.raceFirst(nextKey, Effect.sleep('500 millis'))`; the
animation and heartbeat are the fibers their scopes already own
(`Effect.forkScoped`, `:17216`); a once-flag is a `Deferred` where two
completions compete (the dialog's answer, the message's result) and plain
structure elsewhere (`echoed` is `Effect.cached`).
Deleted: `ImagePasteQueue` (69 lines), the counter/ref/interrupt trio in
`useAsyncResource`, `usePolledRead`, `switches`, the title's three lets, the
chord timer and `chordResolvedBy`, the notice timer, ten flags.

**What we give up.** Nothing user-visible beyond naming the paste/submit
race rule. Risk: `InputBar.vitest.ts` pins paste timing.

**Change amplification.** "A third async read in a form that also polls":
today copy the 55-line trio from `useAsyncResource`; after: one hook call.

**Depends on:** none.

---

## Finding 11. Batched: smaller findings in the same species

- **Every headless result is built three times.** `emitCliResult` takes
  `{ json, ndjson, text }` eagerly ("Values are eager",
  `commands/_helpers/output.ts:23-38`) at 36 sites in 16 files;
  `schemas/cliOutput.ts:109-254` registers 33 `StructWithRest({ kind, field:
  payload }, Record)` members of which 26 differ only in the field name (the
  one non-constant column) and two carry a real schema; `ts` is stamped in
  two places (`output.ts:48-56` and `runtime/history.ts:449-454`). Design: a
  `Record<kind, field>` table and `emitCliResult(context, kind, value, text)`
  that derives both JSON forms; the union keeps its two typed members.
- **`runtime/` is a conjoined directory.** 60 files, 11,741 lines: the
  bootstrap (`initPlatform`, `cliProcessRuntime`, `executeCli`), sinks
  (`logSinks`), command bodies (`history`, `memory`, `skills`, `doctor`,
  `agents`, `workflowInputs`/`workflowOutput`), terminal text (`terminalText`,
  `ansiEscapes`, `style`, `pager`), four shell-completion files, the update
  checker and a 573-line `validationModel.ts` of test-fixture scripts in the
  production tree. Nine `commands/X.ts` ↔ `runtime/X.ts` pairs (agents,
  chat/chatDefaults, completion, doctor, history, init/initConfig, memory,
  skills, workflow) are "parse here, do there". Design: a command's body
  beside its definition (`commands/history/`), TUI-shared bodies in named
  modules (`modelAccess/`, `terminal/`, `output/`), the validation model in
  test support.
- **`transcriptEntryLayout`'s three-valued `mode`** (`chat/tui/panes/transcriptEntryLayout.ts:40,228-299`):
  `'live' | 'scrollback' | 'scrollback-budget'` is two booleans (elide the
  body, use the rich/live tool display), and `fullTranscriptEntryLayout`
  (`:364-380`) adds the inset back and re-wraps tools after the fact — a mode
  plus a caller-side correction. One `{ elide: boolean, tail: number | 'all' }`.
- **`/clear` is four resets** (`runChatTui.tsx:536-547`: `stop`,
  `clearPendingSkills`, `session.clearRunState`, `resetCliState` + the erase
  epoch), `TuiSession`'s constructor resets a module signal
  (`state/sessionRunState.ts:85-88`), and `bindSessionView` holds a global
  `bound` that throws when unset (`state/sessionView.ts:72-80`). F7/R10 name
  the ten reset hooks; the angle here is the shape that ends them: one
  `ChatState` factory per chat, so `/clear` is "a new state", and the view
  binding is a field of it rather than a module global.
- **The bell re-derives "the turn finished"** from four conditions over phase
  transitions (`runChatTui.tsx:719-734`); F1's table lists it (as `:790`).
  Found; cited for its new line numbers.

---

## Good modules in this area (copy these)

- `chat/tui/panes/transcriptEntries.ts:127-140` `ROW_KIND_IS_WIDGET`:
  exhaustive by construction (`satisfies Record<TranscriptRowKind, boolean>`),
  so a new row kind must say which side it is on; the same shape in
  `transcriptEntryLayout.ts:75-116` `ROW_GEOMETRY`.
- `chat/tui/panes/staticTranscriptRing.ts:219-296`
  `StaticTranscriptTotalsAccumulator`: margin collapse priced once at the seam,
  a deep module behind `insert`/`remove`; the ring budget itself is sound.
- `chat/tui/state/formSlot.ts` (84 lines): one slot, one writer, a queue that
  hands the slot on; `hosts/tuiUiHost.tsx:56-82` `openDialog` over it
  (`Effect.callback` + a `Semaphore(1)` lane, the finalizer releases the slot).
- `chat/tui/appLayout.ts`: pure row allocation; `appInteractionPolicy.ts:53-73`
  one precedence function for the foreground kind.
- `commands/_helpers/dispatch.ts`: pure argv functions over citty's tree;
  completion derived from the same tree (`runtime/completionCommandTree.ts`).
- `runtime/logSinks.ts:87-103` `writeRawAndWait`: the stream's write callback
  is "the foreign edge, wrapped exactly once"; `askCliQuestion` as
  `acquireUseRelease`.
- `runtime/runProgressRenderer.ts`: reads the view and keeps only its own
  output state; the heartbeat is `Effect.schedule` under `forkScoped`.
- `chat/tui/state/useSignal.ts`, `state/sessionView.ts`: one bridge, one
  throw when unbound, "derives nothing the session view already states".
- `chat/tui/input/draftAttachments.ts` `DraftAttachmentStore`: one id space,
  chips expanded at one boundary, headless parity by construction.
- `runtime/processSignals.ts` `holdSignals`, `tui/terminalCleanup.ts`'s
  synchronous teardown (round 1 named the first; both are what the
  `texra-cli` skill asks for).

## Already settled, left alone

- F1 (the run claim, `sessionRunState.ts`, `launchRootRun`/`resume`/
  `adoptResumedRoot`/`observeResumedRoots`/`continuedSince`), F2 (the approval
  surface, `approvalQueue.ts`, `subscribeApprovals.ts`, `runtime/approvalAdapter.ts`),
  F3 (`launchRootRun`'s start/present half, `showFailure`, `reportRunFailure`,
  the resume entry points in `commands/resumeRun.ts` and
  `commands/handlers/sessionCommands.ts`), F5 (`exitCode.ts`, `executeCli.ts`,
  `ChatExit.exitCode`), F6 (`sessionProgressSubscription.ts`), F7 (the ten
  reset hooks, `cliProcessRuntime.ts`'s `NO_PLATFORM_INSTALL` named as
  special code; finding 4 gives it the layer shape).
- The CLI-service note: `runtime/cliService.ts`, `commands/service.ts`,
  `runtime/taskAttach.ts`, `state/attachedTask.ts`, `initCliPlatform`'s
  `startsService` and its service branch (`initPlatform.ts:302-355`), which
  finding 4 keeps as the layer's one door.
- `RT-install-cli-process-runtime` (refuted): the install stays a plain
  function at the one citty edge; finding 4 moves the memo, not the edge.
- `chatSessionController.ts:883-945` `Effect.uninterruptible` around a
  `followUp.send` and its presentation: the same boundary round 1 kept for
  `SessionBridge.answer` (a committed request is always followed by what it
  shows).
- `Semaphore.makeUnsafe(1)` lanes (`chatSessionController.ts:852`,
  `tuiUiHost.tsx:40`, `history/inputHistory.ts:37`): one at a time per key, the
  shape `withPerKeyLane`'s ruling endorses.
- The `texra-cli` skill's rules: no alternate screen, finalized rows through
  `<Static>` once, DA1 discovery before Ink mounts (`runChatTui.tsx:280-289`),
  the width-change repaint in the vendored Ink patch, `EntryErrorBoundary`'s
  render-null catch (`panes/EntryErrorBoundary.tsx:39`), unconditional
  bracketed paste, headless parity. Finding 1 keeps every one of them; it
  changes who owns the origin, not the rendering model.
- `tui/usePollingInterval.ts`'s shared registry: the skill's "one Clock"
  item, done; finding 6 only takes the data polls off it.
- `runtime/cliContext.ts:161,242` `cachedAmbient`/`cachedManifest`: process
  facts read once, synchronous by design (the manifest read is what made the
  install synchronous); `logSinks.ts:21,246` `closed`/`ndjsonClosed`: a broken
  pipe is a process fact.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

`node_modules/effect` is present (`package.json` version 4.1.2, the `.d.ts`
files under `node_modules/effect/dist/`); every line below names the
declaration read. Two corrections to the vocabulary the owner's rule lists:
there is no `Layer.scoped` in 4.1.2 (`Layer.d.ts` exports `effect`,
`effectDiscard`, `succeed`, `provide`, `fresh`, `unwrap`, `build`,
`buildWithScope`); `Layer.effect`'s program "is executed in the scope of the
layer" (`Layer.d.ts:1130-1140`), which is what `scoped` named. And
`Stream.mapEffect`'s `concurrency` is `number | "unbounded"` only
(`Stream.d.ts:1883`, `Types.d.ts:448`); "supersede the in-flight one" is
`Stream.switchMap` (`Stream.d.ts:2505`). Anchors in the repo:
`packages/texra/src/controllers/server/client.ts` (14 uses of these
primitives), `serve.ts` (10), `packages/harness/src/controllers/session/SessionView.ts`
(9, `SubscriptionRef`), `chat/chatSessionController.ts:854-856,1064-1067`
(`FiberSet` + `awaitEmpty`), `runChatTui.tsx:456-480` (`FiberHandle.run` for
the transcript watch), `packages/texra/src/shared/signals.ts:18-36` (`toSignal`:
a stream forked onto a runtime, interrupted on dispose).

| Hand-rolled today                                                                                                                                                                                                                                                                                                                                | Effect primitive                                                                                                                                                                                                                                                                                                                                                                                | Note                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Three repaint epochs + `renderKey` + `onRenderKeyChange` + `queueMicrotask` re-entry (`staticTranscriptRing.ts:43-50`, `staticTranscriptRepaint.ts:10,22`, `tuiViewportController.ts:136-141`)                                                                                                                                                   | `SubscriptionRef<Scrollback>` (`SubscriptionRef.make`, `SubscriptionRef.d.ts:93`; `changes` emits the current value first, `:83-134`) with `origin` a field; the one repaint is `Stream.runForEach` over `changes.pipe(Stream.changesWith(sameOrigin))` (`Stream.d.ts:13298,15953`) forked in the chat scope                                                                                    | finding 1; the component reads the ref through `useStream` below                                              |
| `transcriptOrderKey`/`inSettlementOrder`/`lastAppendedKey`/`restartScan` (`transcriptEntries.ts:177-249,418-425`)                                                                                                                                                                                                                                | none: the fold's `settledRows` prefix (`sessionViewUpdate.ts:586-590`) is the order; the cursor is two fields of the same ref                                                                                                                                                                                                                                                                   | finding 2                                                                                                     |
| `MessageSettlement` once-flag, `pendingSkillActivations` + clear epoch, `draftRestoreRequest` queue, `heldMessage` `let` (`chatSessionController.ts:241-246,308-309,965-982`, `cliState.ts:331-352`, `modelConnection.ts:57`)                                                                                                                    | `SubscriptionRef<Draft>` for the draft; `Latch` for "a model is connected" (`Latch.make`, `Latch.d.ts:189`; `open`/`close`/`await`/`whenOpen`, `:21-45,109`): `modelConnected.whenOpen(send)` in the existing `inOrder` lane; the send's result is the Effect's value run in the existing `FiberSet`                                                                                            | finding 3                                                                                                     |
| Two memoized `installed`s, `shutdownQuiet`, `NO_PLATFORM_INSTALL` refusing stores, `install` literal, `Scope.makeUnsafe` + three finalizers + `Effect.cached(Scope.close)`, 36 `initCliPlatform(` calls (`cliProcessRuntime.ts:161`, `initPlatform.ts:50-71,328-388`, `defineCliCommand.ts:81,148-169`)                                          | `Layer.effect(CliPlatform, program)` built in the layer's scope (`Layer.d.ts:1130-1166`) with `Effect.acquireRelease` for each hold (`Effect.d.ts:12676`); one `ManagedRuntime.make(layer)` per command at the one run edge (`ManagedRuntime.d.ts:276`), `dispose`/`disposeEffect` the one shutdown (`:188,213`); a command declares `R`, so a platform-less command needs no refusing stand-in | finding 4; keeps `RT-install-cli-process-runtime`'s ruling (the install stays a plain call at the citty edge) |
| `leave` once + `exited ??=` + `releaseSignals` let + `Deferred.makeUnsafe` exit + two `waitUntilExit` awaits + `Date.now()` window beside a notice TTL (`sessionExitController.ts:116-121,254-267,268-275,340-343`, `runChatTui.tsx:736-750`)                                                                                                    | `Effect.scoped` + `Effect.acquireRelease` (`Effect.d.ts:12567,12676`) for the chat and every hold, released in reverse order; `Deferred<ChatExit>` (`Deferred.d.ts:152`) raced with Ink's exit by `Effect.raceFirst` (`Effect.d.ts:8868`); `FiberHandle.run(Effect.sleep('800 millis'))` for the confirmation window (`FiberHandle.d.ts:542-549`, `Effect.d.ts:8625`)                           | finding 5                                                                                                     |
| `usePolledRead` generation + `addObserver` + `interruptUnsafe`, `codexPreferenceVersion` bumped by six writers (`StatusBar.tsx:72-122,163-165`, `cliState.ts:431-442`)                                                                                                                                                                           | `Stream.merge(Stream.tick, appSignalStream(...), ...)` (`Stream.d.ts:457,3377`) → `Stream.switchMap(() => Stream.fromEffect(read))` (`:2505`) → `Stream.changes` (`:13273`); the writer's own `PubSub`-backed `AppSignal` (`appSignals.ts:229`) is the trigger                                                                                                                                  | finding 6                                                                                                     |
| `fitTransientNoticeStatusBarLeftSegments` beside the general sweep, `'dim'` sentinel, facts on two channels (`statusBarDisplay.ts:368-539`, `StatusBar.tsx:41-62`)                                                                                                                                                                               | none: pure layout; one fitter over a `policy` field                                                                                                                                                                                                                                                                                                                                             | finding 7                                                                                                     |
| `useReducer(reduceChildListSelection)` + reconcile-in-render + three effects (`App.tsx:144-246`, `ConversationRegion.tsx:165-174`)                                                                                                                                                                                                               | the surface record already resolved on read (`cliState.ts:121-125`); the focus is one more value read through `useStream`, derived against the view like `selectedRunId`                                                                                                                                                                                                                        | finding 8                                                                                                     |
| `installedCommands` global + 18 optional callbacks with defaults + `openCliSlashCommandForm('name')` + `completion: 'busy'` (`slashRegistry.ts:75`, `registerBuiltins.tsx:89-148`, `formSelection.ts:241-356`)                                                                                                                                   | a `Context.Service` built by `Layer.effect` in the chat scope over the controller (`Layer.d.ts:1166`); the busy frame shows while the action's fiber runs in a `FiberHandle`                                                                                                                                                                                                                    | finding 9                                                                                                     |
| `ImagePasteQueue` Set + `addObserver` + `deferredAction`; `useAsyncResource` `sequence`/`mounted`/`reloading`; `switches` Set; title/heartbeat lets; escape-chord `setTimeout` + `queueMicrotask`; ten once-flags (`imagePasteQueue.ts:8-69`, `useAsyncListForm.ts:152-207`, `subscribeApprovals.ts:148-149`, `App.tsx:387-394,457-465,510-512`) | `FiberSet` + `FiberSet.awaitEmpty` (`FiberSet.d.ts:106,686`); `FiberHandle` in a mount-owned scope (`FiberHandle.d.ts:110,542,504`); `Effect.forkScoped` (`Effect.d.ts:17216`); `Effect.raceFirst` + `Effect.sleep`; `Deferred`; `Effect.cached` (`:13539`)                                                                                                                                     | finding 10                                                                                                    |
| `emitCliResult` three eager forms; `runtime/` pairs; `mode` tri-state; four resets on `/clear`                                                                                                                                                                                                                                                   | none (data and structure); the `ChatState` factory of finding 11 is a value built in the chat scope                                                                                                                                                                                                                                                                                             | finding 11                                                                                                    |

**How React state meets Effect in the Ink TUI.** One hook, in
`chat/tui/state/useStream.ts`, replaces the generation counters and the
hand-rolled stores: `useStream(runtime, stream: Stream<A>, initial: A): A`
is `useSyncExternalStore` whose `subscribe` makes a scope
(`Scope.make`, `Scope.d.ts:243`), forks `Stream.runForEach(stream, (a) =>
Effect.sync(() => { latest = a; notify() }))` into it with `Effect.forkIn`
(`Effect.d.ts:17126`) on the chat's `ManagedRuntime`, and returns
`() => runtime.runFork(Scope.close(scope, Exit.void))` (`Scope.d.ts:574`):
the subscription's run lives in a scope the component's lifetime owns, and
closing it interrupts the fiber, so no `interruptUnsafe`, no generation, no
`mounted` ref. A `SubscriptionRef` is read as `useStream(runtime,
SubscriptionRef.changes(ref), SubscriptionRef.getUnsafe(ref))`
(`SubscriptionRef.d.ts:134,167`): `changes` emits the current value first
(`:83-100`), so the synchronous `getUnsafe` only seeds the first render
before the subscription's fiber starts. A
companion `useFiberHandle(runtime)` makes a `FiberHandle` in a mount-owned
scope the same way and exposes `run` (`FiberHandle.run`, supersede) for a
component-driven program (a form's read, a paste, the escape chord). The
existing `useSignal` (`state/useSignal.ts`) over `@lit-labs/signals` stays
for the surface record and the view, which `toSignal`
(`packages/texra/src/shared/signals.ts:18-36`) already bridges from a
`Stream` on the runtime; `useStream` is the same bridge without the
intermediate signal, and the two can converge once `cliState.ts`'s signals
become `SubscriptionRef`s. The `runtime` reaches components through one
React context (`RuntimeContext`), not through the eight interfaces of
finding 4.
