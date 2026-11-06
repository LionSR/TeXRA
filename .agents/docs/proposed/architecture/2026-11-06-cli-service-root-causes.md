# The CLI service and its sessions: root causes and the plan

Date: 2026-11-06
Status: open (the plan in §4 is unassigned)
Origin: the owner's remark after the review rounds of PR 14769 that the CLI
service and the service sessions look suspicious, and the instruction to
fix root causes, never symptoms. Read on `simplify/session-core` at
`e4478c9`: the author's pass over `packages/cli/src/runtime/cliService.ts`,
`packages/cli/src/commands/service.ts`,
`packages/texra/src/controllers/server/{serve,client,discovery,handlers}.ts`
and `packages/cli/src/runtime/initPlatform.ts`, plus three independent
read-only reviews (lifecycle; the wire and `serviceSession.ts`; windows and
attach). R10 of the root designs
(`2026-11-05-root-designs-effect-native.md`, PR 14766) already covers the
hosts' verbs and the client's three sessions; this note is the service side
R10 does not reach, and names what in R10 this reading changes.

## 1. What the service is today

`texra serve` is one process per storage root: it listens on a socket of
its own pid under `<storageRoot>/run`, claims a record in the global store
(`discovery.ts`), opens a session per project on first use and closes it
once idle (`cliServiceProjects`), serves the RPCs of `protocol.ts` over the
project's session (`handlers.ts`), and exits when stopped, drained or idle
(`serve.ts`). A client (the TUI, a headless command, a GUI window) finds
the record, probes the socket, starts a service when none answers, retires
one older than its build and links to the new one (`client.ts`), then
drives the project through `serviceSession.ts`, a `Session` over the wire.
A newer build's client and an older service overlap during the upgrade:
the old one drains its tasks while the new one serves, and a project store
the old one still holds is retried for fifteen seconds.

## 2. Root causes

Each: the symptoms as they stand in the code, the one cause behind them,
the design that ends it, what it deletes, and what it gives up.

### 2.1 Two services alive during an upgrade

Symptoms: `serve.ts` listens on `serve-<pid>.sock` so a retiring service
removes only its own file, sweeps dead sockets at start
(`removeDeadSockets`), releases its record early on a drain (`released`
flag, `leave`), and sleeps `FRAME_FLUSH` before closing; `client.ts`
retires an older service, excludes its pid while waiting for the new one
(`retired`, `NOT_YET_UP`, `START_TIMEOUT`), and the link's reconnect loop
carries `told`, `refusalTold` and `WINDOW_OUTDATED`; `cliServiceProjects`
retries a held project store for `STORE_RELEASE_WAIT` (fifteen seconds,
added in PR 14769's R1 slice, a wall-clock wait standing in for the old
service's exit). Root cause: the upgrade is a handoff protocol between two
processes, written with files, polling and timers, and R1's one-writer
store then has to be polled for the moment the old process lets go.

The retry is broken on its own terms (the lifecycle review verified it):
the drain waits for `working === 0` with no bound (`serve.ts`), a task
runs for minutes, and after fifteen seconds every `task.start`,
`task.watch` and `state.get` for that project on the new service fails
with the held-store message until the old process exits. A window that
stays linked to the retiring service fares no better: the link reconnects
only when the socket closes, `hello.draining` is read by `texra service
status` alone, and every start it asks is refused with "start the task
again", which hits the same socket.

Two designs end it; the owner chooses.

- **One service per storage root, strictly** (chosen by the owner, landed
  on `simplify/service-one-door`). A client that finds an older service,
  or one already draining, asks it to drain and waits on a published
  signal, the socket's close (the client's `onDisconnect` already fires on
  it), then starts its own; a draining service keeps its record and its
  socket until it exits; a project is never contended, so a held store at
  open is an error, never a retry. `hello.draining` is read by every
  client now, not only by `texra service status`. Deletes: the early
  record release, the `retired` exclusion, `STORE_RELEASE_WAIT` and the
  `storeHeld` retry, `askServiceToStop`. Kept: the socket per pid and the
  dead-socket sweep, since one socket path cannot be unlinked safely by a
  service that may be racing another's listen (the pid names whose file
  it is). Gives up: work in the new build while the old build's long tasks
  finish; the client logs "finishing N running tasks" and waits.
