# G. The app's controllers and hosts: design red flags

Area: `packages/texra/src/controllers/` (the `server/` directory's service
lifetime, wire and windows are found in `2026-11-06-cli-service-root-causes.md`
and left out), `hosts/`, `agent/{export,runtime,templates}/`, `platform/`,
`model/`, `common/`, `utils/`, `telemetry/`, `housekeeping/`. Read-only, on
the working tree at `73e0225` (after the rebase that landed #14774–#14776;
`hosts/uiHosts.ts` was re-read after it). Paths are relative to
`packages/texra/src` unless they start with `packages/`. Consumer counts are
over `packages/*/src`; non-production over `src/test-kernel`,
`packages/*/test`, `docs`. Effect APIs are verified against
`node_modules/effect` 4.1.2 `.d.ts` (installed mid-audit; the mapping at the
end lists each one); a repo use cited beside one is precedent, not proof.

Open PR 14713 (open, not merged) changes `controllers/session/hostRunActions.ts`
(+22/−7) and `controllers/progressView/ProgressWorkflowFileActionsController.ts`
(+63/−87); findings 5 and 11c name it.

## Numbers

Lines per subdirectory (`*.ts`, `agent/output/` excluded as area I's):

| Directory                      | Lines | Directory               | Lines |
| ------------------------------ | ----: | ----------------------- | ----: |
| controllers/session            |  2784 | utils (6 subdirs)       |  1570 |
| controllers/settingsView       |  2786 | telemetry               |   690 |
| controllers/modelAccess        |  1154 | agent/export            |   595 |
| controllers/progressView       |  1049 | common                  |   453 |
| controllers/approval           |   440 | platform                |   450 |
| controllers/onboarding         |   411 | model                   |   387 |
| controllers/mainView           |   391 | housekeeping            |   349 |
| controllers (texraProcessLayer)|   149 | hosts                   |   271 |
| controllers/server (out)       |  3581 | agent/runtime+templates |   119 |

Five largest files (server excluded): `controllers/session/openGuiWindow.ts`
806, `telemetry/UsageLogService.ts` 626, `controllers/session/hostRunActions.ts`
529, `controllers/settingsView/settingsAgentCommands.ts` 526,
`controllers/settingsView/sharedSettingsCommands.ts` 467.

Comment share of the five worst files ≥ 200 lines (`^\s*(/\*|\*|//)` over
total): `hosts/uiHosts.ts` 52% (142/271), `controllers/onboarding/onboardingFunnel.ts`
36% (107/292), `controllers/modelAccess/subscriptionProviders.ts` 29%
(106/357), `platform/defaults/commandDirs.ts` 26% (69/263),
`controllers/settingsView/ToolDashboardData.ts` 24% (51/210). Of these,
`uiHosts.ts` and `onboardingFunnel.ts` explain a protocol in prose (findings
10 and 6); the other three are contract tables and acceptable.

Primitives (grep over the area, `controllers/server` included since it shares
the directory): `new Promise` 0, `.then(` 0, `Effect.ignore` 10,
`Effect.uninterruptible` 7, `Effect.never` 5, `Deferred.*` 37, `isDoneUnsafe`
1, `*Unsafe` 21, `addObserver` 0, `setTimeout` 1 (`utils/system/unrefSleepClock.ts`),
`Date.now` 0, `catch {}` 0, `Effect.catchCause` 11, `Effect.orDie` 3,
`Semaphore` 10 (four `Semaphore.makeUnsafe(1)` lanes in
`onboardingFunnel.ts:226`, `hostSnapshotSource.ts:285`,
`UsageLogService.ts:196`, `settingsToolCommands.ts:47`), `Queue.*` 8,
`SubscriptionRef` 48, `Effect.timeout*` 8, `Schedule.*` 6. Verified per file
below: `ToolEditApprovalController.ts` holds 5 `Effect.uninterruptible`
(`:238,244,264,335,424`), 3 `Effect.never` (`:205,285,338`), one
`Deferred.isDoneUnsafe` (`:320`), one `doneUnsafe` (`:331`) and a `staged` Map
(`:187`); `hostDraftRequests.ts` holds 2 `Deferred.makeUnsafe` (`:171-172`), 3
`Deferred.doneUnsafe` (`:141,143,281`), a `forkDetach` (`:182`) and a listener
`Set` (`:58`); `hostRunActions.ts` holds 5 `Effect.ignore`
(`:239,254,364,401,524`).

---

## Finding 1. The tool-edit preview fights the scope it already lives in: five `uninterruptible`, a `settled` Deferred beside the scope, and a mutable entry shared with the LaTeX preview module

**Red flags:** reinvented Effect primitives; two representations of one
lifetime; information leakage (a protocol in a mutable record two modules
write); comments substituting for design.

**Evidence.** `followPendingRequests` (`packages/harness/src/effect/requestAnswerer.ts:90-120`)
already gives each pending request one fiber in a `FiberMap`, interrupted
when the view drops the request. `ToolEditApprovalController.stage`
(`controllers/approval/ToolEditApprovalController.ts:273-340`) runs inside
that fiber under `Effect.scoped` and then rebuilds the same lifetime by hand:

- `settled = Deferred.make<void>()` (`:289`), completed from the scope's
  finalizer (`:331`) and read back as `isSettled: () => Deferred.isDoneUnsafe(settled)`
  (`:320`): "the scope is closing" spelled as a Deferred.
- `staged: Map<string, StagedPreview>` (`:187`), set and deleted in a second
  `acquireRelease` (`:326-333`): the FiberMap's key set, copied.
- `entry` (`:310-325`) is a `LatexPreviewEntry`
  (`tools/latex/latexPreview.ts:47-72`) whose `workspaceTempCleanup: Array<Effect>`,
  `latexOperationInProgress: boolean`, `settled`, `isSettled` and `onError`
  are the other module's protocol: `registerCleanup` (`latexPreview.ts:142-150`)
  pushes a removal onto the array "or runs it now if the entry already
  finished", and `withLatexOperation` (`:156-180`) is a hand-written mutex
  (`if (entry.latexOperationInProgress) return Effect.void; entry.latexOperationInProgress = true; … ensuring(false)`)
  raced against `Deferred.await(entry.settled)`. The controller then runs the
  array in its release (`:304-306`).
- Five `Effect.uninterruptible` (`:238,244,264,335,424`) keep a host call
  alive past the scope's close. The comment at `:258-261` explains why the
  approval is forked into the entry's scope uninterruptible: "the view can
  drop the request (this approval recorded, or another window's) before the
  answer comes back", so the finalizer's `unapplied` read (`:359-396`) can see
  `applied` (`:290`, a `Ref<boolean>` set after the round trip, `:347`).
  Yet the request that called `handleAction` already runs uninterruptible in
  the bridge (`controllers/session/SessionBridge.ts:420`), and the window
  closes its bridge scope detached so requests in flight finish
  (`controllers/session/openGuiWindow.ts:338-341`).
- "Did this window's approval get recorded" is derived twice at release:
  the `applied` Ref, then a re-read of `view.current().requests` (`:375-380`)
  to tell a window closing from a request ending.

Consumers: `ToolEditApprovalController` 8 files (1 non-production);
`LatexPreviewEntry` is built only here (`:310-325`); `readToolEditPreview`
4 files.

**The design decision behind it.** Who owns a staged preview's lifetime is
answered three times: the FiberMap's fiber, the entry's `settled` Deferred,
and the `staged` Map. Because the answer "my approval was recorded" is a
local Ref set after a round trip, the approval must be shielded from the
very interruption that is the fiber's one signal.

**The better design.** One owner: the request's fiber and its scope.

- The LaTeX previews take a `Scope` (or run under `Effect.scoped` with
  `Effect.addFinalizer` for each temp file) instead of an array they push
  onto; "already finished" cannot happen inside a scope that is still open.
  `withLatexOperation`'s boolean becomes a `FiberHandle` per entry run with
  `FiberHandle.run(handle, operation, { onlyIfMissing: true })` (a second
  click while one runs is a no-op, as today), and its `raceFirst(settled)`
  goes: the scope's close interrupts the handle.
- The approval runs in the request fiber that already is uninterruptible,
  and `handleAction` answers when `request.decide` has been recorded; the
  `forkIn(entry.scope)` and four of the five `uninterruptible` go. The
  `openBuildDisplay` fork (`:421-429`) keeps `forkIn(scope)` and loses the
  mask: a window that closes mid-build interrupts the build, which is what
  closing a window means.
- "Was it this window's decision" is a fact of the decision row: with R7's
  `answeredBy` on `request.decided`, the release reads the run's rows
  (`session.records`/the view's decided requests) instead of a Ref written
  after the fact; until R7, the Ref stays and the re-read of `requests`
  (`:375-380`) goes, because `Effect.addFinalizer((exit) => …)` hands the
  finalizer the exit it closes under (the window's scope closes with its own
  exit; a request drop is the follower's interrupt).

**Deleted:** `LatexPreviewEntry.settled`, `.isSettled`, `.workspaceTempCleanup`,
`.latexOperationInProgress`, `.onError` (0 other builders), `registerCleanup`
(1 caller), the `staged` Map's second `acquireRelease` (`:326-333`),
`Deferred.isDoneUnsafe`/`doneUnsafe`, four `Effect.uninterruptible`, the
`listed` re-read; `StagedPreview.applied` after R7.

**What we give up.** An approval sent a frame before the request vanished is
answered by the bridge, not by the entry's scope; a host build still reading
staged files when the window closes is interrupted rather than awaited
(today's `:418-420` comment promises the wait).

**Change amplification.** "A second host (the desktop) adds a Review-pane
action on a staged preview": today `ToolEditPreview` (`:128-144`),
`handleAction`'s switch, `LatexPreviewEntry` if it needs the files, and the
host: 4 files; after: the action on `ToolEditPreview` and the switch: 2.

**Depends on:** none for the scope and mutex; R7 for `applied`.

---

## Finding 2. The process recorder is a state machine in two booleans, two Deferreds, a detached fiber and a listener set

**Red flags:** state machine in sentinel fields; reinvented Effect
primitives (observer set, fiber handle, latch); `*Unsafe` cluster.

**Evidence.** `controllers/session/hostDraftRequests.ts`: `Take` (`:40-51`)
carries `result: Deferred`, `settled: Deferred`, `stopping: boolean`,
`cancelled: boolean`; the class holds `take: Take | null`, `takeFiber: Fiber | null`
(`:55-57`) and `listeners = new Set<(recording) => void>()` (`:58`) with
`subscribe`/`notify`/`release` (`:83-87, 289-298`). `start` (`:153-184`)
makes both Deferreds unsafe (`:171-172`), forks the take detached (`:182`)
and awaits `result`; `stop` (`:275-282`) sets `stopping` and completes
`settled`; `cancel` (`:132-144`) sets `cancelled`, completes `result` with
`Cancelled` and then `settled`; the take fiber reads `take.cancelled` after
the race (`:224`) to decide between "stopped" and "cancelled";
`shutdown` (`:148-151`) calls `cancel` then interrupts the fiber. The
listener set exists so each window can `fork(snapshot.setRecording(recording))`
(`openGuiWindow.ts:360-364`), i.e. to feed a `SubscriptionRef`. Consumers:
`HostDraftRequests` 6 files, one instance per process
(`packages/extension/src/progressView/ProgressViewProvider.ts:163`,
`packages/desktop/src/main/index.ts:93`).

**The design decision behind it.** "Is a take running, and in which state"
is held as four fields plus the nullable fiber, so each verb (start, stop,
cancel, window close, shutdown) writes a different subset and the fiber reads
the booleans after its race to learn why it was woken.

**The better design.** The recorder is `recording: SubscriptionRef<Recording | null>`
(hosts read `SubscriptionRef.changes`, 27 uses in the repo) and one
`FiberHandle` (9 uses in the repo) in the process scope:

- `start` = `FiberHandle.run(handle, takeProgram, { onlyIfMissing: true })`
  then `Fiber.join`: a second start finds the handle full and fails
  `Rejected` as today (`:160-163`).
- `stop` = open a `Latch` the take awaits after `startRecording`; the sox
  scope closes, transcription follows.
- `cancel` (a window or session going, or shutdown) = `FiberHandle.clear`:
  the interrupt kills sox through the recorder's scope and the join fails
  with the interrupt, which the request answers as `Cancelled`. A cancel
  after stop interrupts the upload, as the `raceFirst` at `:263` does now.
- The take's result is the fiber's exit; `Deferred.into` (`:270`) and
  `result` go.

**Deleted:** `Take.result`, `Take.settled`, `Take.stopping`, `Take.cancelled`,
`takeFiber`, `listeners`, `subscribe`, `notify`, `release`, `recording()`,
the two-step `shutdown`, `attach`'s `onRecording` callback (the window reads
the ref); `Deferred.makeUnsafe` ×2, `doneUnsafe` ×3, `forkDetach` ×1.

**What we give up.** `cancel(roots, port?)`'s identity test on `roots`
(`:135-138`) becomes the handle's owner field; nothing user-visible.

**Change amplification.** "A third host (the CLI) records": today it must
implement `subscribe` and feed its own status line through the listener,
and know the start/stop/cancel booleans: 2 files plus the class; after: it
reads the ref and calls the two verbs: 1 file.

**Depends on:** none.

---

## Finding 3. The host snapshot is a `SubscriptionRef` written by hand: ten `let`s, a lane, a `publish` closure, and four capabilities decided by optional members

**Red flags:** reinvented Effect primitive; two representations of one fact;
state machine in optional fields; a callback where the failure channel is.

**Evidence.** `controllers/session/hostSnapshotSource.ts` keeps eleven
mutable locals (`catalogs`, `fileOptions`, `hasInputFiles`, `commits`,
`apiKey`, `dependency`, `recording`, `agentConfig`, `onboarding`,
`serviceOffline`, `dismissed`; `:168-193`) and a `publish` closure that
assembles them (`:195-223`) into the `HostSnapshot` the window already holds
as `SubscriptionRef<HostSnapshot | null>` (`openGuiWindow.ts:342`, with
`publish: (next) => SubscriptionRef.set(hostSnapshot, next)` at `:358`): two
stores for one record. Six producers each `yield*` a read and assign a local
(`:229-277`), serialized by `refreshLane = Semaphore.makeUnsafe(1)` (`:285`)
because "two refreshes in flight at once … would let the slower, older read
publish last" (`:279-284`); `guarded` (`:290-305`) collects exits and
reports through `options.onError(error: unknown): void` (`:113`), a callback
in place of the log and the failure channel. Three setters repeat
"`if (same) return; field = x; publish`" (`:353-364`, `:322-325`). Which
banners a host has is decided by presence: `workspaceRoots?`, `apiKeyBanner?`,
`dependencyBanner?`, `gettingStartedBanner?: true` (`:94-110`); the
extension supplies all four
(`packages/extension/src/progressView/ProgressViewProvider.ts:290-331`), the
desktop none. The CLI-service note (§3.3) ruled the same shape for `emit`:
"a capability decided from optional members". `HostSnapshotReadFailed.member`
(`:57-68`, three literals) has no reader (0 `catchTag`/`_tag` sites; its
only consumer is `onError(Cause.squash(...))`, `:302`).

**The design decision behind it.** The snapshot's producers do not own the
field they produce; a central closure re-reads every local and a lane orders
the whole refresh, so a change to one field is a change to the whole record
and to the ordering rule.

**The better design.** `HostSnapshot` is the one `SubscriptionRef` the
window makes; each producer is `SubscriptionRef.update(ref, (s) => ({ ...s, agentOptions }))`
after its own read, so a field's last write wins per field and no lane is
needed across producers. A producer with bursty inputs (file-watcher events)
is a `Stream` of its signal with `Stream.debounce` (5 uses in the repo) into
one `update`. `refreshCatalogs`/`refreshFiles`/`refreshCommits`/
`refreshHostBanners` stay as the names of those streams' "run once now"
effects. A banner a host does not show is `Effect.succeed({ visible: false })`
in its options, so every member is required and `gettingStartedBanner` is a
producer like the others. A failed producer logs at warn (`Effect.ignore({ log: 'Warn' })`
is already the idiom here, `hostRunActions.ts:239`) and leaves its field;
`onError` goes.

**Deleted:** the eleven locals, `publish`, `refreshLane`, `guarded`,
`onError`, `HostSnapshotReadFailed` (3 files, 0 readers of `member`), the
three setters' change checks, the optional markers on four members;
`openGuiWindow`'s `Omit<Parameters<typeof createHostSnapshotSource>[0], …>`
type (`:268-271`) becomes the producers record.

**What we give up.** The whole-refresh ordering guarantee becomes per field
(which is the fact the shell shows anyway); the desktop writes two constant
banner producers.

**Change amplification.** "A new banner only one host answers": today
`shared/session/hostSnapshot.ts` (shape), `hostSnapshotSource.ts` (a local,
an option, `loadHostBanners`, `publish`, the `dismissBanner` union), both
hosts' option objects, the `Omit` in `openGuiWindow.ts`, the UI component: 6
files and 5 sites in one of them; after: shape, the one host's producer, the
UI: 3 files.

**Depends on:** none (finding 6 lands its `onboarding` field on this ref).

---

## Finding 4. `openGuiWindow` binds the hosts to a contract typed by four other modules' parameter lists, and carries the window's parts as a thirteen-field bag

**Red flags:** information leakage; services bag; two representations of
"which kinds the body answers".

**Evidence.** The CLI-service note (§3.3, "`openGuiWindow.ts` does five
jobs"; §4 Status says four of them moved) is found and not repeated. What
stands:

- `GuiWindowHost` (`openGuiWindow.ts:236-261`) types a host's half as
  `Omit<ConstructorParameters<typeof ProgressWorkflowFileActionsController>[0]['host'], 'showInfo'>`
  (`:245-250`), `Pick<Parameters<typeof exportRunTranscript>[1], 'pickFormat' | 'openPath'>`
  (`:254-257`), `Omit<Parameters<typeof createHostSnapshotSource>[0], …>`
  (`:268-271`), and `hostRunActions.ts:107-110` types `loadModelOptions` as
  `Parameters<typeof planCompileFixer>[0]['modelOptions']`. Two hosts
  (`packages/extension/src/progressView/extensionHostRequests.ts`,
  `packages/desktop/src/main/desktopHostRequests.ts`) implement a contract
  nobody wrote: a parameter rename in `exportTranscript.ts` is a host break.
- `SharedParts` (`:519-535`) is thirteen members (`bridge`, `snapshot`,
  `runActions`, `apiKeyRetry`, `workflowFileActions`, `draftRequests`,
  `toolEditApprovals`, `session`, `roots`, `bindings`, `latexdiff`,
  `showInfo`, `openDirectory`, `exportTranscript`) assembled at `:460-486`
  and passed to one function, `answerShared`, which reads them by
  destructuring: the same shape AGENTS.md calls a services bag.
- `SHARED_HOST_REQUEST_KINDS` (`:110-140`, 29 literals) and `OWN_REQUEST_LABEL`
  (`:160-168`, 7 keys) are complements of the 41-kind `HostRequest` union
  (`shared/session/hostRequest.ts`); `OwnHostRequest` is defined as
  `Exclude<HostRequest, SharedHostRequest>` (`:148`), so one list restates
  the other, and `isSharedHostRequest` (`:174-176`) exists to route on the
  copy.
- A pack or clean result is a four-state `FileOpResult`
  (`shared/session/hostRequest.ts:241-250`) produced at
  `hostRunActions.ts:449` (`{ status: 'missingParams' }` for an empty input
  file) and turned into a message with a `level` by `fileOpResultMessage`
  (`:288-317`), whose `'error'` level is then raised as `Rejected` at
  `:735-736`: a refusal travels two modules as a status, then a level, then
  a tag. The CLI note's "toolbar actions refuse with `Rejected`" landed for
  `latexdiff`; the status union survives for pack/clean.

**The design decision behind it.** The host contract is "whatever the four
controllers happen to take", so the module that should hide the hosts'
differences exports their internals instead.

**The better design.** `GuiWindowHost` is written out as the one host
interface (its members name capabilities, not controllers), and each
controller takes `Pick<GuiWindowHost, …>`: the dependency points from the
controller to the contract. `answerShared` is a method over the window
(`this.runActions`, …) or takes the window record the builder already made;
the thirteen-member bag is the window itself. One of the two kind lists goes:
`OWN_REQUEST_LABEL`'s keys define `OwnHostRequest`, `SharedHostRequest` is
`Exclude<HostRequest, OwnHostRequest>`, and the router checks
`request.kind in OWN_REQUEST_LABEL`. `workflowFileOperation` fails
`Rejected` at `:448-449` where it knows the input file is missing, and
`FileOpResult` keeps `success | noFiles` (both notices); `error` is the
`run.files` request's own failure.

**Deleted:** the four `Parameters<typeof …>`/`ConstructorParameters<…>` host
types, `SharedParts` (one consumer), `SHARED_HOST_REQUEST_KINDS`,
`sharedHostRequestKinds`, `isSharedHostRequest`, `FileOpResult.missingParams`
and `.error` (producers: `hostRunActions.ts:449` and `run.files`'s mapping at
`:476-483`), `fileOpResultMessage`'s `level`.

**What we give up.** `satisfies readonly HostRequest['kind'][]` on the shared
list as an exhaustiveness check; the `absurd`-style check moves to the
`switch` in `answerShared`, which already has no `default`.

**Change amplification.** "A new shared host request kind that needs a host
verb" (measured on `dismissBanner`, a kind without a verb: 4 files;
`openRunStorage`: 5): today `hostRequest.ts`, `openGuiWindow.ts` ×2 sites,
`SharedHostRequestBindings`, both hosts' tables, the UI sender: 7 files;
after the one list: 6, and the host types stop moving when a controller's
signature does.

**Depends on:** none; R10's app half (finding 5) touches the same file.

---

## Finding 5. `hostRunActions` presents a refused launch from three sites, opens a finished run's output from two, and takes three ports that forward one call each

**Red flags:** repetition; error handling that should be defined out of
existence (five `Effect.ignore` tails); pass-through ports; an optional port
as a capability; a `null` sentinel.

**Evidence.** `controllers/session/hostRunActions.ts`:

- A launch that fails before its run opens is presented at `:226-231`
  (`runValidated`, `tapError` → `presentRunFailure`), at `:383-390` (`resume`,
  `catchTag('RunFailure')` → `presentRunFailure` when `launchNoticeOf` says
  so, answering `null`, read at `:390`), and at `:518-525` (`fork`'s resume,
  `tapError` → `presentRunFailure`, then `Effect.ignore`). R10 found the
  CLI's three copies (F3); these are the app's.
- "Open the final output when the run ends" is written at `:250-258`
  (every `runValidated`, no config check) and at `:391-401` (`resume`, only
  when `isTaskConfig(config)`), with different guards; `fork` does neither.
- Five `Effect.ignore` (`:239,254,364,401,524`) end five detached tails:
  reveal, open output ×2, the follow-up notice, the fork's resume.
- `readConfig` (`:83-85`) is bound as `session.records(runId).readConfig()`
  (`openGuiWindow.ts:417`) and re-tagged `RunConfigUnreadable` (`:68-71`, 1
  file, 0 `catchTag` sites); `loadModelOptions` (`:107-110`) is bound as
  `loadModelOptions(roots)` under the env layer (`openGuiWindow.ts:421-425`),
  both of which the body can build from `roots` it already holds; `scope`
  (`:97`) is the window's; `present` (`:87`) is `new SessionHostInteractions(host.window)`
  (`openGuiWindow.ts:378`), the window-side instance the CLI note (§3.3) said
  goes with "`presentRunFailure` takes a plain `emit`"; `revealProgress?`
  (`:91`) is absent "on a host whose surface is always on screen", an
  `Effect.void` written as absence.
- `runOutputs` (`:288-290`) is an object with one method that forwards
  `documentsOf(run).files`, passed as `state` to
  `ProgressWorkflowFileActionsController` (`openGuiWindow.ts:430`).

Open PR: PR 14713 changes this file (+22/−7) to carry the accepted-edit
follow-up; this finding sequences after it.

**The design decision behind it.** "What this window does when a run it
started begins and ends" is decided per action instead of once, so each
action re-states the presentation and the end hook, and a refusal's
presenter is passed in rather than owned.

**The better design.** One `launch(program)` in the body: `program` is
`session.start(...)` or `session.resume(...)`; `launch` presents a refused
launch once (`presentRunFailure(emit, …)` with the window's plain `emit`),
calls `launched`, and forks one `whenEnded(run)` in the window scope that
reads the run's saved config through `session.records` and opens its output
under one rule (`isTaskConfig`). `runValidated`, `resume`, `fork` and
`runCompileFixer` call it. `readConfig`, `loadModelOptions`, `scope`,
`present` and `revealProgress?` leave the ports: the body yields `Scope`,
holds `roots`, builds `workspaceEnvironmentLayer(roots.workspace)` as
`openGuiWindow` does (`:337`), and takes `emit` and `revealProgress: Effect`
(the desktop passes `Effect.void`).

**Deleted:** `RunConfigUnreadable` (0 readers), `HostRunActionPorts.readConfig`,
`.loadModelOptions`, `.scope`, `.present`, the optional on `revealProgress`,
the second output-open at `:391-401`, two of the three `presentRunFailure`
sites, `resume`'s `null` branch, `runOutputs` (its one consumer reads
`documentsOf` from the view directly), three of the five `Effect.ignore`.

**What we give up.** `resume`'s distinct guard (`isTaskConfig` only) becomes
the one rule for every launch; a non-task run's `openFinalOutput` is the
host's no-op today, so nothing user-visible.

**Change amplification.** "A new run-starting action (rerun from a
checkpoint)": today `HostRunActions` (interface, implementation, its own
present and end hook), `openGuiWindow.ts` (kinds list and switch),
`hostRequest.ts`, the UI: 4 files and a third copy of present/ended; after:
the same 4 files and zero copies.

**Depends on:** R10 (hosts bind verbs to one action body: this is its app
half; the harness half landed in PR 2 of the CLI-service plan).

---

## Finding 6. The onboarding funnel is a coalescing refresh loop written as a boolean, a lane and a mutable `current`, and its state lives three times

**Red flags:** reinvented Effect primitive (a derived `Stream`); state
machine in mutable fields; two (three) representations of one fact; a
callback with two shapes; comments substituting for design (36%).

**Evidence.** `controllers/onboarding/onboardingFunnel.ts`:
`OnboardingFunnelRefresher` (`:225-292`) holds `lane = Semaphore.makeUnsafe(1)`,
`rerunRequested = false`, `current` (`:226-228`); `run` sets the boolean and
takes the permit (`:286-291`); `drain` loops while the boolean is set
(`:274-281`); the comment at `:210-223` explains the pairing ("The latch and
the program it reruns are one pair, so a caller's `run` can only ever be
answered by this refresh"). The derived state is then published through
`apply` (`:205-207`) and stored again: the desktop keeps it in
`funnelState = SubscriptionRef.make<OnboardingFunnelState | null>(null)`
(`packages/desktop/src/main/desktopWindowOnboarding.ts:97-98`,
`:118`), the extension writes it to `snapshot.setOnboarding`
(`packages/extension/src/progressView/ProgressViewProvider.ts:202`): three
copies of one derived fact, plus `hostSnapshotSource.ts:190`'s `onboarding`
local (finding 3). The transition record carries `selectSetupAgent` and
`clearDeclined` (`:153-160`); the desktop "discards that case" (`:201-203`,
`desktopWindowOnboarding.ts:99-103`), so a field of the shared record is one
host's event. The credential probe is a function the host supplies
(`hasCredential: () => Effect`, `:196`); the extension answers it from a
field it keeps (`() => Effect.sync(() => this.credentialUsable)`,
`ProgressViewProvider.ts:200`), a fourth copy of a fact. `firstRunDone` is
written by `recordFirstCompletedRun` (`:94-116`, a forked view watcher plus a
finalizer re-check) and read back through `AppState.changes` by
`followFirstRunDone` (`:125-130`); that round trip through the global store
is legitimate (another process may hold the run; R1 keeps the global store's
multi-process reads) and is not the finding.

Consumers: `OnboardingFunnelRefresher` 3 files, `followFirstRunDone` 3,
`setOnboardingDeclined` 4, `recordFirstCompletedRun` 5 (all production).

**The design decision behind it.** The funnel state is derived from three
inputs but delivered by a pull ("refresh now") that each host triggers
from the places it believes the inputs changed, so the refresher must
coalesce triggers and remember its last answer, and each host keeps the
answer again to render it.

**The better design.** `onboardingState(flags, credential): Stream<OnboardingFunnelState>`:
`Stream.zipLatest` (1 use in the repo) of `flags.changes([DECLINED_KEY, FIRST_RUN_DONE_KEY])`
and a credential stream (`Stream.concat(Stream.make(void), appSignalStream('credentialChanged'))`
as `sharedSettingsCommands.ts:453` already follows, `Stream.mapEffect(probe)`),
mapped through `deriveOnboardingFunnelState` and `Stream.changes` (8 uses).
The window pipes it into the snapshot ref's `onboarding` field (finding 3):
one owner. The extension's "select the setup agent on entering `setup`" is
its own `Stream.zipWithPrevious` filter on that stream, not a field the
desktop ignores. `clearDeclined` is written where a credential appears
(the same signal), or dropped (see below).

**Deleted:** `OnboardingFunnelRefresher`, `lane`, `rerunRequested`,
`current`, `state`, `drain`, `run`, `OnboardingFunnelTransition`,
`planOnboardingFunnelTransition`, `OnboardingFunnelHost.apply`, the
desktop's `funnelState` ref and `refresh` plumbing, the extension's
`refreshOnboardingFunnel` and `credentialUsable` as the probe's answer; the
`:210-223` comment.

**What we give up.** `clearDeclined` only matters when a user who skipped
later gains and then loses every credential (they would see `done` instead
of the picker); keeping it is one `Settings` write on the credential signal.

**Change amplification.** "A fourth input to the funnel (a workspace has a
`.tex` file)": today the inputs record, the planner, the refresher's reads,
both hosts' trigger sites: 3 files, 5 sites; after: the stream's
`zipLatest` and the derivation: 1 file.

**Depends on:** none; lands with finding 3's ref.

---

## Finding 7. `SessionBridge` keeps a port's replay fiber and its pre-subscribe queue as nullable fields, tests a scope's `_tag`, and masks every request

**Red flags:** state machine in sentinel fields; reinvented Effect
primitives (`FiberHandle`, a queue); a protocol in comments.

**Evidence.** `controllers/session/SessionBridge.ts`: `PortEntry.fiber: Fiber | null`
(`:147`) and `held: SurfaceActionMessage[] | null` (`:153`, "null once it
has subscribed"); `subscribe` (`:255-302`) interrupts the previous fiber by
hand before forking the next ("the next replay's fiber interrupts the one in
flight before its first frame", `:250-253`), which is `FiberHandle.run`'s
contract (9 uses in the repo); `act` (`:186-194`) pushes to `held` or sends,
and the `subscribe` case drains it (`:345-347`). `attach` (`:196-247`) reads
`this.scope.state._tag === 'Closed'` for three scopes (`:213-217`) with a
comment on `Scope.fork` semantics (`:210-212`); the repo has 3 such reads,
all here. `answer` (`:391-424`) wraps every request `Effect.uninterruptible`
(`:420`) so the bridge "drains the requests in flight rather than cutting
them" (`:17-20`), which makes a hung host handler uninterruptible for the
window's life (the CLI note's `ANSWER_WITHIN` comment, §3.3). The wire
response `{ ok: false, error: wireError(...) }` is built at four sites
(`:322-330`, `:356-358`, `:375`, `:403-406`).

**The better design.** `PortEntry.fiber` is a `FiberHandle` made in the
port's `framers` scope; `subscribe` is `FiberHandle.run(handle, frames)`.
`held` is a `Latch` (`Latch.make`, opened by the first `Subscribe`) that
`act` passes through `Latch.whenOpen` before `port.send`, so a message sent
before the surface mounts waits instead of being queued by hand; the `null`
sentinel goes. The closed-bridge
refusal is one check on the bridge's own `Scope` before forking. Requests
are forked into a `FiberSet` the bridge joins under the close deadline
(`Effect.timeout`), not masked: a close waits, then interrupts what is
still hung. One `respond(entry, requestId, exit)` writes the response.

**Deleted:** `fiber`/`held` nullables, the three `_tag` reads, the manual
`Fiber.interrupt(previous)`, `Effect.uninterruptible` at `:420`, three of
the four response builders.

**What we give up.** A request still running at the close deadline is
interrupted instead of finishing silently after the port is gone (today its
answer is dropped at `:411`, so nothing is lost).

**Change amplification.** "A third port kind (the trace viewer attaches as a
port)": unchanged file count; the state it must not get wrong shrinks from
two nullables to none.

**Depends on:** none.

---

## Finding 8. The settings body repaints by hand: every mutation names the pages it feeds, and the host's name is a discriminator in shared code

**Red flags:** information leakage (which input feeds which page is known
at each write site); temporal decomposition (post at startup, follow later);
a boolean parameter constant per caller; special and general code mixed.

**Evidence.** `controllers/settingsView/sharedSettingsCommands.ts`:
`refreshAfterCredentialChange` (`:178-191`) lists four posters;
`subscriptionChange` (`:194-205`) two more; `updateStateSetting` (`:270-281`)
branches on `result.entry.surfaces.settingsView`, `onWrite?.invalidatesModelOptions`,
`codingPlanForUsageSetting(key)` and `key === APPROVAL_POLICY_CONFIG_KEY` to
decide what to repaint; `stateSnapshotPosters` (`:239-249`) is the table of
nine; `postAll` (`:323-334`) is the startup copy of the same set; `followRepaints`
(`:426-465`) is the later copy, per signal. `settingsAgentCommands.ts:178-190`'s
`refreshAfterAgentMutation(selected?, agentCatalogAlreadyFresh = false)` takes
a boolean that is `true` at `:217,224,458,490,511` and defaulted at
`:198,294,338,366,411`: "did I already refresh" as a parameter.
`allSettledVoid` (`utils/core/allSettledVoid.ts`, 4 consumers) is the glue
for these fan-outs; its header's reason for existing beside
`Effect.all(…, { mode: 'result' })` (a defect still fails the call) stands,
so it goes with its callers, not by replacement. The one page that follows its input as a stream,
`followToolAvailability` (`settingsToolCommands.ts:127-137`,
`SubscriptionRef.changes(availability.results)` → `Stream.changes` →
repaint), is the shape the rest should have. The body also takes
`host: 'vscode' | 'desktop'` (`:89`) to compute `installsExtensions: ports.host === 'vscode'`
(`:125`) and to index `WRITABLE_ENTRY_BY_KEY[ports.host]`
(`shared/settingsView/handlers/stateSettingWrite.ts:78`), beside
`requiresOpenWorkspace?` (`settingsHostBindings.ts:60`), which is already the
capability form of the same fact.

**The design decision behind it.** A page's data is pulled by whoever
changed something, so the dependency graph from inputs to pages is spelled
at every mutation, twice (startup and later).

**The better design.** Each page is a `Stream<SettingsViewOutboundMessage>`
derived from its inputs (`AppSignals`, `state.changes(keys)`,
`SubscriptionRef.changes`, the secret store's announcements), prefixed with
its current value (`Stream.concat(Stream.make(void), changes)` as
`followToolAvailability` and `followFirstRunDone` already do), and
`bindings.post` runs each; a mutation handler writes and returns. The
"probes first, then catalogs" order (`:172-177`) is a dependency between
two streams (the models page follows the probe's output, not the raw
signal). `installsExtensions` and the writable-entry table are two booleans
on `SettingsHostBindings` beside `requiresOpenWorkspace`; `host` goes.

**Deleted:** `refreshAfterCredentialChange`, `subscriptionChange`'s repaint
half, `stateSnapshotPosters`, the four branches at `:272-281`, `postAll`,
`agents.postStartup`, `toolsPage.postStartup`, `refreshAfterAgentMutation`'s
boolean, `allSettledVoid` (4 → 0 consumers), `SettingsViewBodyPorts.host`.

**What we give up.** The explicit "this write repaints these pages" reading
at the handler; a page that reads a slow input repaints when that input
changes, not when a user clicked.

**Change amplification.** "A new settings page that depends on provider
keys": today `settingsViewMessages.ts`, its poster, `postAll`,
`refreshAfterCredentialChange`, `followRepaints`, `stateSnapshotPosters`: 2
files, 5 sites; after: the message and one stream: 2 files, 2 sites.

**Depends on:** none.

---

## Finding 9. `UsageLogService` builds a batching sender from an array, a dropping trigger queue, a boolean, a lane, a retry slot and two once-flags

**Red flags:** reinvented Effect primitives (`Queue.sliding`,
`Stream.groupedWithin`, `Effect.retry`); state in nullable fields; a
documented drain protocol.

**Evidence.** `telemetry/UsageLogService.ts`: `queue: QueuedUsageEntry[]`
with a `shift()` at `MAX_QUEUE_SIZE` (`:278-281`), `triggers: Queue<void> | null`
of capacity 1, dropping (`:226-230`), gated by `backgroundFlushActive`
(`:199, :303-308`), `flushLane = Semaphore.makeUnsafe(1)` (`:196`),
`flushTimer: Fiber | null` (`:193`), `retryBatch: RetryBatch | null` with
`keepForRetry` applied at two steps (`:421-439`), `warnedUndelivered`/
`warnedRejected` (`:200-201`), and `drainAndStop` (`:563-597`) that
interrupts the timer, flips `config.enabled`, forks a warning fiber, takes
the lane and drains. `Effect.orDie` (`:358`) feeds `catchDefect` (`:373`).
The repo already uses `Schedule`, `Effect.retry` and `Queue` here; what is
hand-rolled is the pipeline between them.

**The better design.** `Queue.sliding<QueuedUsageEntry>(1000)` →
`Stream.fromQueue` → `Stream.groupedWithin(batchSize, flushIntervalMs)` →
`Stream.mapEffect((batch) => sendBatch(batch).pipe(Effect.retry(backoff)))`
→ `Stream.runDrain`, forked with `Effect.forkScoped` in the layer's scope.
The per-entry consent re-read stays in `sendBatch`. Shutdown is `Queue.end`
(the stream completes after the last batch) then `Fiber.join` under
`Effect.timeout(5s)`. The "once at warn, then debug" flags go: the backoff
already quiets the loop, so every undelivered batch logs once per attempt
through `Effect.tapError` before `Effect.retry`.

**Deleted:** the array and its shift, `triggers`, `requestFlush`,
`backgroundFlushActive`, `flushTimer`, `retryBatch`, `RetryBatch`,
`keepForRetry`, `drain`'s `while`, `backgroundFlush`, `drainAndStop`'s
warning fiber, the `orDie`/`catchDefect` pair; `unrefSleepClock`
(`utils/system/unrefSleepClock.ts`, 3 consumers) if every host disposes its
runtime on exit, which interrupts the sleep.

**What we give up.** A host that exits without disposing its runtime would
be held by the backoff sleep; keep `unrefSleepClock` for that host if it
exists (the CLI's headless path should be checked).

**Change amplification.** "A second telemetry sink": today the class's
twelve fields and the drain; after: a second `mapEffect` branch.

**Depends on:** none.

---

## Finding 10. `hosts/uiHosts.ts` is 52% prose that explains why each port exists, cites owner rulings, and defines five error tags nothing branches on

**Red flags:** comments substituting for design; error kinds nothing
branches on; an error field that is a message; document citations in code.

**Evidence.** 142 of 271 lines are comments; `:44` and `:67` cite "owner
ruling 2026-09-18" (AGENTS.md "Plain names and comments": no document
citations in code). `DiffViewHost` (`:27-34`) is prefaced by eleven lines on
why the terminal has no implementation. After #14776 removed
`PromptFailed.reason`, the remaining kind fields still have no reader:
`PromptFailed.member` (`:99`, two literals; 0 `catchTag`/`_tag` sites),
`NotificationFailed.member` (`:125-129`, three literals; 5 `catchTag` sites,
every one logs and continues, e.g. `settingsHostBindings.ts:88-92`),
`ExternalOpenFailed.kind` (`:53`; 0 branch sites across 9 files that name
the type). In the controllers the same pattern recurs: `HostCallFailed`
(`hostCallFailure.ts:20`, 0 branch sites), `TranscriptExportFailed.step`
(`progressView/transcriptExportFailure.ts:27`, four literals, 0 readers),
`HostSnapshotReadFailed.member` (finding 3), `ApiKeyPromptFailed`
(`ProgressApiKeyRetryController.ts:32`, 0), `RunConfigUnreadable`
(finding 5, 0), `CompileFixerPlanFailed` (`compileFixer.ts:33`, 0),
`GlobFailed` (`housekeeping/utils.ts:20`, 0). `TerminalRunFailed.reason`
(`:252-255`) has one reader (`tools/setup/SendToTerminalTool.ts:73`) and
stays. These add to `2026-11-03-storage-errors-and-stop-paths.md` §3
("kinds nothing branches on"); none is listed there.

**The better design.** One `HostFailed { member, message, cause }` for the
app's host ports, which `HostCallFailed` already is in shape; the presenters
(`settingsPresentation.report`, `presentRunFailure`) word it. The port
comments shrink to each member's contract (what a dismissal answers, that
interruption detaches), two to four lines each.

**Deleted:** `PromptFailed` (7 files), `NotificationFailed` (13 files; the 5
catch sites catch `HostFailed` and log as now), `ExternalOpenFailed` (9+2
files), `HostSnapshotReadFailed`, `TranscriptExportFailed.step`,
`RunConfigUnreadable`, `CompileFixerPlanFailed`, `ApiKeyPromptFailed`,
`GlobFailed` → `HostFailed` or the raising module's existing error; the two
ruling citations and about 100 comment lines.

**What we give up.** A `catchTag('NotificationFailed')` that today narrows to
"the notice did not show" would also catch a dialog fault of the same
member; both are logged the same way.

**Change amplification.** "A fourth host (the trace viewer) implements the
message ports": today it must raise three tags with the right `member`
literals: 1 file, 5 shapes; after: 1 file, 1 shape.

**Depends on:** none.

---

## Finding 11. Smaller items, batched

a. **`texraProcessLayer`'s special cases as options.** `TexraProcessHost`
(`controllers/texraProcessLayer.ts:46-81`) has five optional members
(`resourcesPath?`, `skillSourceOptions?`, `workspace?`, `agentIssues?`,
`globalStores?`), four of them for "the platform-less CLI entries"
(`:77-81`), and passes `resourcesPath ?? ''` as a path (`:126`): a sentinel
string for "no resources". Flag: no option for a special case. Design: the
CLI entries that create nothing build their own smaller layer; a resources
path is required or the agent directory service takes `Option`.

b. **`setupLaunch`'s four string outcomes and an unbound-window warning.**
`launchSetup` (`controllers/onboarding/setupLaunch.ts:31-68`) answers
`'already-running' | 'no-model' | 'not-started' | 'launched'`; `Effect.result`
swallows the launch's `E` into `'not-started'` (`:58-59`); the extension
branches on two of the four (`packages/extension/src/commands/setup/setupAssistantCommand.ts:42,55`),
the desktop on one (`:105`). `kickoffDesktopSetup.run` is `… | undefined`
(`:88-92`) and a missing window logs "Setup did not start: the window has
not bound its project yet." (`:95-98`): silent degradation for an ordering
the window's scope can guarantee. Flag: sentinel values; state in an
optional field. Design: `launchSetup` fails typed (`SetupAlreadyRunning`,
`NoSetupModel`) and returns the `Run`; the desktop builds onboarding after
the project binding or not at all.

c. **`ProgressWorkflowFileActionsController`.** `executeWithBaseFile`
(`:201-213`) returns `boolean` from a callback typed `boolean | void`
(`acceptEditedFile`, `:40-43`) via `result !== false`; `comparePrevious`
(`:141-147`) shows "needs a base file" for a request whose schema could
require `prev`; `backupModelOutput` sweeps every run's digests on every
write (`:223-233`), an idle sweep where the view's run removal is the event.
Flag: vague return; a message for a shape; a sweep. Open PR: PR 14713
rewrites this file (+63/−87); re-audit after it lands.

d. **The launch pre-check exists because the row schema defaults required
fields.** `prepareSurfaceLaunch` (`controllers/mainView/backend/MainViewRunLaunchController.ts:168-173`)
rejects a missing `agent`/`model` "before schema parsing so the user sees
the real form problem" because `AgentConfigSchema` fills both
(`packages/harness/src/shared/schemas/agentConfig.ts:52-53, 74-75`,
`withDecodingDefault`). Flag: two representations (a default and a
pre-check). Design: a launch decodes a `LaunchConfigSchema` without
defaults; the stored row keeps its own. `buildLaunchConfig`'s `resolved`
(`:58-70`) is a hand-made `Result`; `team?` (`:47-50`) is a second mode.

e. **`compileFixer`'s plan is a severity the caller re-dispatches.**
`ProgressFollowUpPlan` (`controllers/progressView/compileFixer.ts:44-47`)
is `warning | info | execute`; `runCompileFixer` (`hostRunActions.ts:502-510`)
maps the first two to `showWarning`/`showInfo`. The three refusals are
`Rejected({ reason })` (what the toolbar actions now answer); the union goes.

f. **Dead descriptor columns.** `SubscriptionProvider.sessionName` and
`.copyTarget` (`controllers/modelAccess/subscriptionProviders.ts:109-111`)
have no reader (`.sessionName` 0 files; the one `.copyTarget` hit,
`packages/harness/src/agent/index/AgentDirectoryService.ts:342`, is an
unrelated local). The comment at `:289-292` keeps each binding as a lambda
"so a host suite that swaps `@texra-ai/llm/node` … still intercepts the
row": indirection for a test. Flag: a column constant or unread; a comment
for tests.

g. **`SubscriptionUsageService`'s `forceRefresh` option.** Threaded through
`getUsage`/`getAllUsage`/`coalesced` (`:178-237`) for one caller, the
refresh button (`sharedSettingsCommands.ts:378`); the button could run
`invalidate` then `getAllUsage`. `resolveVariant?` (`:69`) makes the GLM
region a cache-key column (`:59`) instead of part of the adapter's own
read. Flag: option for a special case.

h. **Module-level caches outside a service.** `binaryResolver.foundTools`
(`utils/system/binaryResolver.ts:49`, an `LRUCache`) and
`toolChecks.packageManagerAvailability` (`utils/system/toolChecks.ts:176`)
are process-global mutable maps with no resettable handle (AGENTS.md "No
shared mutable state"); `ToolAvailability` is the service that already
owns probe results.

i. **`runDailyUpdateCheck`'s two options are constant per host.**
`notifyOnce` (desktop only, `packages/desktop/src/main/desktopUpdateChecker.ts:73`)
and `stampFailure: 'ignore'` (CLI only, `packages/cli/src/runtime/updateChecker.ts:309`)
(`utils/system/updateCheck.ts:89-93`) follow from the `host` field the call
already carries (`:87`). Add to the fewer-options inventory.

j. **`housekeeping/utils.generateTimestamp`** (`:68-70`) reads `new Date()`
rather than `Clock`; the one caller names an archive folder.

---

## Good modules in this area

- `controllers/session/runActionPolicy.ts`: `resumeRun`/`forkRun` are the
  one place a resume or fork refusal is worded and mapped, with 17 and 10
  consumers across every host; a deep module with a two-function surface.
- `controllers/session/launchConfig.ts`: `decodeLaunchConfig` turns a schema
  issue into one `Rejected` with the first issue's path, logged once.
- `controllers/session/SessionFramer.ts`: `frameSubscription` is a pure
  `Stream` over a `FramerSource`, with `mapAccum` carrying the cursor and
  `Stream.buffer({ strategy: 'suspend' })` for back-pressure; testable under
  `TestClock` as its header says.
- `controllers/mainView/MainViewDroppedFilesController.ts`: refuses at the
  boundary (an unparseable `file:` URL, a stat failure other than absence)
  rather than shrinking the drop quietly.
- `controllers/modelAccess/subscriptionUsage/subscriptionUsageParsing.ts`:
  `fetchSubscriptionUsage` is the one request every adapter makes;
  `pickField` over a schema holds the alias fallback once;
  `timestampMsField` refuses what `Date.parse` would misread.
- `controllers/modelAccess/subscriptionUsage/SubscriptionUsageService.ts`'s
  `Cache.makeWith` with `timeToLive` and `requireServicesAt: 'lookup'`
  (`:111-126`): the TTL cache the brief lists as a hand-rolled risk, done
  with the primitive.
- `model/providerPresentation.ts`: `KEY_PAGES` typed per provider so a new
  regional provider fails to compile until it names both platforms.
- `settingsToolCommands.followToolAvailability` (`:127-137`): the page as a
  stream of its input, which finding 8 generalizes.
- `housekeeping/utils.collectFilesFromPatterns`: no glob; a path with
  metacharacters names itself; absence typed by reason.
- `controllers/settingsView/ToolDashboardData.planToolTerminalAction`: the
  command is re-looked-up from the plugin's card, never taken from the
  webview.

## Already settled, left alone

- `openGuiWindow.ts`'s five jobs, the pre-run failure's presenter, the
  toolbar actions answering `done`, `GuiSession`'s union, the window
  attachment and notices to a host without `emit`: found in
  `2026-11-06-cli-service-root-causes.md` §3.3 and §4; the Status there says
  most landed. Only the standing window-side `SessionHostInteractions`
  (`openGuiWindow.ts:378`) is re-cited, under finding 5.
- `SessionBridge`'s uninterruptible requests as the "drain" are adjacent to
  R8's `Interactions` redesign; finding 7 names the fiber-level shape only.
- `ToolEditApprovalController.decide` writing `request.decide` is R7's
  `decideRequest` from the host side; not repeated.
- `subscriptionProviders.ts`'s two rows and their coordinators stay as the
  refuted `LLM-subscription-credential-facade` ruled (PR 14504): finding 11f
  names only two dead columns.
- `withPerKeyLane` in `sharedSettingsCommands.ts:286-295` stays per
  `EFF-ADOPT-per-key-lane-semaphore`.
- `DECLINED_KEY = 'cli.onboardingDeclined'` (`onboardingFunnel.ts:42`) keeps
  its spelling: a persisted key (AGENTS.md "Plain names and comments").
- `recordFirstCompletedRun`'s round trip through the global store
  (`onboardingFunnel.ts:94-130`): the run may be held by another process;
  R1 keeps the global store's cross-process reads.
- `hostCallFailure.fromHost` (`Effect.tryPromise` at the host edge, 4
  consumers in the hosts): the one accepted place to lift a Promise.
- `common/files/*`, `agent/export/*`, `agent/templates/*`, `platform/defaults/*`,
  `utils/text/*`, `utils/git/*`, `utils/diagnostics/*`: read; tables and
  pure functions with no finding.

---

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

Every "better design" above names the one primitive that is the thing. The
`.d.ts` line is where the export was read; "repo" names an existing use.

| Finding | Hand-rolled today                                                                                                                                                 | Effect primitive                                                                                                                                                                                                                                       | Verified                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | `settled` Deferred + `isSettled` + `staged` Map beside `followPendingRequests`'s per-request fiber                                                                  | the request's `Scope` (the fiber `FiberMap.run` gives it): `Effect.scoped` + `Effect.addFinalizer((exit) => …)`; nothing else says "finished"                                                                                                            | `Effect.addFinalizer` takes the exit (Effect.d.ts:12852); `FiberMap.run … onlyIfMissing` (FiberMap.d.ts:1016); repo: requestAnswerer.ts:99-114 |
| 1       | `LatexPreviewEntry.workspaceTempCleanup` array + `registerCleanup`                                                                                                   | `Effect.acquireRelease` per temp file in the same scope                                                                                                                                                                                                | Effect.d.ts:12676                                                                                                                          |
| 1       | `latexOperationInProgress` boolean mutex + `raceFirst(Deferred.await(settled))`                                                                                     | `FiberHandle` per entry: `FiberHandle.run(handle, op, { onlyIfMissing: true })`; the scope's close interrupts it                                                                                                                                         | FiberHandle.d.ts:110 (`make`), :542 (`run`, "unless `onlyIfMissing`"); repo: 9 `FiberHandle.` uses                                         |
| 1       | five `Effect.uninterruptible` + `forkIn(entry.scope)` around the approval                                                                                           | the request fiber the bridge already runs (today itself masked, finding 7); the approval returns when `request.decide` records                                                                                                                         | Effect.d.ts:14415 (`uninterruptible`, kept at one site: the bridge's or `FiberSet.join`)                                                   |
| 2       | `Take.result`/`Take.settled` Deferreds (`makeUnsafe`, `doneUnsafe` ×3), `stopping`/`cancelled` booleans, `takeFiber: Fiber \| null`, `forkDetach`                    | `FiberHandle` in the process scope: `FiberHandle.run(handle, take, { onlyIfMissing: true })` + `FiberHandle.join` for Start, `FiberHandle.clear` for Cancel; Stop is a `Latch` the take `Latch.await`s after sox starts                                   | FiberHandle.d.ts:110/542/504/746; Latch.d.ts:189 (`make`), :209 (`open`), :351 (`whenOpen`)                                                 |
| 2       | `listeners: Set<fn>` + `subscribe`/`notify`                                                                                                                         | `SubscriptionRef<Recording \| null>`; windows read `SubscriptionRef.changes`                                                                                                                                                                            | SubscriptionRef.d.ts:93/134; repo: 27 `SubscriptionRef.changes` uses                                                                       |
| 3       | eleven `let`s + `publish` closure + `refreshLane` Semaphore + `guarded` exit collector + `onError` callback; the window's own `SubscriptionRef<HostSnapshot \| null>` | one `SubscriptionRef<HostSnapshot>`; each producer ends in `SubscriptionRef.update(ref, (s) => ({ ...s, field }))`; bursty inputs go through `Stream.debounce` into `Stream.runForEach(update)`; a failed producer `Effect.ignore({ log: 'Warn' })`s      | SubscriptionRef.d.ts:1248 (`update`), :1324 (`updateEffect`); Stream.d.ts:11372 (`debounce`), :15953 (`runForEach`); Effect.d.ts:7737 (`ignore`) |
| 3       | `apiKeyBanner?` / `dependencyBanner?` / `gettingStartedBanner?: true` / `workspaceRoots?` as capabilities                                                          | required producers (`Effect.succeed({ visible: false })` on a host without one); R8's "a required boolean", not an absent member                                                                                                                       | —                                                                                                                                          |
| 4       | `SharedParts` thirteen-member bag; `SHARED_HOST_REQUEST_KINDS` restating `OWN_REQUEST_LABEL`'s complement                                                           | not a primitive: the window record itself, and one list (`Exclude<HostRequest, OwnHostRequest>`)                                                                                                                                                       | —                                                                                                                                          |
| 5       | three `presentRunFailure` sites, two end hooks, five `Effect.ignore` tails, `scope`/`present`/`readConfig`/`loadModelOptions` ports, `revealProgress?`             | one `launch(program)` body: `Effect.tapError` once, `Effect.forkIn(whenEnded(run), windowScope)` once; the body `yield* Scope.Scope`, builds `workspaceEnvironmentLayer(roots.workspace)` and takes `emit` and `revealProgress: Effect`                   | Effect.d.ts:17126 (`forkIn`); the session's `records` port (sessions.ts:192) is the config read                                             |
| 6       | `OnboardingFunnelRefresher`: `rerunRequested` boolean + `Semaphore.makeUnsafe(1)` + `current`; the state copied into a desktop `SubscriptionRef` and the extension's snapshot | `Stream.zipLatest(flags.changes([…]), credentialProbe)` → `Stream.map(derive)` → `Stream.changes` → the snapshot ref's `update`; the extension's agent selection is `Stream.zipWithPrevious` + `Stream.filter` on that stream                                 | Stream.d.ts:4909 (`zipLatest`), :13273 (`changes`), :4811 (`zipWithPrevious`), :3227 (`concat` for the initial probe); repo: `Stream.zipLatest` 1, `Stream.changes` 8 |
| 7       | `PortEntry.fiber: Fiber \| null` + manual `Fiber.interrupt(previous)` before the next replay                                                                        | `FiberHandle` in the port's `framers` scope: `FiberHandle.run(handle, frames)` interrupts the previous fiber by contract                                                                                                                                | FiberHandle.d.ts:542 ("the previous fiber is interrupted unless `onlyIfMissing`")                                                          |
| 7       | `held: SurfaceActionMessage[] \| null` drained on `Subscribe`                                                                                                         | `Latch` opened by the first `Subscribe`; `act` = `Latch.whenOpen(latch, send)`                                                                                                                                                                         | Latch.d.ts:189/209/351                                                                                                                     |
| 7       | `Effect.uninterruptible` around every request so the bridge "drains"                                                                                                | requests in a `FiberSet` made in the bridge's scope; close = `FiberSet.join`/`awaitEmpty` under `Effect.timeout`, then the scope's interrupt                                                                                                             | FiberSet.d.ts:106 (`make`), :457 (`run`), :686 (`awaitEmpty`); Effect.d.ts:8266 (`timeout`)                                                |
| 7       | three `scope.state._tag === 'Closed'` reads after `Scope.fork`                                                                                                       | one check on the bridge's own `Scope.state` before forking (a public field, Scope.d.ts:47), or `Scope.addFinalizer` on the bridge scope at `make` so a closed bridge is one fact                                                                        | Scope.d.ts:47/460/493                                                                                                                      |
| 8       | per-mutation repaint lists, `stateSnapshotPosters`, `postAll` + `followRepaints`, `refreshAfterAgentMutation(…, alreadyFresh)` boolean, `allSettledVoid` fan-outs  | one `Stream<message>` per page: `Stream.concat(Stream.make(void), input)` → `Stream.mapEffect(build)` → `Stream.runForEach(bindings.post)`, where `input` is `appSignalStream`, `state.changes(keys)` or `SubscriptionRef.changes`; `Effect.forkScoped` each | Stream.d.ts:3227/648/1843/15953; Effect.d.ts:17216 (`forkScoped`); repo: `settingsToolCommands.ts:127-137`                                   |
| 9       | `queue: Entry[]` with `shift()` at 1000; `triggers` Queue(1, dropping) + `backgroundFlushActive`; `flushTimer: Fiber \| null`; `retryBatch` + `keepForRetry`; `drainAndStop`'s warning fiber | `Queue.sliding(1000)` → `Stream.fromQueue` → `Stream.groupedWithin(batchSize, flushIntervalMs)` → `Stream.mapEffect(send.pipe(Effect.retry(Schedule.exponential(…).pipe(Schedule.modifyDelay(min)))))` → `Stream.runDrain`, `Effect.forkScoped`; shutdown `Queue.end` + `Fiber.join` under `Effect.timeout` | Queue.d.ts:501 (`sliding`), :1120 (`end`); Stream.d.ts:1017 (`fromQueue`), :11832 (`groupedWithin`), :16198 (`runDrain`); Effect.d.ts:7132 (`retry`); Schedule.d.ts:725/909 |
| 10      | nine error tags with unread `member`/`step`/`kind` fields                                                                                                           | not a primitive: one `Schema.TaggedError` (`HostFailed`) for the host ports, presented by the existing presenters                                                                                                                                      | —                                                                                                                                          |
| 11c     | `backupModelOutput`'s sweep of every run's digests on each write                                                                                                   | release on the event: a `Scope` per run's digests closed when the view drops the run (`Effect.addFinalizer`), or `RcMap` keyed by run with `idleTimeToLive` if the host wants a grace period                                                            | RcMap.d.ts:215/701; repo: 31 `RcMap.` uses                                                                                                 |
| 11g     | `SubscriptionUsageService.usageCache` made lazily with `this.cache ??=`                                                                                              | keep `Cache.makeWith` (the good module), but make it once in the service's `Layer.effect` instead of on first read                                                                                                                                     | Cache.d.ts:176; Layer.d.ts:1166 (`Layer.effect`; there is no `Layer.scoped` in 4.1.2, `Layer.effect` excludes `Scope` from `R`)             |
| 11h     | `foundTools` LRUCache and `packageManagerAvailability` Map at module level                                                                                          | `Effect.cachedWithTTL` per probe held by the `ToolAvailability` service, or a `Cache.make` in its layer                                                                                                                                                | Effect.d.ts:13625; Cache.d.ts:250                                                                                                          |

Not replaced, deliberately: `Semaphore.makeUnsafe(1)` lanes stay where a
whole read-build-post must be ordered (`settingsToolCommands.ts:47`,
`withPerKeyLane` in `sharedSettingsCommands.ts:286-295`, per the refuted
`EFF-ADOPT-per-key-lane-semaphore`); `Cache.makeWith` with `timeToLive` in
`SubscriptionUsageService` is already the primitive; `Effect.all(…, { mode: 'result' })`
(Effect.d.ts:286, :309) does not subsume `allSettledVoid`'s defect handling,
so that helper is deleted by losing its callers (finding 8), not by
replacement.
