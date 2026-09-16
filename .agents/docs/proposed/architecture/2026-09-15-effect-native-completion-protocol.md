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
`697663eff19ab67384b65a33a79d06507531431b`, re-pinned on 2026-09-15 after the
roughly thirty pull requests that landed later that day; the first audit was
pinned at `2c9898445d809b98b038ca9b133b16b57ef7794a`, and every finding below
was re-verified against the new baseline. The manifests pin Effect to
`4.0.0-rc.115`. Issue discussions supply decisions
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

The second obstacle has narrowed sharply since the first audit: the
configuration and state write contracts, the store construction order, the
message-notification host, and the session request registry are all converted.
What remains of it is the account/OAuth group and the host run-launch port.
The first obstacle is now the larger half of the work.

Consequently, neither the number of Effect imports nor a zero execution count
in the migration check is a sufficient completion criterion.

This document supplies a current work order and acceptance criteria. Earlier
audits remain historical evidence. Their old counts, removed-file inventories,
and superseded deferrals must not be used as current implementation orders.

## 2. Established work and remaining evidence

The old flow engine and model-handler hierarchy are retired. The production
loops use the ledger and the native model contract; built-in tool executors
return Effects. The run file lease and `hostPort` have been deleted. `Runs`
is already a session service, and since the first audit `Requests` is one too
(#12577). These components are the starting point, not
replacement targets.

Running `node scripts/check-effect-migration-ratchet.mjs` against the pinned
source passed over **1,410 production files**:

| Survey category                             | Files | Sites |
| ------------------------------------------- | ----: | ----: |
| `platform()`                                |     9 |    19 |
| `effectRuntime()`                           |     0 |     0 |
| Surveyed async-local operations and readers |    19 |    29 |
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

| Area               | Merged state                                                                                                                                                                                     | Remaining requirement                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem         | Effect `FileSystem`/`Path` and rooted session views exist; the tool layer (#12573, #12617), host callers (#12575), the reflection pipeline (#12619), and the core lane (#12621) have converted.  | Convert remaining consumers, preserve symlink-sensitive operations, then delete statics, the old port, and ambient roots.                    |
| Session execution  | `Runs` has one session owner; `Requests` is now a session service built by the session layer (#12577), with per-session decision lanes and no global live-session registry.                      | Complete SDK consumption and remove the ambient session fallback (`currentSession`/`defaultSession`).                                        |
| Host contracts     | `hostPort` is deleted; configuration and state writes (#12615, #12624), `MessageHost` (#12584), `ExternalOpener` (#12560), and the agent-directory/agent-resume ports (#12628) are Effect-typed. | Convert the remaining account/OAuth and run-launch operations through their callers to genuine external boundaries.                          |
| Store construction | Landed (#12553): every root opens its stores before installing its runtime, and the `Secrets` and `AppState` layers take values.                                                                 | None here; the write-contract conversion it enabled is package C.                                                                            |
| Verification       | Existing behavioral suites and architecture checks cover substantial parts of the runtime; the contended-commit recovery pins have landed (#12578).                                              | Reconcile crash-recovery claims with shipped records; verify remaining ownership and release defects; obtain valid performance measurements. |

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
options through `getConfig` (:335, :380, :469, :684); `ModelInvoker`'s
automatic-attempt limit still reads `getValidatedConfig` at invoke time (:149);
compaction still reads its threshold the same way (`run/compaction.ts:119`).
`debugMessageSaver.ts` has moved to `src/agent/debug/` and now takes the
process filesystem from context and the run's roots as data, but it still
gates on an ambient `getConfig` read (:66). `RunSubscriptionRegistry.bind`
still resolves `currentSession()` (:106). Approval helpers belong in this
inventory too. The reported contention failure explains why these reads
are consequential, rather than merely stylistic.

Provide project configuration and rooted filesystem values when acquiring the
session or run. Read changing configuration from the explicitly selected
provider; do not accidentally change live-read semantics into a launch-time
snapshot. Supply the owning session to callbacks that outlive their caller.
Convert the remaining LaTeX, utility, tool, controller, and host consumers
against the existing services; the tool layer, host callers, the reflection
pipeline, and the core lane have already converted (#12573, #12575, #12617,
#12619, #12621), so the remaining consumers convert against established
services rather than new ones.

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

Retain the landed `Runs` and `Requests` services. The first ownership step
has landed: #12577 made the approval queues and the request protocol the
session's `Requests` service, built by the session layer; the decision lanes
are one map per session held in that service's closure, and the global
`liveSessions` enumeration is gone. What remains is consumption and the
ambient fallback: run-scoped code still resolves its session through
`currentSession()` / `defaultSession()` (`SessionHandle.ts:1500`), which falls
back to the process session when no run context is present, and the SDK must
reach these same services rather than a parallel path. Do not create a
duplicate owner while converting access.

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
and obsolete entry paths — including the ambient session fallback — are
removed in the same change.

A and B can proceed concurrently in disjoint files. Coordinate explicitly
before either changes `SessionHandle`, `sessionLayer`, launch code, or SDK
composition; independent edits to those shared files are not independent work.

### C. Finish direct internal host and settings contracts

**Existing tracker:** [#12424](https://github.com/LionSR/TeXRA/issues/12424).

The store-construction change has landed: #12553 made every root open its
stores before installing its runtime, and the `Secrets` and `AppState` layers
take values, so deferred construction is gone. The bootstrap boundary it
established is narrow — a root's opener runs on a bootstrap fiber providing
all of the opener's requirements before a process runtime exists — and is not
permission for a second internal execution system.

The counterexamples the first audit named are converted end to end.
`ConfigProvider.update` is `Effect.Effect<void, ConfigWriteFailed>`
(`interfaces.ts`) via #12615; `StateStore.update` is
`Effect.Effect<void, StateWriteFailed>` via #12624; `JsonStore.update`
composes the store's own Effect `set`; `SqliteStateStore.update`
(`appStateStore.ts`) composes `set` directly with no injected write runner;
`settingsAccess.writeSlot` composes the stores' Effect writes with no
`Promise.resolve` normalization; `RunStateWrite` is deleted. The settings
decomposition sequence — `JsonConfigProvider`, then `ConfigProvider` with its
consumer group, then the state-store group — has run its course.

Convert each remaining operation together with its callers and host
implementations. Preserve configuration precedence, write targets, credential
protection, and the existing commit regions that must not be interrupted
halfway through.

The remaining caller groups are account/OAuth, run-action prompts, and run
launch. `SetupPlatform.layer` accepts a value, but `signIn` remains a
`() => Promise<boolean>` contract (`src/tools/setup/platform.ts:81`); it
belongs with account/OAuth conversion. `runAgentRequest` is still a
Promise-returning port (`hostRunActions.ts:98`); convert it with its
session-owned admission and settlement path. `PromptHost` and `MessageHost`
are both Effect-typed now (#12584) — preserve the difference between a
notification and a prompt awaiting a choice, including dismissal behavior —
and `ExternalOpener` is a typed Effect port (#12560); a genuinely
non-cancellable shell opening remains so, and its adapter says so.
Pasted-image cleanup depends on the corresponding rooted filesystem
operation. Recount each group from source before assigning work; historical
file counts are not a complete change list.

Finally inspect the remaining internal collaborators reached by the native
loops: model-configuration resolution, prompt preparation, goal continuation,
reflection output, and usage recording. For example, `toolUse.ts` still wraps
`resolveRuntimeModelConfig` (:269), `buildInitialToolUsePrompts` (:337),
`recordUsage` (:671), and `maybeBuildGoalContinuation` (:770) in
`Effect.tryPromise`; reflection has corresponding `tryPromise` calls (:494,
:502, :527, :674, :1083, :1139, :1186). Reflection's raw-output writer is now
an Effect over the context filesystem (#12619); the open question there is
durability, treated in §5. Trace each collaborator to its implementation.
Keep synchronous work synchronous, make internal I/O compose directly, and
retain an adapter only where a real foreign API is reached. A native outer
loop is not evidence that all of its collaborators are native. Use the
existing [model execution](https://github.com/LionSR/TeXRA/issues/12070) and
[usage pipeline](https://github.com/LionSR/TeXRA/issues/12076) trackers for
their remaining requirements.

**Acceptance:** an internal settings write has one execution owner from the
caller through persistence and required post-write effects — now true for the
configuration and state writes; the same shape must hold for each remaining
group. A converted operation is not executed by an injected runner hidden
behind its old Promise signature. Host callbacks still settle the UI
operation once, with interruption and failure represented correctly.

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

Two findings filed on 2026-09-15 belong to this package.
[#12613](https://github.com/LionSR/TeXRA/issues/12613) shows that in the
pinned Effect rc.115 an unhandled failure inside a forked fiber is reported
nowhere — no log line, no exit — and counts 71 production
`runFork`/`runCallback` sites across the three hosts (desktop main 36,
extension 20, CLI 15). Its proposed closure is failure reporting at the
shared runtime boundary (`src/platform/processRuntime.ts`), which covers
every site at once, with site-local return-type pinning to
`Effect.Effect<void, never, never>` as the narrower fallback.
[#12612](https://github.com/LionSR/TeXRA/issues/12612) is the residual gap
#12608 recorded: `catchTag` recovery is not exhaustive, so a channel that
later gains a second failure tag recovers nothing and — per #12613 — fails
silently at exactly those converted sites. Together they set this package's
failure-visibility requirement: a forked or converted site must either carry
an exhaustive typed channel or run under a runtime that reports what it
drops.

**Acceptance:** stopping or closing the owner leaves no admitted work using a
released resource. Expected per-tool failures preserve the dispatcher's
ordering and continuation policy; interruption remains interruption. An
unhandled forked failure is reported, not dropped. Do not
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
activity. The contended-commit scope-loss pins of #12578 are landed examples
of this evidence. For changed ownership or recovery behavior, concentrate on:

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
a `flow.snapshot` whose phase is `output.pending` before any output file is
touched (`reflection.ts:816`), then resumes by running `produceOutput`
(:1150). Its raw-output writer — an Effect over the context filesystem since
#12619 — uses `rawOutputBytes` and file length to avoid a repeated append or
to rewrite from the recorded offset (:588-647).
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
evidence on which the protocol was based. Rows from the first audit whose
findings have since landed were removed; the landing PRs are named in §2
and §4.

| Finding                                                          | Source at the audited revision                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambient configuration comes from selected workspace roots        | [`configUtils.ts:28`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/utils/config/configUtils.ts#L28)                                                                                                                                                     |
| Model configuration still reads that ambient source              | [`modelBinding.ts:335`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/run/modelBinding.ts#L335)                                                                                                                                            |
| The invoker's retry limit and compaction threshold read it too   | [`ModelInvoker.ts:149`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/ModelInvoker.ts#L149), [`compaction.ts:119`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/run/compaction.ts#L119) |
| The debug saver gates on an ambient read                         | [`debugMessageSaver.ts:66`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/debug/debugMessageSaver.ts#L66)                                                                                                                                          |
| GitHub subscription binding resolves a session at call time      | [`RunSubscriptionRegistry.ts:106`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/tools/github/RunSubscriptionRegistry.ts#L106)                                                                                                                           |
| The ambient session fallback remains the single resolution point | [`SessionHandle.ts:1500`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/SessionHandle.ts#L1500)                                                                                                                                            |
| Account sign-in retains a Promise contract                       | [`platform.ts:81`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/tools/setup/platform.ts#L81)                                                                                                                                                            |
| Run launch retains a Promise port                                | [`hostRunActions.ts:98`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/controllers/session/hostRunActions.ts#L98)                                                                                                                                        |
| Session publication settlement is already an Effect              | [`SessionHandle.ts:1066`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/SessionHandle.ts#L1066)                                                                                                                                            |
| Retry tests already use Effect's test clock                      | [`ModelRetryGate.vitest.ts:83`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/test-kernel/agent/runtime/ModelRetryGate.vitest.ts#L83)                                                                                                                    |

The remaining loop collaborators are visible in
[`toolUse.ts:269`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/loop/toolUse.ts#L269)
and [`toolUse.ts:671`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/loop/toolUse.ts#L671).
The reflection recovery comparison rests on the offset-and-length writer at
[`reflection.ts:594`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/loop/reflection.ts#L594)
and the later pending phase at
[`reflection.ts:816`](https://github.com/LionSR/TeXRA/blob/697663eff19ab67384b65a33a79d06507531431b/src/agent/runtime/loop/reflection.ts#L816).

## 8. Audit method and limits

The audit used a fetched, isolated archive of the pinned main revision, source
inspection, live GitHub issue and pull-request records, and the repository's
binding-aware migration check. Parallel audits examined session/runtime
ownership, host contracts, and verification coverage. The original checkout
and its pre-existing untracked files were left intact. The 2026-09-15 re-pin
re-verified each finding against the new baseline with direct source reads
and reran the migration check; its updated counts appear in §2.

This is a source-based protocol draft. It does not claim that the complete
test suite, real desktop contention scenario, crash experiments, or performance
measurements were run during this assessment. Those are execution requirements
for the corresponding changes, not evidence supplied by this document.