- **A per-project handoff on a signal.** The drain closes each project's
  session as its last run ends (`Sessions.drain`), and says so as a record
  in the global store, which the successor awaits through the store's
  change stream (`GlobalValues.changes`) instead of a timer; a window on
  the retiring service is moved to the successor as its project closes.
  Keeps the concurrent upgrade; costs one record kind, the move, and the
  two-services machinery the first design deletes.

Either way the timer goes, and "retiring" stops being an error string.

### 2.2 A project's lifetime is hand-rolled

Symptoms: `cliServiceProjects` keeps `leases`, `idleSince`, a `PerKeyLane`
per root, `closeIfIdle` and a `closeIdle` poll every `min(60 s, idle/2)`
in `handlers.ts`; "a run held keeps the project open" is read by polling
`session.held()`. Root cause: a reference-counted resource with an idle
release, which Effect provides as `RcMap` (`idleTimeToLive`), rebuilt by
hand, with the runs' hold on the project read instead of held.

Design: the projects are an `RcMap<root, LocalSession>` with
`idleTimeToLive: idleAfter`; a client's lease is `RcMap.get` in its scope;
a live run's hold is a lease the session's registry takes as it forks a
run and releases as the fiber exits (the registry already publishes
`runsHere`), so no poll reads `held()`. Deletes: `Project`, `lanes`,
`closeIfIdle`, `closeIdle`, the close poll, `runningTasks(projects,
parked)` (R10 lists it). Gives up: nothing.

### 2.3 The service's own lifetime is a one-second poll over counters

Symptoms: `serve.ts` keeps an `admissions` ref with `draining`,
`admitting` and `admitted`, a mutable `idleSince`, a `check` every
`CHECK_INTERVAL`, and `FRAME_FLUSH` (a 250 ms sleep so the watch streams
carry the last rows before the socket closes). Root cause: idle and drain
are facts of three live counts (clients, leases, live runs) read by
polling, and the end of the watch streams is approximated by a timer.

"Tasks at work" has two owners meanwhile: the `admissions` counts beside
`session.held()`, with comments in `serve.ts` describing the gap between
them, although the harness's registry already refuses a launch on a
session that is closing. And every lifecycle fact is sampled where a
signal exists: `GlobalValues.changes` publishes record changes, yet
`ensureService` polls the record every 200 ms for a minute, `texra
service stop` polls hello every 200 ms for thirty seconds (because
`service.stop` answers "once the stop is asked", not once it ended), the
chat's restart loop sleeps a minute then retries every five seconds,
`cliServiceProjects` retries the store every 250 ms, and the idle sweep
runs every minute.

Design: a draining session refuses `start` and `resume` itself, so
`admission` and `refuseWhileDraining` go; idle is "no client, no lease,
no live run" as one stream of those counts (`SubscriptionRef.changes` of
each, merged), debounced by `idleAfter`; a drain is a `Latch` closed over
admission plus the `FiberSet`'s empty wait; `service.stop` answers when
`ended` resolves; a client awaits the record stream; the socket closes
after the watch streams end, which the framer's end flush guarantees, so
no sleep. Deletes: `CHECK_INTERVAL`, `FRAME_FLUSH`, the `admissions` ref,
`idleSince`, `released`, every poll above. Gives up: nothing.

### 2.4 Five doors to one service, and a two-phase startup

Symptoms: `cliService.ts` exports `probeCliService`, `reachCliService`,
`connectCliService`, `startCliService` and `linkRunningCliService`, each
one policy (start or not, retire or not, quiet or not, link or
connection). The chat and `texra resume` call `startCliService` (connect,
then drop the connection) before `initCliPlatform` calls
`linkRunningCliService` (which never starts one), and the chat then calls
`reachCliService` again for its own connection. Root cause: "which
process holds this project" is decided in the client at three moments,
because `initCliPlatform` must know local-versus-service before it opens
the project's roots, so a caller starts the service ahead of it.

`linkRunningCliService` is a copy of `ensureService`'s first half: "a
newer protocol fails" is decided in three places, `isOlder` read in two,
the Windows gate in four, `TEXRA_NO_SERVICE` in three.

