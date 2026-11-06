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

Design: one service per storage root, strictly. A client that finds an
older service asks it to drain and waits on a published signal, the
socket's close (the client's `onDisconnect` already fires on it), then
starts its own; a project is never contended, so a held store at open is
an error, never a retry. The record names one socket path, not one per
pid. Deletes: `socketFor(pid)`, `removeDeadSockets`, the `retired`
exclusion and `NOT_YET_UP`, `STORE_RELEASE_WAIT` and the `storeHeld`
retry, `released`. Gives up: work in the new build while the old build's
long tasks finish; a user who upgrades mid-task waits for the drain, and
the TUI says so. The owner decides whether that wait is acceptable; the
alternative (the old service hands its projects to the new one) is a
larger protocol than the one this removes.

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

Design: idle is "no client, no lease, no live run" as one stream of those
counts (`SubscriptionRef.changes` of each, merged), debounced by
`idleAfter`; a drain is a `Latch` closed over admission plus the
`FiberSet`'s empty wait; the socket closes after the watch streams end,
which the framer's end flush guarantees, so no sleep. Deletes:
`CHECK_INTERVAL`, `FRAME_FLUSH`, `admissions.admitted`, `idleSince`,
`released`. Gives up: nothing.

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

Design: one `linkService(storageRoot)` the platform calls once (start when
none, retire older, refuse newer, reconnect for its life); the in-process
session only where a service is impossible (`TEXRA_NO_SERVICE`, Windows),
decided in the same call. With R10's one `Session`, the platform's
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

(Filled from the three read-only reviews once they report: the wire and
`serviceSession.ts`; windows and attach; what the lifecycle review adds to
§2.)

## 4. The plan

In order, each a PR that deletes what its root names:

1. **Service lifetime** (§2.2, §2.3, §2.5): `RcMap` projects, signals for
   idle and drain, the digest as the protocol identity. Harness-free
   except the registry's lease per live run. No behaviour change a user
   sees.
2. **One service, one door** (§2.1, §2.4): strict one-service upgrade and
   the one `linkService`. Needs the owner's decision on the upgrade wait.
3. **Hosts bind verbs** (R10, with §2.7): the one `Session` and the RPCs
   as its members; the handlers' re-derivations go.
4. **A task's environment** (§2.6): keys with the start. Needs the owner's
   decision on keys over the socket.

Amend R10 in PR 14766 with §2.1 to §2.6: its "Design" names the client's
three sessions and the hosts' verbs, not the service's lifetime, which
this note adds.
