# H. The app's tool plugins: design red flags

Area: `packages/texra/src/tools/` except `latex/` and `documents/`: the GitHub
subscription plugin, the Lean plugin (both adapters' shared port and the
direct `lake` pool), Zotero, arXiv, `support/`, and the plugin registrations
in `registry.ts`. Read-only, at the working tree of 2026-11-06 after the
rebase onto `6bbe08d` (#14774–#14776; none of the three touched this area's
files, `agentCli/agentCliShared.ts` was re-read after the rebase). Paths below
are relative to `packages/texra/src/tools` unless they start with `packages/`.
Consumer counts are over `packages/*/src`; the non-production corpus is
`src/test-kernel`, `packages/*/test`, `docs`.

Effect API claims below are verified against `node_modules/effect` 4.1.2
(`dist/*.d.ts`, and `dist/RcMap.js` for one release rule); the mapping table
at the end lists the exact exports.

## Numbers

Lines per subdirectory (18,043 in scope): `github/` 5,244; `agentCli/`
3,183; `lean/` 1,458 + `lean/direct/` 1,652; root files (`registry.ts`,
`AcceptRunFilesTool.ts`, `DiagnosticsTool.ts`, `editorHost.ts`,
`OpenPdfTool.ts`, `wolframPlugin.ts`) 1,406; `zotero/` 1,324; `setup/`
1,210; `inquiry/` 973; `arxiv/` 418; `support/` 344; `comment/` 319;
`media/` 277; `approval/` 127; `userQuestion/` 108.

Five largest files: `github/PRPollingSource.ts` 886, `lean/direct/leanServer.ts`
725, `github/PollingSourceBase.ts` 709, `lean/direct/leanServerPool.ts` 633,
`github/githubSubscriptionTool.ts` 605.

Comment-line share (`^\s*(/\*|\*|//)` over total), files ≥ 200 lines:
`github/checkRunsClient.ts` 45% (166/366), `support/externalBinaryUtils.ts` 40%
(140/344), `github/RepoPollingSource.ts` 35% (189/538), `zotero/bbtClient.ts`
31% (138/443), `agentCli/agentCliShared.ts` 28%, `agentCli/claudeAgentConfig.ts`
28%, `lean/leanTypes.ts` 26%, `github/PollingSourceBase.ts` 24% (173/709),
`registry.ts` 21%, `github/PRPollingSource.ts` 21% (187/886). The ones that
matter for design are `checkRunsClient.ts` (a 52-line header and a 12-line
field doc explaining when the caller may commit a cache the function returns,
finding 2), `PollingSourceBase.ts` (a hand-off protocol between a source's
listener set and the registry, finding 1) and `RepoPollingSource.ts` (whose
comments explain which state is committed before a tick can be skipped,
finding 2).

Primitives in scope: `new Promise` 0, `.then(` 0, `setTimeout` 0 (the one
unref'd timer sits in `packages/texra/src/utils/system/unrefSleepClock.ts`,
outside the area), `Effect.run*` 0, `catch {}` 0, `Effect.ignore` 1,
`Effect.uninterruptible` 5 (`PollingSourceBase.ts:273,475`,
`leanServerPool.ts:306`, `leanServer.ts:508`, `bbtClient.ts:438`),
`Deferred.` 23 (`leanServer.ts` 15, `PollingSourceBase.ts` 4,
`leanServerPool.ts` 4), `Deferred.makeUnsafe`/`doneUnsafe` 4, `FiberSet` 6,
`Scope.` 12, `Effect.timeout*` 13, `new Map` 23, `new Set` 25, `LRUCache` 4,
`AbortController` 1 (`agentCli/claudeAgent.ts:172`), `SynchronizedRef` as a
module-level singleton 2 (`arxiv/ArxivSearchTool.ts:68`,
`support/externalBinaryUtils.ts:255`), module-level `Map`/`WeakSet`/counter 4
(`lean/direct/lakeCommands.ts:30`, `lean/LspTools.ts:501`,
`lean/direct/leanServer.ts:225`, `agentCli/codexConfig.ts:129-130`). Effect
primitives the area reaches for: `LayerMap`/`RcMap` (`leanServerPool.ts`),
`RateLimiter` (`subscriptionRegistries.ts`), `Effect.cached`
(`leanServer.ts:481`), `Schedule.fixed` (`PollingSourceBase.ts:500`). None of
`Semaphore`, `Latch`, `FiberMap`, `PubSub`, `Queue`, `SubscriptionRef` or
`Stream` as a state carrier, although the repo uses them elsewhere
(`SubscriptionRef.` 152 refs, `RcMap.` 31, `PubSub.` 9, `Stream.debounce` 5,
`FiberMap.` 5, `Latch.` 4).

---

## Finding 1. "Run R is subscribed to target K" is held in two tables joined by a hand-off protocol

**Red flags:** two representations of one fact; reinvented Effect primitive
(a reference-counted resource, a scope); comments substituting for design;
state machine in optional fields (`lifetime?`, `pollLoopStop?`).

**Evidence.** The fact lives once in the source,
`PollingSourceBase.subscriptions: Map<K, S>` with `S.listeners: Set<PollEventListener>`
(`github/PollingSourceBase.ts:178,54-61`), and once in the registry,
`RunSubscriptionRegistry.perRun: PrunedNestedMap<RunId, K, BoundSubscription>`
(`github/RunSubscriptionRegistry.ts:66`). Keeping them equal is a protocol:

