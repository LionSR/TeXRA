# Simplification survey: agent runtime, hosts, session, and lifecycle ownership (2026-09-02)

> **Status:** survey record, read-only. Grounded on `origin/main` at `a78a896`
> (#11754). No code changes accompany this entry. Two multi-agent passes ran
> over one territory: an **ownership survey** (12 domain readers) and a
> **dual-system census** (8 species readers), each candidate then put through
> two independent adversarial lenses. Every claim below carries the verifiers'
> corrections rather than the finders' original wording. Re-open every cited
> site before acting — this territory changes at ~20 PRs/day.

## 0. The question, and the honest verdict

The maintainer asked for a comprehensive look at **the coupling and ownership
of the agent runtime versus the four hosts (VS Code extension, Electron
desktop, terminal CLI, the `@texra-ai/agent` package), the session, and the
lifecycles**, and then explicitly for the **dual-system** lens on top.

The verdict has two halves.

**The ownership architecture is sound, and the dual-system ledger is nearly
drained.** The three planes of the 2026-07-03 session-scoped design hold at
HEAD: facts flow one way through `SessionEventHub`, requests are awaited calls
on `session.interactions`, and status has one writer. Of the nine live rows in
the 2026-07-09 dual-systems census, **six are fully resolved** and one is
ruled-keep; `AgentRuntimeHost` is gone entirely; no session-scoped mutable
module singleton survives. The five lifecycle roots landed, `DisposableStore`
is the house idiom, and the CLI's `StreamSlice` lifecycle mirror — the
2026-08-25 seam audit's highest-risk row — is deleted.

**What remains is residue, not architecture.** The 42 findings that survived
adversarial verification are overwhelmingly _leftovers of completed
migrations_: a guard that became a tautology when the store it counts moved
into the session constructor, a replay queue whose second copy can no longer
be reached, a vocabulary that exists to be mapped back to the vocabulary it
came from, seams injected for tests that production never passes. Three are
live defects. None requires a new abstraction; every accepted item deletes.

|                       | ownership survey | dual-system census |
| --------------------- | ---------------: | -----------------: |
| candidates raised     |               61 |                 34 |
| refuted by a verifier |               40 |                 13 |
| survived both lenses  |               21 |                 21 |

## 1. Method

Two workflows, same territory, different lens.

**Pass 1 — ownership survey.** Twelve readers, one per ownership domain:
session root; execution registry and handles; launch/run lifecycle; resume,
repair and leases; host interactions and approvals; facts-to-renderers; child
runs and follow-ups; process root and shutdown; progress-view controllers and
their two GUI wirings; transcript-store lifetimes; the CLI chat controller;
and the frozen SDK surface plus the ratchet baselines. Each read its file list
in full — not search hits — and ran `git log` per cited file so it reported
HEAD rather than the state a prior audit described.

**Pass 2 — dual-system census.** Eight readers, one per species: old-path and
new-path coexistence; two vocabularies for one fact; dual writes; dual access
paths and subscribe surfaces; host mirrors of shared state; dual carriers of
one outcome; dual registries and scopes; dual UI homes for one user action.
Each also re-verified the recorded ledger rows in its species at HEAD, which
is where §3 comes from.

**Verification.** Every candidate went to two adversarial verifiers instructed
to refute and to default to refuted when uncertain. Lens A checked the corpus
and the record: does the claim reproduce at HEAD, is there a missed production
consumer, is it a cleanup or a feature decision, and is it already filed,
landed, booked, or ruled? Lens B checked cost and invariants: re-derive the
net LoC and element delta from the code, does it add a plane/port/vocabulary
(R4) or a single-caller extraction, and does it break exactly-once terminal
settlement, lease fencing, dispose-to-quiescence, generation fencing, the
frozen CLI NDJSON wire, or archived `trace.json` parseability? A candidate
died on any high-confidence refutation or on both lenses refuting.

**Hand verification.** Eight of the highest-leverage items were re-opened
directly rather than trusted: the vacuous hub assertion, the missed-result
replay, both toggle readers, the detach-set re-derivation, the legacy status
union arm, the bypass triplet, the raw hub subscriptions, and the undated
lease reader. All eight reproduce exactly as described. Those files are named
in §6.

**What this pass did not do.** No code changed; no issue was filed. The
settled surfaces listed in §5 were cited and skipped, not re-litigated.

## 2. Findings

Ranked by leverage — deletable elements × bug-yield × safety. Every entry
states the _corrected_ claim; where the two lenses narrowed a finder's scope,
the narrowed version is what appears.

### 2.1 Live defects (fix regardless of the cleanup they ride with)

**D1. The extension silently drops the resume-failure notice.**
`HostInteractions.showInfoMessage` is an optional port member implemented only
by the desktop adapter (`desktopAgentExecution.ts:381`). The extension's
`createExtensionHostInteractions` never attaches it, yet
`resumeFromResumeData.ts:50-54` calls
`session.interactions.showInfoMessage(describeFollowUpFailure(...))` — which
resolves to `active.interactions.showInfoMessage?.(message)`, i.e. `undefined`,
so a user whose resume is refused sees nothing. A queued replay drops it too.
Two fixes, and the choice is the maintainer's: attach a three-line implementor
in the extension (keeps the one-message port), or delete the port and route
both producers through `emit('requestShowError', …, { replayWhenAttached: true })`
as desktop's sibling failure already does. The second is ≈ −15 production
lines but **promotes a warning-class message to error styling on both GUI
hosts**, because no info-level presentation event exists. Say that in the PR.

**D2. `createSessionStores` re-derives the registry's detach set, misses
native children between turns, and double-emits their parent-edge clear.**
`onChildrenDetached` (`createSessionStores.ts:30-47`) builds a `Set` of child
stream ids from `getActiveChildren(parent)` — full `ActiveChildInfo` rows, used
only for one field — then calls `detachActiveChildren(parent)`, which already
collects exactly those ids and emits `setParentStream: null` for each, and
then emits `setParentStream: null` again for every durable child not in its
`Set`. Because `getActiveChildren` iterates handles only while
`detachActiveChildren` also detaches _activations_, a native child between
turns is emitted twice. Fix: have `detachActiveChildren` return the
`detachedChildStreamIds` array it already builds
(`executionRegistry.ts:582-602`) and let the caller skip those. ≈ −4 LoC, and
the D15 ordering rider is preserved because `detachActiveChildren` still runs
first.

**D3. A persisted string silently re-enables orchestrator kills.** Both
child-policy toggles are read with a hand-rolled
`platform().globalState.get<boolean>(key, handPassedDefault)` beside a
`warnAbandonedSlotValue` call, duplicating the default the settings catalog
already declares. `get<boolean>` casts rather than coerces:
`detachSubagentsOnStop` at least compares `=== true` (silently mapping a
hand-edited `"true"` to false), while `ExecutionsTool.handleKill` has no guard
at all, so a persisted `"false"` string reads as _allowed_. `readPlatformSetting`
already resolves the row's slot, takes the default from its `.prefault()`, and
warns before snapping an invalid persisted value. ≈ −8 production lines plus
one test-assertion edit; keep both `warnAbandonedSlotValue` calls (see L4).

### 2.2 Dead surface — high confidence, clean deletion

**S1. The run-subscriber assertion is a tautology.** `SessionEventHub` keeps
two counters updated on _every_ subscribe and unsubscribe so
`assertRunSubscribersAttachedBeforeActivation` can throw in dev and warn in
production. But `SessionHandle`'s constructor calls
`snapshots.attachSessionEvents(events, …)`, which registers a
`{ scope: 'run', types: SNAPSHOT_RUN_FACT_TYPES }` subscription with no
streamId, detached only at teardown. Every session — all four hosts and every
`createTestSession()` — therefore has a run-scope subscriber from
construction, and the guard's early return is always taken. Both production
call sites reach the hub through a `SessionHandle`; the only place the throw
is observable is a bare `new SessionEventHub()` in a test. Making it
meaningful would need subscriber tagging, i.e. new vocabulary (R4). Delete the
method, the two counters, the bookkeeping, and the `isDevAssertionMode`
import. ≈ −50 production lines, ≈ −87 test lines. Land the hub's `dispose()`
(see S2) in the same PR so no stale counter survives on a dead hub.

**S2. A second, unreachable replay queue for terminal results.**
`SessionHandle` carries `missedTerminalResults`, `replayResultListenerCount`,
`replayMissedResultsEnabled`, `isReplayableTerminalResult`, a microtask replay
in `onResult`, and a `result` branch in `publishRunEvent`, so a terminal
result published while no replay-subscribed listener is attached can be
replayed later. The only producer of `replayMissed: true` is
`attachTerminalResultToast(…, { replayWhenAttached: true })`, which forwards
the _same_ options object to `interactions.emit`, whose own
`pendingPresentationReplays` queue already retains the toast until a host
attaches. Recording requires `replayMissedResultsEnabled && count === 0` — a
state reachable only by attach → detach → result → re-attach, and no host ever
detaches that listener within a process. Dead in all four hosts. ≈ −50 lines.
Keep `resultListenerDetachers` (the hub is not disposed at teardown, so that
bookkeeping is load-bearing) and rewrite the two doc comments that justify the
method by the replay. _(Found independently by both passes.)_

**S3. The live wire union still accepts the retired seven-value status.**
`StreamLifecycleStatusSchema` carries a fourth member,
`StreamStatusSchema.transform(streamStatusToLifecycleStatus)`, that re-maps
`error | stopped | resuming | initializing`. Its one consumer is
`BackendOwnedFieldsSchema.status`, and every producer of that field is typed
`StreamPhase | 'ready' | 'unavailable'` and ships in the same bundle. The real
trace-import boundary is `StreamSnapshotSchema.status`, whose own
`LegacyStreamStatusAsPhaseSchema` normalizes archived `trace.json` before
anything reaches this schema — so the arm is unreachable, and the comment
above `STREAM_STATUS` that points at it is wrong. Delete the member and fix
the comment; `z.output` is unchanged, so no consumer retypes. `StreamStatus`
itself keeps one in-file consumer and can only lose its `export`. A wider
variant (retire the `READY` spelling: introduce `STREAM_LIFECYCLE_READY`
beside `STREAM_LIFECYCLE_UNAVAILABLE` and move ~30 test sites off
`STREAM_STATUS.RUNNING/WAITING`) reaches ≈ −40 production lines but costs nine
test suites; take the one-member deletion first. _(Both passes.)_

**S4. Three production hub subscriptions re-derive the narrowing the typed
door already performs.** `SessionEventHub` exposes `subscribeRunFacts` /
`subscribeSessionFacts` precisely so consumers stop re-checking `event.scope`
and casting. `ProgressBackend` re-checks scope twice and casts to
`SessionRunFactEvent`; `StreamSnapshotStore` re-checks scope and carries a
four-element hand-rolled type guard the typed door makes redundant;
`goalStore` re-checks scope and type. The types are identical by construction:
`SessionRunFactEvent` _is_ what `subscribeRunFacts` yields for
`RUN_FACT_EVENT_TYPES`. ≈ −40 lines, and the store's `default: const unhandled:
never` exhaustiveness arm still compiles. The snapshot-store third was already
recorded as unfiled hardening by the 2026-08-26 round-3 survey; file this as
its extension to the other two.

**S5. A three-arm pseudo-event vocabulary switched on once, in the file that
builds it.** `CliDecisionApprovalRequest` copies the progress-view wire arm
names (`showPlanApproval`, `showAgentProposal`, `showRetryRequest`) that
nothing emits — its own docblock concedes this — and its only consumer,
`approvalAdapter.ts`, constructs it at three call sites and immediately
destructures it in a switch and an `isRetry` branch. Replace
`decideApprovalEvent(request, …)` with a `decideGated(context, hooks,
immediate, content, options)` that each of the three call sites parameterizes
directly; delete the union, `summarizeApprovalEvent`, and the file's only
`assertNever`. Prompt text, stderr lines and the `prompted` flag are
unchanged. ≈ −50 lines. Sequence against the open #11461, which would relocate
the same `immediate` policy settlement.

**S6. `onRunError`'s result argument and the finalizer's `deliver` slot have
no reader.** A failed subagent's terminal result reaches the native strategy
twice: as the return value of `executeAgent`, and as the second argument of
`onRunError(error, result)` delivered through `finalizeRunTerminal`'s
`deliver` hook, whose sole purpose is to sequence that call between settle and
untrack. Both production passers take `(err)` only; the parent-facing payload
is built later by `childRunLoop.deliverTurn`. Narrow both callbacks to
`(error) => …`, delete the `deliver` parameter and its invocation block.
≈ −25 lines. **Placement is load-bearing**: today `deliver` fires only when
`finalizeRunTerminal` wins `claimTerminalFinalize()`, so on the double-finalize
path it never runs and `lastErr` stays undefined; calling `onError`
unconditionally would make the strategy format a failure for a run whose
published `result` event is COMPLETED. Keep the call inside the claim.

**S7. `ChildRunOutcome` exists to be mapped back to the call it came from.**
`childRunLoop`'s terminal block computes the child's outcome twice from the
same three facts: the native branch calls `deriveRunOutcome` directly, while
the agent-CLI branch re-encodes them as a three-arm `ChildRunOutcome` union
that `finalizeChildStream` decodes back into exactly the same
`deriveRunOutcome` call. Two launch-failure callers pay the same encode/decode
for a bare FAILED. Pass `{ outcome: RunOutcome; error?: unknown }` across the
port and delete the union. ≈ −25 lines, one vocabulary. Make `outcome`
required rather than keeping a `COMPLETED` default whose only omitters are
four test calls.

**S8. `resumeRun` residue (batch, one PR).** (a) `ResumeRunResult` drops the
resumed turn's outcome, and the only host that needs it recovers it through an
`onResult` side-channel into a `let resumedOutcome` closure — two owners of one
fact, and the other three callers pass nothing. Carry `outcome` on the started
result and delete the callback. (b) `resumeRun.ts:149` re-exports
`lookupStreamExecutionId` purely so the runtime barrel can list it, while the
barrel already deep-exports `describeFollowUpFailure` from that same module
two lines below. (c) Two unreachable arms with a comment that misdescribes
them. ≈ −20 production lines. The recovery claim must stay before the
retrieval await — moving it re-opens the follow-up-versus-resume race D10
exists for — so use the narrowing form, not a restructure.

**S9. A test-only injection seam the design doc never specified.**
`createLatexExecutionDiscovery(dependencies)` declares a dependency interface,
a frozen default, and a defaulted parameter whose doc says it exists so the
contract "can be unit tested without scanning real execution storage". Both
production callers pass nothing; the only passer is its own suite. The
2026-08-15 latex-agent-port design specifies the function with no parameter.
Delete the seam and seed the suite from real storage, as `ExecutionListing`'s
suite does. ≈ −15 production, −100 to −173 test lines.

**S10. Four `SessionHandleInit` members nobody passes.** `followUps`,
`flushers`, `modelRetries` and `workflowControls` have zero passers in
production _and_ tests; each costs a `Partial<Pick<…>>` entry plus an
`init.x ??` arm. `DefaultSessionInit` exists only to `Omit` the never-passed
`flushers`. Delete the four members and the alias; construct those owners
unconditionally. Keep `events`, `snapshots`, `interactions` (thirteen test
passers, and the C14 test-seam species is ruled keep). The `status` seam was
already deleted on exactly this reasoning. ≈ −8 lines, −4 members, −1 alias.
_(Found by both passes; the survey's version wrongly counted `interactions`
among the dead — the census version is correct.)_

**S11. The dead relative-path fallback.**
`ToolEditApprovalController.relativeDisplayPath` wraps `WorkspaceFS.relativePath`
in a `try/catch → basename` "for a host without an initialized platform".
That throw requires an uninstalled platform; all three hosts install one
before any run, the TUI calls the same function unguarded for the same
request, and vitest installs a fake platform globally. ≈ −13 lines. Thin —
land it with the other two tool-edit-controller items.

**S12. Reveal-stream triplication.** `revealStream` is called at request
admission for six of the seven interaction kinds; tool-edit instead carries
its own copy inside `ToolEditApprovalController.publishPrompt`, and
`ExternalInquiryTool` carries a third that runs before the host's
`openExternalInquiry` reveals the same stream again. The 2026-08-03 SSOT plan
booked this deletion. Call `revealStream` in the port's tool-edit method,
delete both copies and the controller's `interactions` option. ≈ −33 lines
including tests. Two honest notes: `revealStream` emits
`requestEnsureProgressView` unconditionally, so a stream-less tool edit newly
emits it (consistent with the other six kinds); and the extension keeps a
second reveal path in `VscodeToolEditApprovalHost` that this does not touch.

**S13. The CLI's unreachable post-run category guard.** Every producer of
`executeCliConfig` passes `enforceCategory: true`, and `AgentLaunchContext`
throws _before_ the run on a category mismatch, deriving `result.category`
from that same setting afterwards — so the post-run branch that finalizes
FAILED and writes a `categoryMismatchMessage` cannot fire in production; its
only producers are two tests that mock `runAgent`. Replace it with an
invariant throw that keeps the `ExecuteAgentResultForCategory<C>` narrowing
honest, imply `enforceCategory` from `expectedCategory`, and delete the option
from four producers. ≈ −23 production, ≈ −60 test lines. **Part (b) of the
original finding is dropped**: `readCliRunOutcomeState`'s re-read is the
CLI's designed second writer, not a re-derivation.

**S14. History listing reads each row's checkpoint two to three times.**
`readCliResumeDataForListing` answers "resumable + current model" per history
row by calling `classifyRun` (lease + meta + full flow-record parse), then
`hasTerminalPersistedCompileRejection` (a second full flow-record read), then
`readMeta()` again, then `retrieveSessionResumeData`, which derives
resumability a third time. `KVStore.read` is uncached and checkpoints run to
12.8 MB. Thread the already-read facts down instead: `ResumabilityDecision`
gains the `streamId` it already parses, `classifyRun` accepts a pre-read
decision, and `retrieveSessionResumeData` accepts one. Per row: one lease
listing, one meta read, one checkpoint read. Production LoC is only ≈ −10;
**the win is I/O, not lines** — say so in the PR. Do not put the flow record
on `RunClassification`: restart repair's `pMap` would then retain every
checkpoint for the whole pass.

**S15. `TodoEntry` is a second vocabulary in a store that no longer holds
todos.** The `todos.json`/`workPlan.json` dual is resolved, but its display
type survived: `ExecutionKVStore` still exports a loosened
`{content?, status?}`, and `completedRunArchive` maps `TodoItem` onto it
field-by-field while the running branch returns `TodoItem[]` under that type.
Type the five formatter surfaces `readonly TodoItem[]`, delete the interface,
its barrel row, the mapping, the status cast and the `(no description)`
fallback. ≈ −12 lines. Batch it with closing the DUAL-3 ledger row.

### 2.3 Structural items (design-level; each deletes a real path)

**T1. `SessionStores` is built per consumer, not per session.** It carries
per-instance single-flight state (`pendingStreamDeletions`,
`streamDeletionClaims`, `pendingDeleteAll`, `deletionQueue`) that is only
correct with exactly one instance per session — and nothing enforces that.
Desktop restores the invariant _by hand_, threading one instance through five
hops (`initializeDesktopProcessStores` → `createWindow` →
`DesktopAgentExecutionOptions` → `DesktopProgressBridgeOptions` →
`ProgressBackendOptions` → `SessionState`). Memoize `createSessionStores` in a
`WeakMap<SessionHandle, SessionStores>` — the session-keyed idiom
`childRunBudgetFor` and the agent-CLI registries already use, blessed by
lifecycle step 8 — and delete all five hops. ≈ −8 net after the memo.
**Do not sell this as a bug fix**: the CLI's extra instances are alternate
modes or one-shot commands and no CLI path races today. The yield is that the
desktop invariant becomes structural instead of hand-maintained.

**T2. `stateOwnership` is a per-host flag telling shared code which host it is
on.** The startup sweep has two owners: desktop and CLI run it at session
bring-up, while the extension runs it inside `SessionState.load()` because its
presentation "is its process owner". A two-value vocabulary exists solely so
shared code can branch. Move the extension's sweep to activation, right after
`waitUntilReady()`, mirroring the CLI; then delete the option, its field, its
default, the `load()` parameter and branch, and desktop's passer. ≈ −13.
Five `state.load()` call sites in the cleanup suite pin the sweep and must
call it directly. The SDK-foundation-gap doc already lists "`stateOwnership`
symbol absent" as an acceptance target that never landed.

**T3. One bypass vocabulary spelled twice.** `APPROVAL_BYPASS_KINDS` is the
pinned wire vocabulary for `UPDATE_BYPASS`, and the CLI already stores bypass
state as a record keyed by it. The GUI path instead spells the same three
facts as `bashBypass | toolEditBypass | superYoloBypass` across four
declaration sites, and pays for the second spelling with a `switch` mapping
kind→field in `permissionSlice` and a hand-built object mapping field→kind
back in `StreamHeader` — whose only consumer already indexes by the kind. R4's
own detection rule is "a mapping table appears in the same diff". Replace the
three leaves with one `bypasses: Record<ApprovalBypassKind, boolean>`.
≈ −20. Leave `inbound.ts` alone: its two-value enum is a subset of
`PERMISSION_KIND`, not of the bypass kinds.

**T4. Tools re-spell `currentSession()`.** `currentSession()` is literally
`getRunContextSession(tryUseRunContext()) ?? defaultSession()`, and four tool
sites re-inline that body while one nests it. Two of them call
`requireInteractions(context)` first — which throws unless the context's
session exists — and _then_ resolve the session again with a
`?? defaultSession()` arm that can no longer be taken. Replace with
`currentSession()`; the two genuinely unreachable arms go. ≈ −10. One
correction to the finder: `bashApproval`'s fallback _is_ reachable (the
approval decision can return before `requireInteractions`), so it is a
re-spelling, not dead code — the replacement is still identity.

**T5. The `bare` arm of `RunContext` is a test-only seam.** `createRunContext`
has exactly one production caller, always with a `runScope`; all ~46 other
sites are under `src/test-kernel`. The union costs nine declarations plus a
`kind` dispatch, and the three production `kind === 'launch'` readers all
narrow the same direction. Verified at −33 LoC / −9 elements by the 2026-08-26
round-3 survey and **deferred by PR #11567 for test churn** — this is a
re-report, not a find. If revived, land the migration on one test-support
helper that accepts today's bare shape, and fix the desktop `doMock` that
returns an untyped literal and would fail silently.

**T6. Zero-passer optionals on the registry and handle (batch).** Seven small
seams no production caller exercises: `trackAgentExecution`'s optional status
bag, `attachToolUseFlow`'s optional signal and `detachToolUseFlow`'s optional
context, `releaseChildActivation`'s optional `expected`, a silent no-op
disposer for an unreachable duplicate reservation, two inverted option
interfaces for one boolean, and a mutable `workflowPhase` slot assigned
thirteen lines below the constructor call. ≈ −19 production LoC, −1 interface,
against ~21 test-site edits across nine files. The duplicate-reservation arm
is unreachable because every `startChildRunLoop` caller mints a fresh
execution id — _not_ because lanes serialize it, as the finder claimed.

**T7. `ExecutionRegistry.getStatus` formats a display string for one tool.**
It returns `{status, elapsed: formatDuration(...)}` typed as an intersection
that exists only because `ExecutionStatusInfo.status` admits `'unknown'`, a
value only the executions tool ever produces. Two of its three callers discard
`elapsed`. Replace with `phaseOf(handle): StreamPhase` (a rename of an
existing method, three callers) and move the display concern into
`executionFormatters`. ≈ −9. Have the formatter's builder take
`(session, handle)` to avoid a second handle lookup.

**T8. `ToolEditApprovalController.dispose` is a third cancel.** Requests are
already cancelled on both terminal paths through the session-owned port; the
controller's own `dispose()` re-runs the same cancel with a `detachCause` both
hosts set to the same constant, plus a `disposed` throw guard that serves only
it. ≈ −18. **The finder's ordering bug is refuted** — the two disposes run in
one synchronous store loop, and `ProgressViewProvider.dispose()` has no caller
in production. The honest note is the semantic shift: after the deletion the
extension's view-dispose no longer settles pending tool edits itself; they
stay parked, as on desktop, until session teardown.

**T9. `RunAgentInput.interactions` is a required SDK input that can never have
anything to cancel.** The package requires `{cancel}` from every embedder,
declares its own `HostInteractions` twins and re-exports
`PendingInteractionKind` to type it — then runs with
`approvalPromptsUnavailable: true`, refuses any approval-requiring tool, and
exposes no request method. Any request kind the attachment lacks settles at
dispatch. ≈ −29 including README and the type test. Record it as input to the
Tier-1 manifest work the 2026-08-08 checkpoint already books, not a standalone
PR; keep the deliberate `requestRetry` deny (#7331) either way.

**T10. Desktop's five inert dynamic imports.** Three main-process files
`await import()` modules their own file already statically value-imports, or
that the loaded `index.js` chunk pulls in statically — so the calls resolve an
already-evaluated module and buy a promise. ≈ −7. Keep the genuinely lazy
sites (node-pty, Sentry, LaTeX, transcript export).

**T11. Live-session sweep and hub-surface residue (reduced batch).** Delete
the `killAllSessionBackgroundProcesses` export and inline its
`forEachLiveSession` loop into the first shutdown handler; reuse the session
already resolved in `extension.ts` instead of re-resolving it three lines
later; drop `DesktopProgressIpc` (a bare alias with one importer) and the
`PendingInteractionKind` re-export (a second name for
`ProgressPermissionKind`). **Do not merge the two shutdown handlers**:
`lifecycleHost` isolates failures per registration, so one loop would let an
early throw skip the agent-CLI interrupts.

**T12. Two test-only doors into the shared applier.**
`ProgressBackend.applySessionFact` / `applyRunFact` are pass-throughs
self-described as "tests / rare host seeds" with zero production callers and
seven test sites; the 2026-08-14 verifier already approved deleting exactly
these two while keeping `applyStreamStatus`. Honest accounting is thinner than
it looks: neither recording-backend factory calls `setupEventListeners()`, so
each site needs that call — ≈ −5 to −8 net. _(Found by both passes.)_

**T13. `SessionStores` claim map keyed by an incarnation nobody reads.**
`streamDeletionClaims` is a `Map<stream, Map<incarnation, Set<symbol>>>` whose
sole reader checks only `.get(stream)?.size` and whose own comment says the
incarnation is deliberately not consulted. Flatten it and drop the parameter.
≈ −7, one call site. **The sibling proposal is refuted**: the two
`SessionStores` injection options have 21 test passers acting as assertion
oracles and one as an ordering gate, for ≈ −12 production lines; if ever
pursued it belongs with the #11323 bulk-deletion rework.

### 2.4 Ledger hygiene — dated rows, not deletions

**L1. The `taskRuns` absolute-path arm needs a ruling.**
`runStorageLocationFromAnyAbsolutePath` still tries a second root, citing a
retention policy on a ledger issue that closed with no such row; the directory
probe it served is gone. This is not an expired dated row — it is an _undated
conditional keep_, ruled in #9430 item 5 and executed by #9623, whose tracker
then closed without recording it, and which #10887 kept on that non-existent
premise. Two honest complications: the last writer was replaced long enough
ago that the three-month rule has passed on any reading, but the arm matches
only paths under the _current_ storage root, and the extension's root moved to
`~/.texra` — so the population it protects is largely unreachable anyway.
Either delete it (≈ −30) or stamp a date beside it; today it is neither. The
SQLite PRD cites the same phantom row and must be edited with it.

**L2. The lease compatibility shim is half-dated.** The v2 shadow _writer_
carries "Retire after 2026-11-24, deleting this function and its caller
together". The _reader_ half — the legacy schema, path, record reader, the
shadow merge in `readClaims`, the legacy unlink, and `StoredClaim.files` —
carries no date and is not named in that deletion unit, so a deleter following
the comment on the day removes the writer and leaves ~140 lines of reader
behind. Do now: record the same date on the reader half and list it in the
writer's unit; correct the writer's dangling ledger citation (both issues it
names are closed) and the superseded trigger in the 2026-08-23 doc. On the
date: ≈ −270 including tests.

**L3. Orphaned comments and pins from already-retired arms (batch).** Two are
actively misleading: `stream.ts` describes an "idempotent entrance stamper"
that brings old rows forward on disk — no such code exists, and #11337 was
resolved by _accepting_ the compatibility break (its PR #11720 closed
unmerged) — and `SessionState.ts` says legacy workflow instructions are
"backfilled during load", a backfill deleted by #9605. The rest are stale
`runDescriptor` and `conversation.json`/`todos.json` references and one
retired-format test pin. ≈ −16 to −20. **Two sub-items are refuted**: the
usage-accumulator rejection test pins a documented loud-failure guarantee, and
the workspace-files test asserts live allowlist behavior — rename, don't
delete.

**L4. The abandoned-slot probe is undated.** The 2026-08-15 toggle-store
ruling _is_ executed — both toggles live in `globalState` and the worktree
store no longer routes them — but each runtime reader still probes the retired
`workspaceState` slot once per process to warn. Under the current retirement
policy that reader needs a date at its declaration, in the form
`resultMeta.ts` already uses. Net today is 0; at retirement ≈ −43. Also
correct the lifecycle doc, which still calls the move unexecuted.

## 3. The dual-system ledger, re-verified at HEAD

Each row of the 2026-07-09 census (Part D) and the R1 accounting table,
re-checked in code rather than in the docs.

| Row                                           | Status at `a78a896`                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DUAL-1 `STREAM_STATUS` vs `StreamPhase`       | **Partially resolved.** Traits and converters gone. Seven production read sites remain; one is the permanent trace-import boundary, one is the unreachable wire arm (S3), and the rest are the `READY` sentinel spelled through the retired enum. |
| DUAL-2 `RunDescriptor` projection             | **Resolved** — zero production hits; a stale comment and one test pin remain (L3).                                                                                                                                                                |
| DUAL-3 `todos.json` vs `workPlan.json`        | **Resolved** — no todos KV key, no mtime arbitration. Residue: the `TodoEntry` display type (S15).                                                                                                                                                |
| DUAL-4 `conversation.json` dual write         | **Resolved** — zero hits; the archive reconstructs from the stream log.                                                                                                                                                                           |
| DUAL-5 `defaultSession()` alias vs singletons | **Resolved as a dual** — no module-level session-scoped singleton survives; the alias itself is live by ruling. Residue: the re-spellings in T4.                                                                                                  |
| DUAL-6 legacy status decode arms              | **Resolved except the fenced arm** — `streamRestoration.ts` is gone, `meta.taskState` is gone, the display half decodes only `READY`.                                                                                                             |
| DUAL-7 CLI final-result projection            | **Resolved** (#9517).                                                                                                                                                                                                                             |
| DUAL-9 `ApprovalRequestHandler` replay        | **Ruled won't-do** (A16) — not re-examined.                                                                                                                                                                                                       |
| DUAL-10 `RESTART_REPAIR_PHASES` duplicate     | **Resolved** — zero hits.                                                                                                                                                                                                                         |
| DUAL-11 headless vs TUI projection            | **Live, ruled legitimate fan-out** — both subscribe the same hub through the typed doors.                                                                                                                                                         |
| A5 `AgentRuntimeHost.interactions`            | **Resolved** — `AgentRuntimeHost` has zero hits in `src/` and `packages/`.                                                                                                                                                                        |
| A6 phantom emit arms                          | **Resolved** — all five current presentation arms have production producers.                                                                                                                                                                      |
| B2 bag↔`RunContext` fields                    | **Partially** — the launch arm carries `runScope`; the `bare` arm still re-declares five fields (T5).                                                                                                                                             |
| B3 `TaskState` derived shape                  | **Live, fenced** — one consumer, the frozen CLI NDJSON wire.                                                                                                                                                                                      |
| B10 `executions/` + `taskRuns/`               | **Partially** — the directory probe is gone; the absolute-path arm survives undated (L1).                                                                                                                                                         |
| B12 half-registered execution                 | **Improved, live** — now `allSettled` + aggregate + lease release, but the three writes stay concurrent and `meta.json` is not written last.                                                                                                      |
| D2 one outcome, three carriers                | **Resolved** — the flow-error wrap chain has zero hits. Successor residue: S6, S7, S8(a).                                                                                                                                                         |

Retirement-ledger rows, same treatment: the legacy workspace-snapshot and
usage-accumulator readers, the Copilot model-id cohort, the pre-refactor
`.tex` resume probe, the text-only queue drain, the `rN` stage inference and
the former banner-setting reads are all **already gone**. Still live and not
yet due: the onboarding backfill, the icon-prefix strip, the team-roster
fallback, the delivery-tag envelope, the lease shadow writer, and the
result-meta error-shape reader. One row **conflicts with a permanence
comment**: the legacy `EndGroupStatus` projection is dated 2026-10-31 by the
ledger while `log.ts` and `taskGroup.ts` declare it a permanent trace-viewer
boundary — and in-app it is unreachable, because the store normalizes at read.
That needs a ruling before the date, not a deletion.

## 4. Refuted with evidence (do not refile)

Thirteen candidates died on a high-confidence refutation. The load-bearing
ones, so the next sweep stops re-finding them:

- **Turn attribution is not a duplicate write.** `turn-state.json`'s
  `lastCompletedTurn` is the durable witness read _precisely when_
  `result-meta.json` is absent or unparseable; the proposed replacement reads
  a field that is null in exactly that branch.
- **The parent-side child record is not collapsible.** The orphan bug is real,
  but deriving children from `listExecutions()` trades an O(children) prefix
  read for an O(all executions) scan on the orchestrator's polling path.
- **The resume path's triple `meta.json` read was adjudicated on 2026-08-25**
  and declined; nothing has changed.
- **The goal-forget suffix path is not name resemblance** — `#executionId` is
  the minting formula, so the derivation is its exact inverse.
- **`contextState`, `runStartedAt` on the status wire, and the CLI's second
  tombstone** each turned out to be two rails answering different questions
  (durable versus ephemeral), which the hosts-as-renderers fence row
  explicitly protects.
- **The launch-time compatibility-key read** and **the two GUI resume
  wrappers** both survive re-reading: the first has a resume path that does
  need it, the second differs in a guard one host has and the other lacks —
  folding them is a feature decision.
- **`DiffViewHost`'s VS Code-only methods** stay: `src/hosts` is the injected-port
  home by the 2026-08-26 ruling.
- **The registry's two listener rails** stay: the private keyed rail's extra
  wakes are load-bearing for the executions `wait` action, and no fold nets a
  deletion without widening the public channel's contract.

## 5. Healthy — do not re-flag

Inspected and judged sound, with the reason:

- **`SessionHandle` as a composition record** — forced dependency-order
  construction, the single-flight `waitUntilReady` memo with abort
  checkpoints, and the restart-repair classification path (irreducibility
  register). The lifecycle doc's stale "process-output poller" comment is gone.
- **`SessionHandle.releaseExecutionLease`** — validate → drain → post-drain →
  release, drain error wins. Lease fencing; keep.
- **`flushArtifacts`** — the `pDefer` single-flight coalesces N burst callers
  into at most two flushes, which `p-queue` does not provide. Not a
  hand-rolled-builtin candidate.
- **`settleLiveSessionExecutions`** — one consumer, but it is the ON-phase
  drain with first-terminal-outcome protection.
- **`StreamStatusMachine`** — every method has a production consumer; the
  reservation-as-entry design and write-before-publish rule are sound.
- **The `@agent/runtime` barrel** — all 60 exports have a host consumer;
  "derived from use" holds and no baseline row can shrink there.
- **`ExecutionInteractionOwnership`**, the follow-up generation fencing, the
  transcript per-key queues, restart-repair core, the double-finalize dance —
  all in the irreducibility register, all still earning it.
- **Per-host interaction registries**, the NDJSON projection, the trace-viewer
  compat readers, and the durable-rail/ephemeral-rail split — fence rows,
  unchanged.

## 6. Verified

Files opened first-hand while checking the survey's own output, beyond the
readers' and verifiers' work: `SessionHandle.ts` (constructor, `onResult`,
`publishRunEvent`, live-session registry), `SessionEventHub.ts`,
`StreamSnapshotStore.attachSessionEvents`, `terminalResultToast.ts`,
`detachSubagentsOnStop.ts`, `ExecutionsTool.handleKill`,
`platformSettings.ts`, `createSessionStores.ts`,
`executionRegistry.detachActiveChildren`, `stream.ts`,
`projectionShape.ts`, `streamState.ts`, `permissionSlice.ts`,
`StreamHeader.ts`, `ProgressBackend.setupEventListeners`, `goalStore.ts`,
`executionLease.ts`, `runStorageFs.ts`, `log.ts`, `taskGroup.ts`,
`StreamLogStore.normalizeGroupStatusEntry`, `agentRegistry.clearInlineAgents`,
`onboardingState.ts`, `agentPresets.ts`, and the four ratchet baselines.

Checks run for this docs-only change: `npx prettier --check` on the new file,
`node scripts/check-guidance-refs.mjs`, `node docs/scripts/check-root-docs.mjs`,
and `git diff --check`.