Design: one `linkService(storageRoot)` the platform calls once (start when
none, retire older, refuse newer, reconnect for its life); "a command
starts none" is the failing start program it already passes; the
in-process session only where a service is impossible (`TEXRA_NO_SERVICE`,
Windows), decided in the same call. With R10's one `Session`, the platform's
`session` / `runSession` / `reads` / `service` union collapses to the one
session the link answers. Deletes: four of the five entries, the
start-then-link dance in the chat and the resume command,
`CliPlatformServices.runSession/reads` (R10's F4). Gives up: nothing.

### 2.5 Two version facts for one decision, one of them bumped by hand

Symptoms: `isOlder` compares `protocol` (an integer, 66, advanced by
`npm run protocol:bump`, five times on this branch) and then
`BUILD_VERSION` (semver; a development build, `unknown`, never retires).
The bump test already computes a digest of every procedure's schemas
(`PROTOCOL.shapes`); the integer restates it. Root cause: compatibility is
a property of the shapes, kept as a number a person advances.

Design: the shapes' digest is the protocol identity; a client and a
service with different digests are incompatible, and the build versions
decide who retires whom (the newer build; equal or unknown, the client
restarts the service). `service.hello` and `service.stop` keep their
shapes across versions, as now. Deletes: `PROTOCOL.version`,
`protocol:bump`, `isOlder`'s first branch. Gives up: nothing.

### 2.6 The service's environment is a second environment

Symptoms: `spawnService` passes only `HOME` and `TEXRA_*`; the service
then runs a login shell to adopt its environment
(`adoptLoginShellEnvironment`); a key set in the terminal
(`OPENAI_API_KEY=… texra chat`) never reaches a task, so
`serviceKeysNotice` runs a second login shell in the client to warn the
user and point at `TEXRA_NO_SERVICE=1`. Root cause: a task's environment
was the process's; with the service it is whichever client happened to
spawn the service, which the design refused by stripping the environment,
and then patched with a notice.

Design: a task's environment is the task's: the client that starts a task
sends the provider keys it holds with the start (`StartOptions`), over the
user-only socket, and the service binds the task's model with them; the
service's own environment is its login shell's, for tools. Deletes:
`serviceKeysNotice`, the client-side login shell, the notice's copy.
Gives up: nothing; the owner decides whether keys may travel the socket
(it is the user's own, mode 0600).

### 2.7 The handlers re-answer what the session answers

Symptoms: `runEnded` waits on `drained`, then on a view change, then reads
`run.end`, then fabricates an end (`durableOutcome ?? CANCELLED` with an
empty output) when none is stored; `liveRoot` walks the parent chain by
`held` (a second copy of the registry's `ancestorsOf`, written in
`e4478c9`); `admittedTask` reads the view's head for an activation;
`records` checks `level.runs.has(runId)` to word "unknown run". Root
cause: the RPC surface is not the `Session`'s surface, so each procedure
re-derives a fact the session already owns (R10's "the RPC surface mirrors
`Session` one-to-one").

Design: R10 as written: one `Session` interface, the RPCs its members; an
end is the run's `run.end` row or `TaskRecordsFailed`, never fabricated; a
live ancestor is the registry's reading. Deletes: `runEnded`,
`task.ended`, `liveRoot`, `admittedTask`, the fabricated end. Gives up:
nothing.

## 3. The reviews' findings

Three independent read-only reviews, each over its slice, with the
author's verification of every claim recorded here (the file opened, the
line read). Ranked within each slice.

### 3.1 The wire and `serviceSession.ts`

Verified defects:

- **`task.ended` answers the wrong activation.** `handlers.ts` calls
  `readRunEnd()` with no activation, where the store's read takes `after`
  (`runRecords.ts`) and the harness's own run handle passes the activation
  (`runHandle.ts`); a run resumed by another window between its end and
  the read answers the later end. Root cause: the service re-derives
  `Run.result` instead of serving the one it holds from `session.start`
  (§2.7). The fix is R10's: `task.ended` streams the run's own result;
  `runEnded` goes. Not patched here: the payload carries no activation,
  so the patch would be a protocol change for a path the root deletes.
- **An invented end.** `runEnded` fabricates `{outcome: durableOutcome ??
  CANCELLED, output: empty}` where the harness fails with "ended without
  a stored end"; `at` falls back to the current cursor over a stream that
  ended. Two contracts for one fact; silent degradation. Ends with the
  item above.
- **The client's run view skips the harness's transcript guard.**
  `serviceSession.ts`'s `runOf` re-implements `runView` (`runHandle.ts`):
  the same `dropWhile`/`takeUntil` over the view, minus the
  `transcriptSeq.has(replayed)` guard, so the first level a window reads
  can lack the run's transcript. Root cause: a second `Run` written beside
  the harness's (R10's F4). Design: `replayTrace` already takes an
  abstract port (`runTrace.ts`); `runView` lifted onto that port serves
  both sides, and the service exposes `Run`'s members (`task.result`,
  `task.view`) instead of the client re-deriving them.