- the source tells the registry when its key set changes through
  `onKeysChanged` (`PollingSourceBase.ts:249-256`, 4 refs / 2 files) and the
  registry prunes (`RunSubscriptionRegistry.ts:247-261`, "The source already
  dropped the key: only the close listener goes");
- the registry tells the source when a run leaves through the `Disposable`
  `register` returns (`PollingSourceBase.ts:296-298`) whose `dispose` runs
  `removeListener` (`:434-446`), which may stop the poll loop (`:445`);
- the registry hears the run's inbox close through `inbox.onClosed`
  (`RunSubscriptionRegistry.ts:234-245`) and keeps a `release` thunk per
  binding that a rebind replaces (`:127-132`, "a rebind reassigns it");
- `detach` guards "if `state` is still the key's: a round's poll can outlive
  its state, whose key a new register may hold by then"
  (`PollingSourceBase.ts:411-420`), and `pollEntry` re-checks
  `this.subscriptions.get(key) !== state` (`:583`);
- because the listener fan-out and `dispose` run outside any fiber, log
  entries they produce are queued in `notes: Effect<void>[]` and flushed "by
  the next program this source runs" (`:171-177,228-232,440-442,460-463`);
- the one poll loop per source is started and stopped by hand:
  `pollLoopStop: Deferred | undefined`, `Deferred.makeUnsafe`, `raceFirst`
  against it, `doneUnsafe` to stop, a `while` that calls `stopPolling()`
  "before yielding so a new subscription starts a fresh loop"
  (`:182-183,472-516`), under `Effect.uninterruptible` twice (`:273,475`);
- `lifetime?: PollingLifetime` is optional because a test "drives the source
  through its hooks alone" (`:186-193`), and `register` dies when it is
  absent (`:276-280`); the one such test is
  `src/test-kernel/tools/PRPollingSource.vitest.ts:73`.

`RunSubscriptionRegistry` is generic over a `PollingSourceLike` interface
(`RunSubscriptionRegistry.ts:30-39`, 3 refs / 1 file) with one optional
member, `updateSubscription?`, that only `PRPollingSource` implements
(`PRPollingSource.ts:237-243`) to re-record an annotation level per listener
in a `Map<PollEventListener, Level>` (`:143,246-257`) keyed by the closure
identity of the listener.

**The design decision behind it.** A subscription is modelled as a listener
added to a source that owns its own loop, and the run's ownership is bolted
on beside it. Neither side is the owner, so both keep a copy and the
protocol above keeps the copies equal.

**The better design.** A subscription is a reference-counted scoped resource
keyed by its target, and a run's binding is a reference held in a scope: the
primitive is `RcMap`. `RcMap.make({ lookup, idleTimeToLive: 0 })` once per
process (in the plugin's `processLayer`), where `lookup(target)` builds the
target's resource in the entry's own scope: `PubSub.unbounded<string>()` for
its events and `Effect.forkScoped` of the poll fiber, which is one
`pollOnce(target)` under `Effect.repeat({ schedule: Schedule.fixed(GITHUB_POLL_INTERVAL_MS) })`
with the failure delay (`Effect.sleep(jitteredExponentialBackoffMs(…))`)
inside its `catchTags`. `bind(runId, target, inbox)` is
`RcMap.get(map, target)` (an `Effect<A, E, Scope>`) run in a scope the inbox's
close closes, plus `Stream.fromPubSub(events).pipe(Stream.runForEach(inbox.send))`
forked in that scope; the last release ends the fiber (`idleTimeToLive: 0`
closes the entry when its count reaches zero, `RcMap.js:283-291`). The cap is
a count check before `get`. A target the server says is closed fails its own
fiber, which `RcMap.invalidate` drops. The run's annotation level is a field
of the binding, read at delivery. In-flight deliveries stay in one
`FiberSet` (`FiberSet.run`, `FiberSet.awaitEmpty` under `Effect.timeout` for
the drain). The repo already uses `RcMap` for this shape (31 refs;
`packages/harness/src/shared/session/database.ts`,
`packages/cli/src/runtime/cliService.ts`).

What is deleted: `PollingSourceBase` as a class (its `subscriptions`,
`listeners`, `keysChangedListeners`, `notes`, `logNotes`, `pollLoopStop`,
`register`, `emit`/`emitToListener`'s fork-or-FiberSet branch, `detach`,
`emitErrorAndDetach`, `removeListener`, `notifyKeysChanged`,
`ensurePolling`, `pollLoopProgram`, `stopPolling`, `runRound`, `pollRound`,
`pollEntry`), `onKeysChanged` (4 refs / 2 files), `activeKeys` (3 / 2),
`has` (used by the tool's disambiguation, finding 4), `PollingSourceLike`
(3 / 1), `updateSubscription` (1 implementor), `annotationLevelByListener`,
`BoundSubscription.release`, `releaseOnClose`, `pruneMissingSourceKeys`,
`unbindAll`'s scan (5 refs / 3 files; becomes a map lookup), the three
`makePollingLifetime` calls (`subscriptionRegistries.ts:50-54`; one
`FiberSet` of deliveries stays for the drain), `Disposable` as a return type
here (23 refs / 8 files repo-wide; the other users stay), the `lifetime?`
optional and the test's hook-driving constructor. `jitteredExponentialBackoffMs`
stays as the per-key fiber's failure delay (refuted candidate
`EFF-ADOPT-jitter-helper-stays`).

**What we give up.** The 25/3/10 "max concurrent" numbers stop meaning both
"subscriptions" and "polls in flight" (`config.maxConcurrent` is read for
both, `PollingSourceBase.ts:284,552`): one becomes the cap, the other a
`Semaphore` around the GitHub call, or nothing (one fiber per target already
bounds the fan-out by the cap). `PRPollingSourceAnnotationPages.vitest.ts`
and `PRPollingSource.vitest.ts`, which drive the protected hooks with
hand-built state, are rewritten against the per-target fold (finding 2).

**Change amplification.** A new delivery policy ("deliver to the run that
subscribed last" or "pause a target while its run is stopped") touches today
`PollingSourceBase.ts` (listener set), `RunSubscriptionRegistry.ts` (binding,
rebind, onClosed), each source's `subscribe` (3 files) and the tool (6
files). After: the binding (1 file).

**Depends on:** none. R5/R2 would later make the inbox's close the run
fiber's scope, which removes `inbox.onClosed` from the binding, but the
`RcMap` shape lands without them.

---

## Finding 2. A tick commits state piecemeal through its I/O, so a "staged cache" hand-off protocol exists

**Red flags:** temporal decomposition; comments substituting for design;
one transaction written as a sequence; a callback parameter with one real
shape (`etagSlot`, `isInitialized`).

**Evidence.** A PR tick mutates `state` in place as responses arrive:
`state.etags.issueComments` inside a callback (`github/PRPollingSource.ts:326-328`),
`state.etags.reviews` (`:355`), `state.etags.pr` (`:420`),
`state.lastFailedCheckKeys` (`:584`), `state.currentShaState` replaced
wholesale (`:445-454`), and the check-runs cache is the exception that must
not be written until the end: `fetchAllCheckRuns` returns a `stagedCache`
with a 12-line field doc on when the caller may commit it
(`github/checkRunsClient.ts:65-76`), the caller commits it at two sites
(`PRPollingSource.ts:384,546`) through `commitStagedCheckRunsCache`
(`:633-648`, "The single owner of that write, called from both tick shapes"),
and a 7-line comment explains why the local stays uncommitted
(`:277-281`). The repo poller validates every response up front "because no
parsed response has been committed yet" (`github/RepoPollingSource.ts:207-210`)
and seeds inline in a first-tick block while the shared
`consumeCommentList` seeds for the others; that helper takes an `etagSlot`
callback the repo poller passes as `() => {}` twice (`:288,302`) and an
`isInitialized` thunk that reads `initialized` for PR/Repo and
`commentsSeeded` for Issue (`PollingSourceBase.ts:388-394,398`;
`IssuePollingSource.ts:198`). The seed-vs-diff decision is a boolean per
state (`initialized`, `commentsSeeded`: `IssuePollingSource.ts:55-60`)
rather than "no prior state".

`checkRunsClient.ts` spends its 52-line header (`:78-129`) on mid-walk churn,
`latestTotal` versus `cache.lastTotalCount`, and which total to surface; the
reasoning is correct and is about the same thing: what the next tick may
assume from what this tick stored.

**The design decision behind it.** The tick's state is a mutable object
updated during the fetch, so every partial write has to be reasoned about
against a failure between it and the next write.

**The better design.** A tick is `fetch(prior) → responses` (the I/O, which
may fail as a whole) followed by a pure
`apply(prior, responses) → { next, events }` (the fold); the per-target
fiber holds its state in one `Ref<State | undefined>` (`Ref.make`, `Ref.get`
before the fetch, `Ref.set(next)` after the fold, then `PubSub.publishAll`
of `events`), so there is one write per tick and no partial state is ever
observable. A prior of `undefined` is the seed: `apply` with no prior records
cursors and emits nothing. The check-runs page cache is a field of `next`
like any other, so there is no staging and no commit site;
`fetchAllCheckRuns` returns the pages it read and the fold decides what to
keep. `prCheckRunDomain.ts` is already this shape and becomes the fold's
inner functions.

What is deleted: `stagedCache`, `FetchAllCheckRunsResult`,
`commitStagedCheckRunsCache`, `seedFirstTick` (`PRPollingSource.ts:489-548`),
`initialized`/`commentsSeeded`, `consumeCommentList`'s `etagSlot` and
`isInitialized` parameters (10 refs / 4 files), the two `validateOrSkip`
overloads (14 refs / 5 files; one signature over the response union), the
`stagedCheckRunsCache` local and its comment, the test builders
`createPRSubscriptionState`/`createPRCurrentShaState`
(`src/test-kernel/support/prPollingSourceState.ts`), which become plain prior
values. `DedupedResource` keeps its API but is constructed per `next`, or its
`seenIds` LRU becomes a field the fold carries.

**What we give up.** A malformed single response no longer "skips this
resource and advances the others" within a tick unless the fold says so per
resource; the fold can, and the Issue poller's rule ("a malformed issue
payload must not block comment delivery", `IssuePollingSource.ts:134-138`)
becomes one branch of it instead of control flow around mutations.

**Change amplification.** Adding a per-PR resource (say, "requested
reviewers") touches today the state interface, `initialState`, the fetch
list, the seed block, the diff block, the ETag slot and the test builder (7
places in 3 files); after: the state type, the fetch and the fold (3 places
in 2 files).

**Depends on:** none; lands best with finding 1 (the fiber owns the `Ref`).

---

## Finding 3. A typed failure is wrapped into a defect carrier and unwrapped by inspecting `cause.reasons[0]`

**Red flags:** error handling that should be defined out of existence; a
catch site that re-classifies; `instanceof` over `unknown` where the channel
is typed.

**Evidence.** `ghGet` fails with
`GitHubRequestError | SecretsFailed` (`github/githubClient.ts:147-154`), four
tagged classes. Every poller's `pollOne` is typed `Effect<void, Error, …>`
(`PollingSourceBase.ts:201-204`); the base maps its cause into
`PollHookRejected({ cause })` (`:586-590`) whose doc says it exists "so the
base can classify every one of them without inspecting a wider channel"
(`:77-83`), and then classifies by inspecting the channel: four sites unwrap
"a single `Fail` reason" by hand (`PollingSourceBase.ts:555-561,597-605,606-618`;
`PRPollingSource.ts:701-706,793-805`) to reach `reason.error.cause` and hand
it to `handleFailure(err: unknown)` (`:631-639`), which branches on
`instanceof` (`:640,650,658`). `checkRunsClient.ts` goes the other way and
erases the tags: both exports end in `Effect.fail(ensureError(Cause.squash(cause)))`
(`:322-328,359-365`), and `drainNextAnnotationRun` recovers them by
`instanceof` again (`PRPollingSource.ts:816-824`). The defect branch is
caught on purpose (`:606-618`) with a 9-line justification
(`:570-578`): a subclass bug "would skip annotation draining for every
subscription in the round", which is a consequence of one loop polling every
subscription (finding 1), not a reason to swallow a defect (AGENTS.md
"Silent degradation is a defect").

**The design decision behind it.** The base class wanted one error type from
its hooks, so it made the hooks' real types disappear and recovered them at
runtime.

**The better design.** `pollOne: Effect<void, GitHubRequestError | SecretsFailed, GitHubServices>`
and `fetchAllCheckRuns`/`fetchAnnotations` typed the same way (they already
are inside; only the final `catchCause` erases it); `handleFailure` is one
`Effect.catchTags({ GitHubAuthError, GitHubPermanentError, GitHubRateLimitError, GitHubTransientError, SecretsFailed })`
(`Effect.d.ts:4558`), the primitive for a tagged-union channel.
A defect in one target's fiber ends that fiber and is logged by its
supervisor; nothing is "skipped for every subscription". `validateOrSkip`
stays the one place a malformed 200 body is accepted as "no change".

What is deleted: `PollHookRejected` (10 refs / 2 files + 1 test), the four
`cause.reasons[0]` unwraps, the two `ensureError(Cause.squash)` wrappers,
`handleFailure`'s `unknown` parameter and `instanceof` ladder, the `ok: false`
result objects `drainNextAnnotationRun` and `afterTick` exchange
(`PRPollingSource.ts:699-707,792-806`). `GitHubTransientError` becomes exported
or `classifyFailure`'s default (that table is already in the standing
inventory, `2026-11-03-storage-errors-and-stop-paths.md` "Is this 401/403";
not re-listed).

**What we give up.** Nothing a user sees. A thrown defect inside a poll now
ends that target's fiber instead of being converted into exponential
backoff; that is the harness's rule for defects.

**Change amplification.** A fifth GitHub failure class (a 451 "blocked by
DMCA" that should detach) touches today `githubClient.ts`, `handleFailure`,
`drainNextAnnotationRun`'s ladder and `checkRunsClient`'s squash (4 sites, 3
files); after: `githubClient.ts` and one `catchTags` branch.

**Depends on:** none. The defect part reads best after finding 1.

---

## Finding 4. The subscription target's grammar is parsed, printed and branched on in six modules, and three registries make every command a three-way switch

**Red flags:** information leakage; special and general code mixed; a
derived predicate (`key.includes('/pulls/')`) for a type the code already
had.

**Evidence.** The target `owner/repo[/pulls/N | /issues/N]` is parsed by
`PATH_RE` in the tool (`github/githubSubscriptionTool.ts:164,188-217`),
printed by `prRef`/`issueRef` (`github/githubPaths.ts:13-20`; 31 and 14
refs across 5 files) and by `prKeyToString`/`repoKeyToString`/`issueKeyToString`
(one per source), re-parsed by the settings controller with
`key.includes('/pulls/')`, `key.includes('/issues/')` and a repo regex
(`packages/texra/src/controllers/settingsView/githubSubscriptions.ts:78-83`,
under a comment about "a malformed, legacy, or future key shape"), and the
repo poller parses the number out of GitHub URLs with two regexes of its own
(`github/RepoPollingSource.ts:516,538`). `GitHubSubscriptions` is three
registries (`github/subscriptionBindings.ts:20-28`), so `subscribe`,
`unsubscribe` and `list` each branch three ways (`githubSubscriptionTool.ts:237-319,360-377,395-399`);
`unsubscribe` of an issue path "tries both" registries (`:367-376`) because
`subscribe` may have re-routed it (`:266-310`: "If either source already knows
the entity's type … skip the disambiguation GET"), which is why `has()`
exists on the source.

**The design decision behind it.** The target is a string key with a
grammar instead of a value with a type, and the three sources are three
services instead of three cases of one.

**The better design.** One `SubscriptionTarget` Effect Schema, a
`Schema.TaggedUnion` of `repo | pull | issue` with one string codec
(`Schema.decodeTo` over the path form) used by the tool's input, the map
key (finding 1), the settings controller and the formatters (which take the
target, not `slug, number`). One registry keyed by the target's encoded string (the one place the
string is made: `Schema.encodeSync(SubscriptionTarget)`), since `RcMap`
keys by `Equal`/`Hash`; the disambiguation of `/issues/N` is one
`resolveTarget` that returns the `pull` case when GitHub says so, and
`unsubscribe` is one lookup. The caps stay a function of the case.
`GitHubSubscriptions` is one `RcMap` plus `drain`.

What is deleted: the three `keyOf` functions, `PollingSourceLike.has`,
`knownPR`/`knownIssue` (`:278-283`), the "try both" unsubscribe, the
controller's includes-ladder, `pr`/`repo`/`issue` fields (23 refs / 6 files
collapse to one), `RunSubscriptionRegistry` as a generic (its three
instantiations become one), the per-source `formatXSubscriptionError`
trio (`formatPREvent.ts:292`, `formatRepoEvent.ts:110`,
`formatIssueEvent.ts:56`).

**What we give up.** The `MAX_CONCURRENT_*` trio becomes a small table by
case (3 rows, 1 varying column: a real datum, kept).

**Change amplification.** A fourth target kind (a GitHub Discussion) touches
today: a new source file, a new formatter file, `prSubscriptionConstants.ts`,
`subscriptionRegistries.ts` (lifetime + registry), `subscriptionBindings.ts`,
`githubSubscriptionTool.ts` (grammar, three command branches, description),
the settings controller and `plugin.ts`'s card copy: 8 files. After: the
target schema (one case), its poll function and its formatter: 3.

**Depends on:** none.

---

## Finding 5. The Lean pool keeps a second reference count beside `LayerMap`'s, plus a run-ownership table and a module-level "once per run" set

**Red flags:** reinvented Effect primitive (refcount beside `RcMap`); state
machine in optional fields (`server?`, `stopWhenIdle`); module-level shared
state; error handling defined into existence (`foldStopped`).

**Evidence.** `LayerMap.make(…, { idleTimeToLive })` already counts leases:
the pool reads the map's own count through `RcMap.has(servers.rcMap, root)`
(`lean/direct/leanServerPool.ts:263`) and the header says "Each request holds
a lease (the map's reference count)" (`:7-8`). Beside it,
`RootEntry { server?, owners: Set<RunId>, leases: number, stopWhenIdle }`
(`:115-123`) is a second count with a deferred-stop flag, kept by
`updateEntry` (`:195-198`), `release` (`:284-294`, "`Math.max(0, leases - 1)`"),
`lease` under `Effect.uninterruptible` (`:302-325`, "Uninterruptible where the
lease count and its release are paired"), a `liveEntries` scan that prunes
entries whose server's `closed` Deferred is done (`:200-226`, with a 5-line
race explanation), and `stopSessionsForRun` (`:359-397`), which decides
"inside the update, not from the scan's copy". `stopSessionsForRun` reaches
the pool from `LspTools.leanRunId`, which registers a finalizer on the run's
scope once per run through a module-level `WeakSet<ToolRun['scope']>`
(`lean/LspTools.ts:499-539`), threading `runId: RunId | undefined` through all
six port methods and both adapters (`lean/leanLanguageServices.ts:58-113`;
`LeanLanguageServices` 42 refs / 10 files).

The adapter then converts interruption into a value: `foldStopped` and
`failStopped` (`lean/direct/directLspAdapter.ts:143-181`) turn
`Cause.hasInterrupts` into `adapterStopped()` (6 refs / 2 files) with a
15-line comment that says this reproduces "the old Promise edge"
(`:148-158`), and a `stopped` `Ref` set by a finalizer "so a call that lands
during disposal fails as stopped rather than as interrupted"
(`leanServerPool.ts:190-193,259`). `LeanUnavailable.reason` has three values
(`lean/leanTypes.ts:211-218`); one is read (`toolchain`, `lean/LspTools.ts:137`):
`stopped` and `no-project` are messages, by the rule #14776 just landed ("an
error kind is one a reader decides on").

**The design decision behind it.** A run's use of a server is recorded as
data (`owners`) instead of being a reference the run holds, so the pool
needs its own count to know when the run-owned reference ends, and the tool
needs a once-per-run hook to tell it.

**The better design.** The primitive is the one already there: the
`LayerMap`'s `RcMap` (`servers.rcMap`, `LayerMap.d.ts:80`) and its
reference count. A run's first Lean call takes `servers.contextEffect(root)`
(an `Effect<…, Scope>`, `LayerMap.d.ts:88`) with the run's scope provided
(`Scope.provide(run.scope)`, `Scope.d.ts:313`; `ToolRun.scope` is what
`leanRunId` already reaches) and keeps that reference for the run's life;
every call still leases in its own scope. The map's count is the only
count: the run's end closes its scope, the count drops, and the idle
time-to-live ends the server (`RcMap.js:283-310`). The pool's `make` holds no
`entries`, no `stopped` flag; an interrupted call is an interruption, as the
harness treats every interrupted tool call. The EMFILE path and
`restart_server` are `LayerMap.invalidate(root)` (`LayerMap.d.ts:103`): an
in-use entry is removed from the map and closed when its last reference
releases (`RcMap.js:406-413`, `:283-287`), which is exactly today's
"stop when the final lease ends" without the `stopWhenIdle` flag.

What is deleted: `RootEntry`, `EMPTY_ENTRY`, `updateEntry`, `liveEntries`,
`release`, `lease`'s uninterruptible region, `stopSessionsForRun` (9 refs / 4
files; the port's optional member goes with it), `stopRegistered` and
`leanRunId` (`LspTools.ts:499-539`), the `runId` parameter on six port methods
in three implementations, `adapterStopped`, `foldStopped`, `failStopped`,
`stoppedLspResult`, the `stopped` Ref, `LeanUnavailable.reason`'s two unread
values (the field becomes `toolchain: boolean`, or the setup guidance moves
into the message at the one site that raises it).

**What we give up.** With one count, a run-owned server stops at the idle
time-to-live after its last reference ends instead of at once (today's
`stopNow`); `idleTimeToLive: 0` gives the immediate stop and then a
run-less call (a host invocation outside a run, whose lease is the call's)
restarts the server each time. Either is one rule instead of two; the
thirty minutes in `directLspAdapter.ts:48` is for the second case only.
The EMFILE eviction invalidates busy roots too, after their leases end;
today it skips them (`:228-233`).

**Change amplification.** A new port operation (document symbols) touches
today `leanLanguageServices.ts`, `leanServerPool.ts` (with `runId` and
`withServer`), `directLspAdapter.ts` (with `foldStopped`), `leanServer.ts`,
`packages/extension/src/frontend/lean/VscodeIntegration.ts` and
`LspTools.ts` (with `leanRunId`): 6 files; after, the same six minus the two
conversions, and no `runId` plumbing in any of them.

**Depends on:** none. R2 (the run as a fiber) later makes `ToolRun.scope` the
fiber's scope, which is the same reference.

---

## Finding 6. A per-file condition variable: a Deferred re-armed on every notification, awaited in a timed loop

**Red flags:** reinvented Effect primitive (`SubscriptionRef`/`Stream`);
state machine in mutable fields; a polling loop over a wait.

**Evidence.** Each open file holds `next: Deferred<void, LeanSessionDisposed>`
"completed by the next `publishDiagnostics` or `$/lean/fileProgress`; failed
when the state is abandoned" (`lean/direct/leanServer.ts:204-215`);
`wakeWaiters` swaps in a fresh `Deferred.makeUnsafe()` and succeeds the old
one (`:340-345`); `waitForElaboration` loops `for (;;)`, re-checks that the
file's state object is still the same reference, reads `progress` and a
quiet window computed from `lastDiagnosticsAt`, and awaits `next` under a
400 ms `timeoutOption` (`:588-617`); `abandonFiles` fails every pending
Deferred (`:333-338`) and `restartFile` fails one and deletes the entry
(`:662-663`). `LeanSessionDisposed` carries two meanings, "the server was
disposed, or the file state a wait was pinned to is gone" (`:118-124`). The
per-file lane (`fileLanes`, `withPerKeyLane`, `:520-531`) serializes writers
to this structure. 15 of the area's 23 `Deferred.` uses are here.

**The design decision behind it.** "Has Lean finished this version of the
file" is modelled as a wake-up signal plus mutable fields instead of as a
value that changes.

**The better design.** One `SubscriptionRef<FileState>` per open file
(`SubscriptionRef.make`, `SubscriptionRef.d.ts:93`), where
`FileState = { version, diagnostics, progress }` and the notification
handlers are `SubscriptionRef.update` (`:1248`). `waitForElaboration(file)`
is `SubscriptionRef.changes(ref)` (`:134`; it emits the current value first,
then every change) piped through
`Stream.takeUntil(s => s.progress === 'elaborated')` (`Stream.d.ts:9088`)
and `Stream.runDrain` (`:16198`), raced with the quiet window, which is the
same changes through `Stream.debounce(DIAGNOSTICS_QUIET_WINDOW_MS)`
(`:11372`) filtered to "unreported with diagnostics" and `Stream.take(1)`;
the whole wait under `Effect.timeout(DIAGNOSTICS_WAIT)` (`Effect.d.ts:8266`)
and the result is `SubscriptionRef.get`. Closing the server's scope
interrupts the waiters; `restartFile` replaces the ref. `SubscriptionRef.`
has 152 uses in the repo and `Stream.debounce` 5
(`packages/extension/src/progressView/ProgressViewProvider.ts`).

What is deleted: `OpenedFile.next`, `wakeWaiters`, `abandonFiles`,
`LeanSessionDisposed`'s second meaning (and likely the class: the first
meaning is the scope's interruption), `lastDiagnosticsAt`, the `for (;;)`
loop and its reference-identity check, the 400 ms poll.

**What we give up.** Nothing; the file lane stays for `didOpen`/`didChange`
ordering.

**Change amplification.** A second completion signal (Lean's
`$/lean/ileanInfoFinal`, if it were ever wanted) touches today the state
interface, the handler, `wakeWaiters`' contract and the loop's predicate (4
places); after: the state and the `takeUntil` predicate.

**Depends on:** none.

---

## Finding 7. The server roster is a second record of what the pool already knows, with a generation counter for ids

**Red flags:** two representations; generation counter; `Date.now()` in a
record a renderer formats.

**Evidence.** `createLeanServerRoster` (`lean/leanServerRegistry.ts:63-95`)
is a `Map<string, LeanServerInfo>` with `status: 'starting' | 'running' | 'error' | 'stopped'`,
written by five `roster.*` calls in `leanServer.ts` (`:296,302,427,479`) and
three in `VscodeIntegration.ts` (`:128-132`), with ids from a module counter
"so an old server closing must not clobber its replacement's entry"
(`leanServer.ts:224-225,290-291`). The pool's `LayerMap` knows the roots and
each server knows its end (`ended`, `closed`); the roster restates both as
strings. `startedAt: Date.now()` (`:76`) is formatted against another
`Date.now()` in `summarizeLeanServers` (`:112`).

**The design decision behind it.** The dashboard's list is kept as a
separate table rather than read from the services that are the servers.

**The better design.** `listServers` is derived: the direct pool answers
from `RcMap.keys(servers.rcMap)` (`RcMap.d.ts:654`) and each server's
`Deferred.isDone(ended)` (`Deferred.d.ts:1324`) plus the start time the
server holds; the VS Code bridge answers from the extension's clients.
`LeanServerInfo` stays as the shape; `LeanServerRoster`,
`createLeanServerRoster` (6 refs / 4 files), `register`/`update`/`unregister`,
`serverSequence` go. `isLeanServerActive` (3 / 2) stays as a predicate on
the derived shape.

**What we give up.** An `error` status with its message after a server has
been dropped from the map: today the roster keeps the last error until
`unregister` (`:302-306` drops it at scope end anyway, so nothing is lost).

**Change amplification.** A new server fact shown on the card (the
toolchain version) touches today `LeanServerInfo`, `register`, `update`,
both adapters' calls and `statusTail` (6 places); after: the info shape and
the one derivation per adapter.

**Depends on:** finding 5 for the direct pool's keys; the VS Code half lands
alone.

---

## Finding 8. The Lean port carries optional host hooks, and its command table holds rows one host answers with an error

**Red flags:** a port with hooks one implementation fills; special and
general code mixed; a declarative table with a column constant per host.

**Evidence.** `LeanLanguageServicesShape` has two optional members,
`navigateToFirstError?` and `stopSessionsForRun?` (`lean/leanLanguageServices.ts:96-113`),
each with a comment explaining which host omits it and why; `lean_diagnostics`
calls the first through `?.() ?? Effect.void` (`lean/LspTools.ts:205-207`).
`LEAN_PROJECT_COMMANDS` lists ten commands (`lean/leanTypes.ts:66-102`); the
direct pool answers four of them (`install_elan`, `install_deps`,
`update_elan`, `select_toolchain`) with "only available inside VS Code"
(`leanServerPool.ts:489-497`), while the VS Code bridge maps them to
`lean4.setup.*` command ids (`VscodeIntegration.ts:100`) and the setup plugin
already has `invoke_command` over an allowlist of VS Code command ids
(`setup/InvokeCommandTool.ts:13,40`). `executeFileCommand(command, …)` takes a
command the direct adapter ignores ("Both file commands have the same effect
from our point of view", `leanServerPool.ts:534-535`; `directLspAdapter.ts:92-93`).

**The design decision behind it.** The port is the union of what two hosts
can do, so each host fills the holes with an optional, an error branch or an
ignored argument.

**The better design.** No primitive is missing here; the fix is the
contract. The port is the language-server operations every adapter has
(diagnostics, three position requests, restart file, build/clean/cache).
The four setup rows move to the setup plugin's allowlist as VS Code
commands (where `install_vscode_extension` already lives), and the `Setup`
group leaves the `lean_project` prose; `navigateToFirstError` is an editor
capability on `EditorHost` (finding 9), not a Lean one; `stopSessionsForRun`
goes with finding 5. The `lean_file` pair stays (VS Code distinguishes them).

What is deleted: the two optional members, the `install_*`/`update_elan`/
`select_toolchain` rows and their error branch, `LeanProjectCommandError`'s
"only available inside VS Code" message, the `?.() ?? Effect.void` call.

**What we give up.** The agent reaches toolchain installation through
`invoke_command` on VS Code instead of `lean_project`; the CLI never could.

**Change amplification.** A third host adapter today implements nine members
and decides which of two optionals to omit; after, seven required members.

**Depends on:** none.

---

## Finding 9. A plugin reaches its host six different ways, and one capability is a bare flag

**Red flags:** overexposure / an option for a special case
(`inquiryPanel?: true`); repetition (capability names spelled three times);
a compatibility alias in a persisted id.

**Evidence.** `texraPlugins(host)` (`registry.ts:322-425`) takes: a
host-built layer (`lean?`, `:327`), provider objects each wrapped per plugin
in `Layer.succeed` (`inlineComments?` → `InlineComments`, `:241-247`;
`setup?` → `SetupPlatform`, `:259-270`; `editors?` → `EditorHost`, `:194-199,238-239`),
a bare flag `inquiryPanel?: true` that only chooses whether to serve a
capability name (`:338,408-417`), and a host name literal
`'vscode' | 'desktop' | 'cli'` served as `SetupHost` (`:258,422`;
`setup/platform.ts:117-120`), read once (`setup/ProbeEnvironmentTool.ts:118`).
`HostCapabilities` is produced three ways: `serves()` over
`Object.entries(platform)` (`:265-269`), `makeEditorHost().of` deriving
`'diagnostics'` from the presence of `readDiagnostics` (`editorHost.ts:120-123`),
and the constant list for inline comments and the inquiry panel. Each
capability name is spelled in the tool (`hostCapability: 'diagnostics' satisfies EditorCapability`,
`DiagnosticsTool.ts:214`; `InlineCommentTool.ts:314`;
`ExternalInquiryTool.ts:391`), in its `satisfies` type, and in the plugin's
`serves` call. The GitHub plugin's id is kept as `github-pr-subscription`
"for back-compat with persisted disabled-tool preferences"
(`github/plugin.ts:24-27`), spelled again in the settings controller
(`packages/texra/src/controllers/settingsView/githubSubscriptions.ts:30`);
AGENTS.md "Compatibility and format retirement" rules aliases out.

Open PR 14773: this finding changes how `texraPlugins` hands host services
to plugins in `registry.ts`, the file that also carries the documents
plugin's `agentBlock` and `scriptModules`; sequence it against that
proposal's catalog changes.

**The design decision behind it.** Each plugin invented its own way to be
handed a host service, and the harness's capability string is derived from
each by hand.

**The better design.** One rule: a host passes a partial record of host
services (`{ inlineComments?, editors?, setup?, lean?, inquiries? }`);
`texraPlugins` turns each present member into its `Layer.succeed(Tag)(value)`
(`Layer.d.ts:839`; a member that needs a resource is a `Layer.effect` whose
effect may use `Scope`, `Layer.d.ts:1166`, since 4.1.2 has no `Layer.scoped`)
and the plugin's `HostCapabilities` from presence by one function, so a
tool's `hostCapability` names the service key and nothing else restates it.
`HostCapabilities` itself is the shape AGENTS.md calls a
`Context.Reference` (`Context.d.ts:1741`, `defaultValue: () => ({ of: () => new Set() })`):
a plugin that serves nothing serves nothing, instead of `serves(() => [])`
(that tag is the harness's, area M). The inquiry panel is the presence of a
service (the inquiry decision surface the two hosts with a progress view
provide), not `true`. The plugin id becomes `github`; the one persisted key
that named it is a preference 1.0 does not carry over.

What is deleted: `inquiryPanel?: true`, the `serves()` helper's three
hand-written lists, `InlineCommentCapability`/`InquiryPanelCapability`/
`EditorCapability` as separate literal types (one derived union), the
back-compat comment and the duplicated id string.

**What we give up.** Nothing; `SetupHost`'s name stays as a prompt fact.

**Change amplification.** A new host-provided capability (an editor's
"reveal range") touches today the tool (literal + type), `registry.ts`
(host parameter and a `serves` list), `editorHost.ts`, `packages/extension/src/extension.ts:136`
and `packages/desktop/src/main/platform/index.ts:91`: 5 files. After: the tool
and the host that provides it.

**Depends on:** none.

---

## Finding 10. The arXiv rate limit is a module-level `SynchronizedRef` with a comment explaining why it cannot be a layer, beside a plugin system whose `processLayer` is for exactly that

**Red flags:** reinvented primitive; shared module state; a comment
substituting for design.

**Evidence.** `arxiv/ArxivSearchTool.ts:61-76`: `nextRequestAt = SynchronizedRef.makeUnsafe(0)`
and `awaitArxivSlot`, with "its state is module-level: `Effect.provide`
builds a layer afresh per tool call, which would give each call a limiter of
its own". The GitHub plugin already owns a process-lifetime `RateLimiter`
through `processLayer` (`github/subscriptionRegistries.ts:55-69,98-100`;
`ProcessPluginLayer`, `packages/harness/src/tools/toolTable.ts:52-63`), and the
Lean plugin owns its pool the same way. `arxiv/plugin.ts` has no
`processLayer`.

Open PR 14773: the two module-level memos this finding also names live in
or serve `agentCli/` (`support/externalBinaryUtils.ts`, consumed by
`agentCli/claudeAgentImport.ts` and `codexImport.ts`); sequence that part
against the proposal.

**The better design.** `arxiv`'s `processLayer` serves Effect's
`RateLimiter` (`RateLimiter.layer` over `RateLimiter.layerStoreMemory`,
`persistence/RateLimiter.d.ts:94`, as the GitHub layer already composes it)
and `ArxivSearchTool` runs the request under
`consume({ algorithm: 'fixed-window', onExceeded: 'delay', window: '3 seconds', limit: 1, key: 'arxiv' })`
(`:47-54`; `'delay'` sleeps until a token is free, `:139-140`): the queue of
waiters, arrival order and interruption are the limiter's. Deleted:
`nextRequestAt`, `awaitArxivSlot`, the comment. The same move answers
`support/externalBinaryUtils.ts:255`'s `createCachedBinaryResolver`, whose
"cache a hit for the process, retry a miss" is exactly
`Effect.cachedWithTTL((exit) => Exit.isSuccess(exit) && exit.value !== undefined ? Duration.infinity : Duration.zero)`
(`Effect.d.ts:13625`, the TTL computed from the `Exit`), built once in the
agent-CLI plugin's `processLayer`; and `lean/direct/lakeCommands.ts:30`'s
module-level `workspaceLanes`, which is a `Semaphore.make(1)`
(`Semaphore.d.ts:253`, `withPermits`, `:79`) held by the root's `LeanServer`
service, since `runLake` already leases the server for the command
(`leanServerPool.ts:419-424`).

**What we give up.** Nothing.

**Change amplification.** A second arXiv tool (abstract fetch) today must
import the module singleton; after, it yields the plugin's service.

**Depends on:** none.

---

## Finding 11 (batched). Smaller flags, each one sentence of evidence

- **Two classifiers of one Zotero transport failure.** `bbtRequestError`
  (`zotero/bbtClient.ts:233-259`) and `connectorRequestFailure` (`:353-372`)
  both branch on timeout and `isTransportReason`; the connector returns a
  value-channel `ConnectorResult` (`:331-333`) so `addItem` can report per
  item. One `zoteroRequestFailure(error, port, timeout): ToolError` and a
  typed failure, with `Effect.result` (`Effect.d.ts:3560`) at the per-item site; the uninterruptible
  region (`:438`) and its 25-line justification stay (see "Already settled").
- **Snapshot-or-metadata decided by scanning the fields.** `ZoteroItemSchema`
  admits nine optionals and a `check` for "url or title" (`zotero/ZoteroAddTool.ts:39-107`);
  `addItem` re-derives the kind with `Object.values(metadata).some(...)`
  (`:189-192`). A two-case union (`{ url } | { title, … }`) decides it at the
  boundary; the OpenAI null-filling caveat (`packages/harness/AGENTS.md` "Tool
  input schemas") applies, as it does to the GitHub tool's union already.
- **Two ways to reach `AppSignals` in one plugin.** `emitAppSignal('githubTokenInvalid')`
  from the Effect context (`PollingSourceBase.ts:646`) and `opts.signals.emit('githubSubscriptionsChanged')`
  from a service captured at construction (`RunSubscriptionRegistry.ts:264`,
  passed in `:48-49`). After finding 1 both are `emitAppSignal`.
- **`support/` is a directory with one file used by one plugin.**
  `externalBinaryUtils.ts` (SDK import, binary probe, Electron detection) has
  two consumers, both in `agentCli/` (`claudeAgentImport.ts`, `codexImport.ts`);
  it belongs there under a name for what it does. Its 40% comment share is
  environment facts (esbuild interop, npm shims), not a protocol; fine.
  Open PR 14773: touches `agentCli/`.
- **`config.maxConcurrent` names two facts** (finding 1's "give up").
- **`PollingSourceConfig.name` doubles as log channel and error prefix**
  (`PollingSourceBase.ts:96-100`); after finding 1 the channel is the
  target's kind.

---

## Good modules in this area

- `github/prCheckRunDomain.ts`: total functions over plain data, no `this`,
  no I/O; `planAnnotationCandidates` returns the mutations as a value. The
  shape finding 2 wants for the whole tick.
- `github/githubClient.ts` `ghGet`: one scope, one deadline, typed failures,
  the ETag contract in one place.
- `github/pollingDedup.ts` `DedupedResource`: a small interface over the
  eviction race, with the reason for classify-then-insert in two lines.
- `github/formatUtils.ts` `wrapWebhookEvent`: the neutralizer derived from
  the tag constant, so they cannot drift.
- `github/checkAnnotationLevels.ts`: rank table read back for both the
  filter and the display order.
- `zotero/bbtClient.ts` `callBetterBibTeX` and `BbtSearchResultItemSchema`:
  the external shape decoded once, into the one shape the tool reads, with a
  decode-only transform where nothing encodes.
- `lean/direct/lakeCommands.ts` `runLakeCommand`: the child owned across
  interruption, one lane per root, the reason stated once.
- `lean/leanTypes.ts` command tables: the input enum, the prose and the
  result summaries from one frozen table.
- `zotero/ZoteroCollectionsTool.ts` tree build/filter/format: three pure
  functions.
- `registry.ts` `documents` and `latexExtract` entries: a plugin as a
  literal.

## Already settled, left alone

- `jitteredExponentialBackoffMs` with its ±20% contract
  (`PollingSourceBase.ts:684-689`): refuted candidate
  `EFF-ADOPT-jitter-helper-stays` and
  `.agents/docs/implemented/simplification/2026-09-20-effect-facility-adoption.md` §2.3.
- `AgentCliSessionRegistry` as a `Set` with a `claim` behind two service tags
  (`agentCli/agentCliSessionRegistry.ts`, `agentCliSessionStores.ts`): found,
  `2026-11-06-root-designs-pr1-compromises.md` §3. Open PR 14773 redesigns
  `agentCli/`'s neighbourhood; nothing here is proposed against it.
- GitHub `classifyFailure`'s 401/403 reading (`githubClient.ts:97-145`) and
  the arXiv processor's hand-rolled retry: in the standing inventory,
  `2026-11-03-storage-errors-and-stop-paths.md` ("Is this 401/403",
  "Transient HTTP status"); the Lean `LeanFileReadError` re-wrap it listed is
  recorded there as done (`leanServerPool.ts:516-519` raises `LeanFileUnreadable`
  directly).
- `callZoteroConnector` under `Effect.uninterruptible` (`bbtClient.ts:401-443`):
  a non-idempotent remote write has no primitive that makes the torn-write
  question disappear; the comment is honest about what it does and does not
  guarantee. Kept.
- `unrefSleepClock` (`PollingSourceBase.ts:507`): the unref'd timer is a Node
  host fact, not a reinvented primitive.
- `Effect.ignore(handle.exitCode)` in `stopProcess` (`leanServer.ts:274-276`):
  a signal-killed child has no exit code; the wait is the point. Fine.
- `ProcessPluginLayer.drain` with one implementor (`github/plugin.ts:33`;
  `packages/harness/src/tools/toolTable.ts:62`): the harness's port (area M);
  noted, not proposed here.
- `withZoteroPort` (`bbtClient.ts:50-64`): four callers, one setting; a
  wrapper that earns its place.

---

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

| #   | Hand-rolled today                                                                                                                                                                                                                                      | Effect primitive                                                                                                            | Exact API verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it fits                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `subscriptions` Map + `listeners` Set + `pollLoopStop` Deferred + `onKeysChanged`/`Disposable` hand-off + `notes[]` (`PollingSourceBase.ts:54-61,171-183,249-256,472-516`; `RunSubscriptionRegistry.ts:66,234-261`)                                    | `RcMap` keyed by target; `PubSub` per entry; `Effect.forkScoped` poll fiber; `FiberSet` for deliveries                      | `RcMap.make({ lookup, idleTimeToLive, capacity })` → `Effect<RcMap, never, Scope \| R>` (`RcMap.d.ts:215`); `RcMap.get(map, key)` → `Effect<A, E, Scope>` (`:379`); `RcMap.invalidate` (`:701`; a removed in-use entry closes on its last release, `RcMap.js:406-413,283-287`); `RcMap.has` (`:822`), `RcMap.keys` (`:654`); `PubSub.unbounded({ replay? })` (`PubSub.d.ts:444`), `PubSub.subscribe` → `Effect<Subscription, never, Scope>` (`:1437`), `Stream.fromPubSub` (`Stream.d.ts:1050`); `FiberSet.make`/`run`/`awaitEmpty` (`FiberSet.d.ts:106,457,686`); `Effect.repeat({ schedule })` (`Effect.d.ts:14660`), `Schedule.fixed` (`Schedule.d.ts:786`) | the count of bindings is the lifetime of the poll; no second table, no stop signal, no fiberless log queue    |
| 2   | in-place mutation of `state` through the fetch; `stagedCache` + `commitStagedCheckRunsCache` (`PRPollingSource.ts:277-281,384,546`; `checkRunsClient.ts:65-76`)                                                                                        | one `Ref<State \| undefined>` per target, written once per tick after a pure fold                                           | `Ref.make` (`Ref.d.ts:154`), `Ref.update`/`Ref.modify` (`:603,409`); `PubSub.publishAll` (`PubSub.d.ts:1309`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | one write point; partial state cannot be observed, so nothing is "staged"                                     |
| 3   | `PollHookRejected` wrapper + `cause.reasons[0]._tag === 'Fail'` unwraps + `instanceof` on `unknown` (`PollingSourceBase.ts:555-618,631-658`; `PRPollingSource.ts:701-706,793-805`)                                                                     | the typed channel `GitHubRequestError \| SecretsFailed` and `Effect.catchTags`                                              | `Effect.catchTags` (`Effect.d.ts:4558`), `Effect.catchTag` (`:4392`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the tags already exist at `ghGet`; classification is a `_tag` switch, defects die                             |
| 4   | `PATH_RE`, `prRef`/`issueRef`, three `keyOf`, `key.includes('/pulls/')` (`githubSubscriptionTool.ts:164`; `githubPaths.ts:13-20`; `controllers/settingsView/githubSubscriptions.ts:78-83`)                                                             | one `Schema.TaggedUnion` with one string codec                                                                              | `Schema.TaggedUnion` (`Schema.d.ts:5340`), `Schema.decodeTo(to, { decode, encode })` (`:4674-4675`), `Schema.Union` (`:4147`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | one owner of the grammar; the registry keys by the codec's encoded string                                     |
| 5   | `RootEntry{server?, owners, leases, stopWhenIdle}` + `liveEntries` prune + `stopSessionsForRun` + `stopRegistered` WeakSet + `foldStopped` (`leanServerPool.ts:115-123,200-226,284-325,359-397`; `LspTools.ts:499-539`; `directLspAdapter.ts:143-181`) | the `LayerMap`'s own `RcMap` count; a lease held in the run's `Scope`                                                       | `LayerMap.make(lookup, { idleTimeToLive })` (`LayerMap.d.ts:148-149`), `LayerMap.rcMap` (`:80`), `contextEffect(key)` → `Effect<Context, E, Scope>` (`:88`), `invalidate(key)` (`:103`); `Scope.provide` (`Scope.d.ts:313`), `Scope.addFinalizer(scope, fin)` (`:460`); release rule `RcMap.js:279-310`                                                                                                                                                                                                                                                                                                                                                        | one count per server; the run's scope is the owner; invalidate-then-release-on-zero is today's `stopWhenIdle` |
| 6   | `OpenedFile.next` Deferred re-armed per notification, `for(;;)` wait with `timeoutOption(400ms)`, `abandonFiles` (`leanServer.ts:204-215,333-345,588-617`)                                                                                             | `SubscriptionRef` per file; `Stream.takeUntil` + `Stream.debounce` under `Effect.timeout`                                   | `SubscriptionRef.make` (`SubscriptionRef.d.ts:93`), `update` (`:1248`), `changes` → `Stream<A>` emitting the current value first (`:134` and its doc); `Stream.takeUntil(pred, { excludeLast? })` (`Stream.d.ts:9088`), `Stream.debounce(duration)` (`:11372`), `Stream.runDrain` (`:16198`), `Stream.timeout` (`:2917`); `Effect.timeout` → `E \| TimeoutError` (`Effect.d.ts:8266`)                                                                                                                                                                                                                                                                          | the file's state is a value that changes; waiting is reading its stream; disposal is scope interruption       |
| 7   | `createLeanServerRoster` Map + status strings + `serverSequence` (`leanServerRegistry.ts:27,63-95`; `leanServer.ts:224-225`)                                                                                                                           | derive from `RcMap.keys` and `Deferred.isDone`                                                                              | `RcMap.keys` (`RcMap.d.ts:654`), `Deferred.isDone` (`Deferred.d.ts:1324`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the map and the server already hold the facts                                                                 |
| 8   | optional port members, VS Code-only rows in `LEAN_PROJECT_COMMANDS` (`leanLanguageServices.ts:96-113`; `leanTypes.ts:66-102`)                                                                                                                          | none (a contract)                                                                                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | not a primitive problem                                                                                       |
| 9   | six host hand-off shapes, `inquiryPanel: true`, `serves(() => [...])` ×3 (`registry.ts:241-247,259-270,322-339,408-417`; `editorHost.ts:120-123`)                                                                                                      | `Layer.succeed`/`Layer.effect` per present host service; `Context.Reference` for a defaulted capability set                 | `Layer.succeed` (`Layer.d.ts:839`), `Layer.effect(Tag)(effect)` with `Scope` excluded from `R` (`:1166`; no `Layer.scoped` export in 4.1.2: `build`, `buildWithScope`, `effect`, `effectContext`, `unwrap` are the scoped forms), `Context.Reference(key, { defaultValue })` (`Context.d.ts:1741`)                                                                                                                                                                                                                                                                                                                                                             | presence of a service is the capability; a default-empty reference needs no `serves`                          |
| 10  | module-level `SynchronizedRef` sleep-until (`ArxivSearchTool.ts:68-76`); `createCachedBinaryResolver` (`externalBinaryUtils.ts:255`); module `workspaceLanes` (`lakeCommands.ts:30`)                                                                   | `RateLimiter` in a `processLayer`; `Effect.cachedWithTTL` with an `Exit`-computed TTL; `Semaphore(1)` in the server's scope | `RateLimiter.consume({ algorithm, onExceeded: 'delay' \| 'fail', window, limit, key })` (`persistence/RateLimiter.d.ts:47-54`), `RateLimiter.layer`/`layerStoreMemory` (`:94`); `Effect.cachedWithTTL((exit) => Duration.Input)` (`Effect.d.ts:13625`), `Effect.cachedInvalidateWithTTL` (`:14030`); `Semaphore.make(permits)` (`Semaphore.d.ts:253`), `withPermits` (`:79`)                                                                                                                                                                                                                                                                                   | process-lifetime state belongs to the plugin's process layer, which the harness already builds and tears down |
| 11  | `ConnectorResult` value-channel error beside `ToolError` (`bbtClient.ts:331-333`)                                                                                                                                                                      | typed failure + `Effect.result` at the per-item site                                                                        | `Effect.result` → `Effect<Result<A, E>>` (`Effect.d.ts:3560`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | one classifier, one channel                                                                                   |

Corrections made while verifying: `Layer.scoped` does not exist in 4.1.2
(finding 9 names `Layer.effect`, whose `R` excludes `Scope`); `Effect.repeat`
takes `{ schedule, while, until, times }` options (`Effect.d.ts:14515`
`namespace Repeat`), which is what `PollingSourceBase.ts:499-506` already
uses, so finding 1 keeps `Schedule.fixed` and moves only the failure delay
into the fiber; `RcMap.invalidate` on an in-use entry defers the close to
the last release (`RcMap.js:406-413`), so finding 5's EMFILE path keeps
today's "after the lease ends" semantics with no flag; `Effect.cachedWithTTL`
takes a TTL computed from the `Exit`, which expresses "hits forever, misses
retried" exactly, so finding 10 replaces the `SynchronizedRef` memo with it
instead of a layer-held `Ref`.
