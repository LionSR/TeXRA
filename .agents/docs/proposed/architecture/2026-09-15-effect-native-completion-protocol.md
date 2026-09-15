---
created: 2026-09-15
status: proposed
---

# TeXRA 1.0: protocol for completing Effect-native execution

## 1. Scope and conclusion

This protocol concerns the remaining Effect conversion on the TeXRA 1.0
development branch. It is an implementation proposal under the accepted
[repository policy](../../../../AGENTS.md#texra-10-direction), not a declaration
that the conversion or release is complete.

The source baseline is GitHub `main` at
`2c9898445d809b98b038ca9b133b16b57ef7794a`, inspected on 2026-09-15.
The manifests pin Effect to `4.0.0-rc.115`. Issue discussions supply decisions
and reported defects; source inspection determines what has actually landed.
An open pull request is not counted as completed work.

**The main remaining task is to give every operation an explicit project,
session, and resource lifetime, and then preserve that ownership through its
entire execution.** Two related obstacles remain:

1. An Effect program can still obtain configuration, paths, or a session from
   JavaScript async-local state. That state need not follow an Effect fiber
   when another fiber wakes it.
2. An Effect program can still call an internal Promise interface which runs
   another Effect through a supplied host runner. Moving the runner out of
   the shared module does not establish direct composition.

Consequently, neither the number of Effect imports nor a zero execution count
in the migration check is a sufficient completion criterion.

This document supplies a current work order and acceptance criteria. Earlier
audits remain historical evidence. Their old counts, removed-file inventories,
and superseded deferrals must not be used as current implementation orders.

## 2. Established work and remaining evidence

The old flow engine and model-handler hierarchy are retired. The production
loops use the ledger and the native model contract; built-in tool executors
return Effects. The run file lease and `hostPort` have been deleted. `Runs`
is already a session service. These components are the starting point, not
replacement targets.

Running `node scripts/check-effect-migration-ratchet.mjs` against the pinned
source passed over **1,413 production files**:

| Survey category                             | Files | Sites |
| ------------------------------------------- | ----: | ----: |
| `platform()`                                |    10 |    27 |
| `effectRuntime()`                           |     0 |     0 |
| Surveyed async-local operations and readers |    20 |    30 |
| `new AbortController()`                     |     4 |     4 |
| `p-queue` imports                           |     0 |     0 |
| `p-defer` imports                           |     0 |     0 |
| `async-mutex` imports                       |     1 |     1 |
| Non-exempt `Effect.run*` calls              |     0 |     0 |
| Raw catches in runtime Effect importers     |     4 |     5 |

The rows overlap. The survey excludes tests and several script directories;
it also excludes the established host and SDK boundary kinds. Shared getters
can conceal many callers behind one counted ambient read. These are retirement
inventories, not percentages of completion or measurements of performance.

### Current distinctions that affect the work order

| Area               | Merged state                                                                                       | Remaining requirement                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem         | Effect `FileSystem`/`Path` and rooted session views exist; several consumer groups have converted. | Convert remaining consumers, preserve symlink-sensitive operations, then delete statics, the old port, and ambient roots.                           |
| Session execution  | `Runs` has one session owner.                                                                      | Complete `Requests`, SDK consumption, and removal of independent process-wide session/request registries.                                           |
| Host contracts     | `hostPort` is deleted; preparatory catch conversions have landed.                                  | Convert remaining internal settings, account, and request operations through their callers to genuine external boundaries.                          |
| Store construction | `Secrets` and `AppState` still accept deferred store getters on the pinned main.                   | PR [#12553](https://github.com/LionSR/TeXRA/pull/12553) opens stores before installing their runtime and supplies values; it is open at this audit. |
| Verification       | Existing behavioral suites and architecture checks cover substantial parts of the runtime.         | Reconcile crash-recovery claims with shipped records; verify remaining ownership and release defects; obtain valid performance measurements.        |

The filesystem decision is settled: adopt Effect's facilities, retaining
small helpers only for concrete missing semantics. The September 11 deferral
was superseded on September 13. The session-service decision is also settled:
`Runs` and `Requests` proceed without waiting for the old injection Q3.
See the [rulings ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md#r-1--q1--the-filesystem-effects-own-filesystempath-ruled-2026-09-13-supersedes-the-2026-09-11-deferral)
and the [session-service ruling](https://github.com/LionSR/TeXRA/issues/12425#issuecomment-5659705569).

## 3. Definition of completion

For each converted operation, the reviewer must be able to answer:

1. **Dependencies:** Which project, session, run, and call provide its data and
   capabilities? No required dependency silently falls back to another project
   or to the process session.
2. **Execution:** Which external entry executes the Effect? Internal callers
   compose the program directly. A callback receives an explicitly owned
   admission function only where the external API requires a callback.
3. **Lifetime:** Which scope owns each child operation, listener, stream,
   process, and temporary resource? Teardown joins required work before
   releasing resources that work can still access.
4. **Failure:** Which failures are expected domain results, which are defects,
   and how does interruption propagate? A catch must not turn interruption
   into success or an ordinary failure notification.
5. **Durability:** What is committed before an external side effect, and what
   may be retried after a crash? Effect scope does not itself provide crash
   recovery or exactly-once external effects.

Pure computation remains ordinary TypeScript. Genuine foreign Promise APIs
remain adapted once at their boundary. That adapter must describe whether
the foreign operation can be cancelled and who waits for its final completion.
It must not imply cancellation where the underlying API offers none.

No step introduces compatibility readers, dual execution paths, another
session registry, or a temporary Promise facade. Existing user data remains
untouched. Deliberate configuration files and protected credential storage
are not automatically converted to SQLite merely because they use JSON.

## 4. Work packages and dependency order

### A. Remove ambient project dependencies from running operations

**Existing trackers:** [#12421](https://github.com/LionSR/TeXRA/issues/12421),
[#12433](https://github.com/LionSR/TeXRA/issues/12433).

Start with run-reachable readers. `run/modelBinding.ts` still reads model
options through `getConfig`; `debugMessageSaver.ts` reads configuration and
uses filesystem statics; `RunSubscriptionRegistry.bind` still resolves
`currentSession()`. Retry configuration in `ModelInvoker`, compaction, and
approval helpers belong in this inventory too. The reported contention failure explains why these reads
are consequential, rather than merely stylistic.

Provide project configuration and rooted filesystem values when acquiring the
session or run. Read changing configuration from the explicitly selected
provider; do not accidentally change live-read semantics into a launch-time
snapshot. Supply the owning session to callbacks that outlive their caller.
Convert the remaining LaTeX, utility, tool, controller, and host consumers
against the existing services.

Preserve symlink identity, typed directory entries, publication and atomic-write
semantics where the operation requires them. A rooted path resolver does not
by itself prove containment through symlinks or safety against a concurrently
replaced directory. The final generated-file deletion contract remains part
of [#12139](https://github.com/LionSR/TeXRA/issues/12139).

**Acceptance:** two sessions with different roots and settings retain their
own values after a deliberately contended commit and through subsequent
model, file, and follow-up operations. No run-reachable required dependency
uses ambient fallback. The final endpoint includes session-sensitive host
operations and external callbacks, not just agent runs. Delete the obsolete statics and root carrier only
after their last real consumers are converted; remove their dedicated tests
with them.

Deleting the old `FileSystemProvider`/`BaseFS` abstraction does not prohibit
direct Node operations inside a justified platform implementation or a
necessarily synchronous host entry. Such operations still need explicit
roots and the required failure and resource semantics. They are not a reason
to retain the obsolete ambient filesystem interface.

### B. Complete session-owned requests and SDK operations

**Existing tracker:** [#12425](https://github.com/LionSR/TeXRA/issues/12425).

Retain the landed `Runs` service. Put request admission, waiting, approval
coordination, and decision serialization under the session's `Requests`
service. `SessionRequests.ts` still has module-level `decisionLanes`;
`SessionHandle.ts` still maintains `liveSessions`. Approval state is already
partly session-owned, and each session already has a request handler. This
step changes ownership and access to that implementation, not the existence
of request handling. Do not create a duplicate owner while converting access.

The SDK should reach these same services. The host's session map is the
authority for enumeration and disposal. Run-owned capabilities remain inside
`AgentRun` unless independent acquisition, lifetime, or substitution justifies
a separate service.

Move only the coordination that requests own. The database and existing
committed-event path remain the durable authority for decisions; `Requests`
must not introduce another decision record or compete with the run's own
waiting lifecycle.

**Acceptance:** decisions and waiting callers belong to the same session;
one session's teardown cannot affect another's requests. Required request
settlement and child drain precede storage release. The independent registries
and obsolete entry paths are removed in the same change.

A and B can proceed concurrently in disjoint files. Coordinate explicitly
before either changes `SessionHandle`, `sessionLayer`, launch code, or SDK
composition; independent edits to those shared files are not independent work.

### C. Finish direct internal host and settings contracts

**Existing tracker:** [#12424](https://github.com/LionSR/TeXRA/issues/12424).

First resolve the in-flight store-construction change in #12553 against its
actual reviewed result. This removes deferred construction; it does not finish
Effect-typing `StateStore` or configuration writes.

For this construction change, verify that each root opens its intended stores
once and provides those exact values. Any bare bootstrap execution must be
enumerated at the root and provide all of the opener's requirements before a
process runtime exists. No opener may invoke a captured write runner before
runtime installation. Production store thunks and the CLI state latch must
disappear. This is a narrowly justified bootstrap boundary, not permission
for a second internal execution system.

Next convert each remaining operation together with its callers and host
implementations. Prioritize settings writes and run/request operations, then
account and presentation operations by their dependency graph. Preserve
configuration precedence, write targets, credential protection, and the
existing commit regions that must not be interrupted halfway through.

The concrete counterexample to counting only execution sites is
`JsonStore.update`: it delegates its Effect `set` operation to `RunStateWrite`.
`SqliteStateStore.update` likewise delegates to an injected write runner.
Meanwhile `settingsAccess.writeSlot` normalizes Promise-shaped configuration
and state writes with `Promise.resolve`. The internal write should become a
directly composed Effect; only the actual foreign host API needs a Promise
adapter. Remove `RunStateWrite` and other obsolete forwarding machinery when
their last legitimate uses disappear, rather than retaining them as the final
internal contract.

Use the existing settings decomposition: make `JsonConfigProvider` compose the
store's Effect write, convert `ConfigProvider` with its complete consumer
group, then convert the state-store group and the actual VS Code `Memento`
adapter. Overlapping callers may require one combined change; do not preserve
a dual interface solely to make smaller commits. Account/OAuth, message
presentation, run-action prompts, `runAgentRequest`, and external opening are
separate caller groups. Pasted-image cleanup depends on the corresponding
rooted filesystem operation. Recount each group from source before assigning
work; historical file counts are not a complete change list.

`SetupPlatform.layer` already accepts a value, but `signIn` remains a Promise
contract. It belongs with account/OAuth conversion, independently of #12553.
`PromptHost` is already Effect-typed; `MessageHost` is not. Preserve the
difference between a notification and a prompt awaiting a choice, including
dismissal behavior. Convert `runAgentRequest` with its session-owned admission
and settlement path. A genuinely non-cancellable shell opening remains so;
the internal `ExternalOpener` contract need not remain Promise-shaped for that
reason.

Finally inspect the remaining internal collaborators reached by the native
loops: model-configuration resolution, prompt preparation, goal continuation,
reflection output, and usage recording. For example, `toolUse.ts` still wraps
`resolveRuntimeModelConfig`, `buildInitialToolUsePrompts`, `recordUsage`, and
`maybeBuildGoalContinuation` in `Effect.tryPromise`; reflection has corresponding
calls and a Promise-based raw-output writer. Trace each to its implementation.
Keep synchronous work synchronous, make internal I/O compose directly, and
retain an adapter only where a real foreign API is reached. A native outer
loop is not evidence that all of its collaborators are native. Use the
existing [model execution](https://github.com/LionSR/TeXRA/issues/12070) and
[usage pipeline](https://github.com/LionSR/TeXRA/issues/12076) trackers for
their remaining requirements.

**Acceptance:** an internal settings write has one execution owner from the
caller through persistence and required post-write effects. A converted
operation is not executed by an injected runner hidden behind its old Promise
signature. Host callbacks still settle the UI operation once, with interruption
and failure represented correctly.

### D. Finish resource and concurrency ownership

Inspect the remaining `AbortController` residents and `KeyedMutex` consumers
individually. Count reductions are evidence only when the replacement owns
the same behavior. A foreign SDK cancellation signal may be necessary; a
second internal cancellation tree is not the intended endpoint.

For each detached fiber, identify its owner and termination condition. Preserve
the distinction between an in-band child that stops with its parent and a child
deliberately admitted to a longer-lived session. Queued work, preview builds,
provider requests, and subprocess descendants must finish or be terminated
before dependent temporary files or handles are released.

**Acceptance:** stopping or closing the owner leaves no admitted work using a
released resource. Expected per-tool failures preserve the dispatcher's
ordering and continuation policy; interruption remains interruption. Do not
introduce retries for mutating tools as part of the conversion.

This work can run alongside A–C where files and resource owners are disjoint.

## 5. Verification protocol

### Conversion checks

Before changing a Promise signature, enumerate its implementations, callers,
callbacks, and Promise-normalization sites. After the change, inspect every
`await`, `.then`, `.catch`, `Promise.resolve`, and Promise-returning wrapper
that consumes the converted member.

Issue [#12491](https://github.com/LionSR/TeXRA/issues/12491) records that the
current type setup can accept an unexecuted Effect where a Promise was
expected. Typechecking alone is therefore insufficient. A targeted diagnostic
should reject this misuse; until it exists, record the caller audit and run
the affected behavioral suites. Do not impose a blanket ban on external
Promises or `Effect.tryPromise`.

### Behavioral evidence

Use existing suites and the narrowest boundary that exposes a consequential
defect. A behavior-preserving refactor adds no tests merely to demonstrate
activity. For changed ownership or recovery behavior, concentrate on:

- project isolation across contended commits and resumed operations;
- request isolation and settlement during session shutdown;
- interruption while queued or while a foreign operation is still active;
- resource release after the last permitted user has finished;
- durable recovery where a crash could repeat paid work or lose a result.

Use `it.effect` and Effect's test clock for simulated time and in-memory
programs. Use `it.live` for actual SQLite, filesystem, process, or provider I/O.
Provide scoped layers; retire obsolete module mocks and fixtures with the
implementation they existed to preserve.

### Recovery and performance evidence

Reconcile [#12427](https://github.com/LionSR/TeXRA/issues/12427) with the records
that actually shipped before selecting crash tests. In particular, its older
table predates the landed follow-up rows. For every consequential uncertain
external outcome, state whether recovery resumes, retries under a fresh
attempt, or refuses to guess. Do not test record names from an unimplemented
proposal as though they were the durable contract.

One concrete design difference needs resolution. The reflection loop commits
a `flow.snapshot` whose phase is `output.pending`, then resumes by running
`produceOutput`. Its separate raw-output writer uses `rawOutputBytes` and
file length to avoid a repeated append or rewrite from the recorded offset.
This is not the design's proposed `output.pending` record with a content
digest. Equal file length alone does not verify matching content. Specify
the intended treatment of complete, partial, and conflicting output, then
verify it across a process reopen in the existing reflection suite. Retain
the useful existing offset handling; do not describe it as absent or require
a new record format merely to reproduce the old proposal. A change to the
durable shape must follow the repository's session-format version rule.

Test-suite housekeeping, such as the four follow-ups in
[#12528](https://github.com/LionSR/TeXRA/issues/12528), should be completed on
its own merits. It is not a reason to rewrite every suite or a substitute for
the ownership and recovery evidence above.

Measure cold open, live idle and replay memory, commit latency under
contention, two-project operation, and stop latency with controlled non-zero
work. Keep the database open while measuring idle memory; measure replay
paths separately; distinguish bytes written from retained file size; count
missed event-loop deadlines. Record the machine, dataset, revision, units,
method, readings, and proposed numeric budgets. No performance improvement
or satisfied budget is claimed without those readings.

## 6. Change and completion records

At the start of each implementation change, refresh main, open pull requests,
their complete changed-file lists, and relevant owner decisions. Record:

1. the source revision and existing tracker;
2. the operation and its final owner;
3. the complete caller/implementation scope and any overlapping active work;
4. the mechanism and dedicated tests that will be deleted;
5. the consequential behavior to preserve and how it will be checked.

Build complete changes that remain useful in 1.0. Use the pinned library's
actual declarations and implementation when selecting facilities. Do not
write custom scheduling, locking, lifecycle, or persistence machinery where
the supported stack already supplies the required behavior.

Before committing, follow the repository's formatting, full typecheck,
compilation, lint, and affected-test requirements. Run the pure tier before
pushing and the full suite before opening a pull request. The migration check
must pass without added allowance or stale headroom. Review the final caller
graph as well as the counters.

Completion requires all of the following:

- A–D satisfy their ownership and direct-composition criteria.
- Remaining external adapters have an identified foreign API and lifetime.
- Required project/session context has no ambient fallback.
- Retired internal interfaces, registries, and their dedicated tests are gone.
- Consequential interruption and recovery requirements have behavioral evidence.
- Performance readings and explicit budgets are recorded, or the performance
  requirement is explicitly revised before completion is claimed.

Close a tracker only against its remaining requirements, not merely because a
related pull request merged. Keep implementation completion, verification
completion, and the wider TeXRA 1.0 release decision distinct.

## 7. Source evidence

These links fix the source revision, so later line movements do not change the
evidence on which the protocol was based.

| Finding                                                     | Source at the audited revision                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambient configuration comes from selected workspace roots   | [`configUtils.ts:28`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/utils/config/configUtils.ts#L28)                                                                                                                                                           |
| Model configuration still reads that ambient source         | [`modelBinding.ts:335`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/run/modelBinding.ts#L335)                                                                                                                                                  |
| GitHub subscription binding resolves a session at call time | [`RunSubscriptionRegistry.ts:106`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/tools/github/RunSubscriptionRegistry.ts#L106)                                                                                                                                 |
| Request decision lanes are module state                     | [`SessionRequests.ts:69`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/controllers/session/SessionRequests.ts#L69)                                                                                                                                            |
| Global live-session enumeration remains                     | [`SessionHandle.ts:1273`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/SessionHandle.ts#L1273)                                                                                                                                                  |
| Configuration and state writes retain Promise contracts     | [`interfaces.ts:64`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/platform/interfaces.ts#L64), [`interfaces.ts:94`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/platform/interfaces.ts#L94)                             |
| JSON and SQLite writes enter an injected runner             | [`jsonStore.ts:273`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/platform/defaults/jsonStore.ts#L273), [`appStateStore.ts:107`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/controllers/session/appStateStore.ts#L107) |
| Settings normalize writes with `Promise.resolve`            | [`settingsAccess.ts:109`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/shared/config/settingsAccess.ts#L109)                                                                                                                                                  |
| Session publication settlement is already an Effect         | [`SessionHandle.ts:1076`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/SessionHandle.ts#L1076)                                                                                                                                                  |
| Retry tests already use Effect's test clock                 | [`ModelRetryGate.vitest.ts:83`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/test-kernel/agent/runtime/ModelRetryGate.vitest.ts#L83)                                                                                                                          |

The remaining loop collaborators are visible in
[`toolUse.ts:261`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/loop/toolUse.ts#L261)
and [`toolUse.ts:659`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/loop/toolUse.ts#L659).
The reflection recovery comparison rests on the offset-and-length writer at
[`reflection.ts:575`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/loop/reflection.ts#L575)
and the later pending phase at
[`reflection.ts:790`](https://github.com/LionSR/TeXRA/blob/2c9898445d809b98b038ca9b133b16b57ef7794a/src/agent/runtime/loop/reflection.ts#L790).

## 8. Audit method and limits

The audit used a fetched, isolated archive of the pinned main revision, source
inspection, live GitHub issue and pull-request records, and the repository's
binding-aware migration check. Parallel audits examined session/runtime
ownership, host contracts, and verification coverage. The original checkout
and its pre-existing untracked files were left intact.

This is a source-based protocol draft. It does not claim that the complete
test suite, real desktop contention scenario, crash experiments, or performance
measurements were run during this assessment. Those are execution requirements
for the corresponding changes, not evidence supplied by this document.