- **`Subscribe.session` spelled three ways.** `serviceSession.ts` sends
  `roots.storage`, `taskAttach.ts` the workspace folder, and `handlers.ts`
  overwrites both with the session's key; the webview path rejects a
  mismatch (`SessionBridge.ts`) where the RPC path silently repairs it.
  Design: the field leaves the RPC `Subscribe`; `workspace` names the
  project.
- **Liveness decided three ways; the resume redirect duplicated.**
  `taskList.ts` reads `runsHere`, `handlers.ts` `held(id)` and `held()`
  joined with the view's status; `liveRoot` walks `parentId` to find the
  parent's handle, which `session.resume` already does (`ownedBy`,
  `redirectedFrom` in `sessionPrograms.ts`). Design: the handler calls
  `session.resume` and lets the harness answer (§2.7).
- `Effect.retry({ times: 2 })` in `serviceSession.ts` retries a
  `TaskFailed` "result could not be read" before classifying it.

Design smells:

- **The frame is nine fields and two decoders.** `EventsFrame` re-declares
  the harness's `SessionViewInput[]` as fields (`cursor`, `events`,
  `chunks`, `local`, `host`, `debug`, `replayComplete`, `existence`), so
  the reader's one ordering (`sessionInputs.ts`: debug, local, listing,
  subscriptions, aggregates, replay complete; every tail batch closed by
  `drained`) is re-established three times: `cutFrame` keeps only the last
  `local` and drops `subscriptions`; `SessionFrames.inputs` re-orders and
  re-synthesises them; `frameInputs` does it again. Design: the frame is
  `{ generation, cursor, inputs: SessionViewInput[] }` (the schema exists,
  `sessionViewInput.ts`); the three decoders and most of `cutFrame` go,
  and ordering lives in the reader alone.
- **The protocol version is a symptom** (§2.5): the five bumps on this
  branch were all harness row schemas, never a procedure; `PROTOCOL.shapes`
  is the content hash and `version` a hand-copied integer of it; the
  promise that `service.stop` keeps its shape across versions is
  unenforced. Per-procedure digests exchanged at hello make it checkable.
- **A host snapshot on a channel that never carries one.** `task.watch`
  builds a `SubscriptionRef(null)` per watch for `EventsFrame.host`, a
  nullable special case for the webview path; `SessionFrames.host` exists
  for it.
- `runningTasks(projects, parked)` (§2.2); the polls (§2.3, and the 200 ms
  startup probe in `client.ts`, whose signal could be the record write).

### 3.2 The service's lifecycle

Verified defects: the broken drain handoff and the window left on a
retiring service (§2.1); two owners of "tasks at work" and the six polls
(§2.3); the resolver copied and the two-phase startup (§2.4).

Design smells:

- `ServiceRecord.protocol` and `version` are written at claim and read
  nowhere (every reader takes the hello): dead persisted data; the record
  is a pointer to a socket.
- A hand-written "once": the `released` flag with `leave` run from four
  places; `clients` reassigned after the protocol builds because `control`
  is built before its dependency. A `Deferred`, and `control` after
  `protocol`.
- `sessions.closeAll` runs three times at exit (`settle`, the serve
  command's finalizer, the session layer's own).
- The link's reconnect drops the first failure's reason
  (`Effect.catch(() => connect(start))`) and re-probes to find it again.
- The loser of a start race exits with the usage code: a normal outcome
  reported as misuse.
- Liveness of a service is decided three ways (record presence, the
  hello, `process.kill(pid, 0)` in `removeDeadSockets`); the record is a
  pointer, which is fine, but the dead-socket sweep is a second cleanup
  beside `releaseServiceRecord` (gone under §2.1's first design).
- Kept as is: the hand `spawn` for the detached service is justified
  (Effect's `ChildProcess` takes no file descriptor for stdio); the start
  race is handled by the record's compare-and-set.

### 3.3 Windows and attach

Verified defects:

- **A notice to a host without `emit` vanishes.** `presentOn`
  (`HostInteractions.ts`) returns `Effect.void` when the host has no
  `emit`; a service session opens with `host: {}` (`cliService.ts`,
  `initPlatform.ts`), so until a window attaches, a notice is neither
  shown, logged nor queued, against what the session's contract says
  ("waits for the next one") and what the replay class exists for. The
  same shape in the answerer's overlay and in the window host, whose
  `notices` capability is granted by `emit || filesWritten` while a notice
  needs `emit`, so a window with only `filesWritten` answers `ok` having
  shown nothing. Root cause: a capability decided from optional members at
  two sites. Design: a host without `emit` is not a presenter (the notice
  queues for the next, or is said at warn); `notices` splits into what
  each call needs.
- **Toolbar actions that do nothing.** `workflowConfig` answers
  `undefined` with a log line ("this toolbar path has no messaging port",
  `hostRunActions.ts`); `latexdiff`, `pack` and `clean` answer `done`
  when there is nothing to do, where the same body answers `Rejected` for
  an error result (`openGuiWindow.ts`). Design: fail with `Rejected`; the
  surface presents it.
- **The pre-run failure's presenter is decided per branch.** The local
  branch presents through the session's `Interactions` (the last-focused
  window, which may not be the one that asked); the service branch pins a
  private `new SessionHostInteractions()` to the window; the replay class
  is instantiated only because the port type reaches `fallbackMessage`
  through it. Design: `presentRunFailure` takes a plain `emit`, the
  requesting window's, in both cases; the window-side instance goes.
- `Effect.context<AgentCatalog>()` captured and re-provided whole in
  `hostRunActions.ts`, where the guardrail says `Context.pick`.

Design smells:

- **`GuiSession` is an option for a special case.** `serviceSession`
  already hides where runs run, yet the window still branches on
  `service` for records (`local.records` versus `serviceRecords`) and for
  the link it attaches through. Design: `Session` carries `records(runId)`
  and its link, both implementations fill it, the union goes (R10's F4).
- **One decision, three hosts.** `openGuiWindow.ts` and the two host
  request modules re-enter the runtime inside branches because two ports
  erase their requirements while the verb table already runs in
  `ProcessServices`; `setApiKey` is bound twice per host; the custom agent
  directory is read in both hosts beside `files.openDirectory`; the
  refusal wording for a kind a host lacks is per host, against the
  header's "refusal wording lives here once". Design: optional binding
  members, the shared body reads the fact and words the refusal once,
  ports keep `ProcessServices` in their requirements.
- **`openGuiWindow.ts` does five jobs**: composition root, the
  session-location switch, a presenter adapter, a launch-lifecycle wait
  (`showLaunched`, a fixed ten-second `SHOW_LAUNCHED_WITHIN` ending in a
  toast), message wording, and the request router. Only the router over
  the binding table is this module's; composition is each host's root;
  selection on arrival is a surface fact applied when the view holds the
  run, and the timer goes.
- **Notice round-trips and misreported late answers.** `tell` mints an
  id nothing awaits; the window answers it anyway; `answer` reads any
  unknown id as a notice, so an answer past `ANSWER_WITHIN` is logged as
  a notice failure or dropped. Design: the frame says whether an answer
  is wanted. `ANSWER_WITHIN` itself is a per-kind constant table where the
  window answers every end and a detach fails every pending call, so the
  timeout covers only a hung handler.
- **Replay** (`SessionHostInteractions.use`) is relied on by the service
  (a project's session opens before its first window attaches) and by the
  GUI's gap between open and link; the window-side instance never replays.
  Keep it in the session only.
- `editorHost` keys attachments by storage root with
  overwrite-and-identity-delete while `HostWindows` keys surfaces by
  session identity: two keys for one fact.
- Two windows on one project: calls and notices go to the last-focused
  only; an open approval whose window is gone is a row any surface decides
  (fine), but service sessions always read as "can ask" because
  `HostWindows` holds the attachment fact and the policy never reads it.

## 4. The plan

Two PRs, not five: the two decisions above are made (the owner chose the
strict handoff and keys with the start), and the rest groups by the files
it touches, one commit per root inside each PR, as PR 14769 did.

1. **The service's lifetime, one service, one door** (§2.1 to §2.5, §3.2),
   PR 14771 on `simplify/service-lifetime`, three commits: the digest as
   the protocol identity; `RcMap` projects and the service's idle, drain
   and stop as signals over the projects' load, the admissions and the
   watch streams (the one-second check, `admitted`, `idleSince`,
   `released` and the 250 ms flush gone; a five-second deadline on the
   watch streams' end stays, as a bound); the strict handoff on the
   socket's close (a draining service keeps its record and socket until it
   exits, every client reads `hello.draining`, the store retry and the
   early release go) and the one `linkCliService` the platform calls (a
   command that runs or lists tasks says `startsService`; the link answers
   the service or why it holds none; the chat's restart loop and the four
   other doors go). Kept: the socket per pid and the dead-socket sweep (one
   path cannot be unlinked safely by a service racing another's listen);
   the admission as the transport's (a draining session refusing its own
   starts would be the harness's `Sessions.drain`, which only the
   per-project handoff needed).
2. **The hosts** (§2.6, §2.7, §3.1, §3.3; R10 whole): the frame is
   `SessionViewInput[]`, the RPCs are `Session`'s members, `runView`
   lifted onto the trace port serves both sides, `task.ended` and the
   fabricated end go, `Subscribe.session` goes (the verified defects of
   §3.1 end here, not by patches); `GuiSession` goes with the one
   `Session`, the three hosts' repeated decisions move into the shared
   body, `openGuiWindow.ts` keeps the router and loses its other four
   jobs, the presenter is the requesting window's `emit`, a host without
   `emit` is not a presenter, the toolbar actions fail instead of
   answering `done`; and a task's provider keys travel with its start
   (`StartOptions`, never a row), read by the run's model binding.

Amend R10 in PR 14766 with §2.1 to §2.6 and §3.1 to §3.3: its "Design"
names the client's three sessions and the hosts' verbs, not the service's
lifetime nor the wire's shape, which this note adds.

### Status

PR 2 (`simplify/service-hosts`, stacked on PR 14771) landed, one commit
per root: the frame is the reader's batch and the host snapshot its own
message, `Subscribe.session` off the RPC (§3.1's frame and session
findings); a window's handle is the harness's `Run` for its activation
(`Run.activation`, `LocalSession.run`, `task.result` for `task.ended`,
`activationView` shared, a resume of a live run answers its handle in
the harness; §2.7 and §3.1's activation, invented-end, transcript-guard
and liveness findings, and the `retry` before classification); one
`Session` on both sides (`records`, `listRuns`, `deleteRuns`, `view.read`
mirrored as `records.*` and `session.*` procedures; `GuiSession`'s union,
`CliRunReads`, `serviceRecords` and the export's records pair gone; a
link's `client` as a followed value, so one link type serves every
window; §3.3's `GuiSession` smell); a task's provider keys travel with
its start and resume (`StartOptions.apiKeys`, `environmentApiKeys`;
`serviceKeysNotice` and its login shell gone; §2.6); a host without
`emit` is not a presenter and `notices` splits from `filesWritten`, the
toolbar actions refuse with `Rejected`, the run actions take the catalog
as a service (§3.3's three verified defects and the `Effect.context`
capture).

A sixth commit took the hosts' repeated decisions (`setApiKey` once,
with the retry's prompt built from it; the custom agent directory read
in the shared body and opened through `files.openDirectory`; a host's
own request kinds as a table, the refusal of a kind it lacks worded
once; the run actions' ports keeping `ProcessServices`, so no host
re-enters the runtime), the launch wait (`SHOW_LAUNCHED_WITHIN`: a
surface selects a run this window started once its view holds the
run's activation, which the handle names) and the window-side presenter
instance (the session presenter over the window's own host).

Left for a later PR, each a smell, none a defect:

- The notice round-trips (`tell` mints an id nothing awaits; an answer
  past `ANSWER_WITHIN` logged as a notice failure); `editorHost` keyed by
  storage root beside `HostWindows` keyed by session; two windows on one
  project, where service sessions always read as "can ask".
- §3.2's smells (the hello's `protocol`/`version` on the record, the
  `released` flag, `closeAll` run three times, the link's reconnect
  dropping the first failure's reason, the race loser's usage code).
