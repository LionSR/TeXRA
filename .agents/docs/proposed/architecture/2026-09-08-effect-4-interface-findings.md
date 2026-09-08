# Effect 4 interface findings: what the pinned types actually say

Status: proposed

Measured against `effect@4.0.0-rc.112` (the repo's exact pin) and the tree at
`1cf1a84`, by six parallel lanes each reviewed by two independent adversarial
passes. This note exists because those facts were expensive to obtain, are
currently scattered across six issue threads, and several of them **contradict
what the open issues assert**.

`effect-solutions` is not installed and the repository does not provision it,
so every claim below is sourced to `node_modules/effect/dist/**` or to a
command whose output was read. AGENTS.md's fallback rule applies: never guess a
v4 API — v4 differs substantially from v3, and three of the corrections below
are exactly that mistake.

Claims marked **[reproduced]** were independently re-derived by a second agent
or by hand after the run. Unmarked claims come from a single pass and should be
re-checked before anything depends on them.

## 1. Corrections to open issues

These are the load-bearing ones. Each was asserted somewhere and is wrong.

### `nodeChildProcessSpawner.ts` is already an `effect/unstable/process` implementation

**[reproduced]** #12078 was filed on the premise that TeXRA had independently
re-created a port that `@effect/platform-node` ships, implying a duplicate to
convert. It is not a duplicate — it is the Node implementation _of that very
module_. The file imports `ChildProcessSpawner` from `effect/unstable/process`,
calls upstream's `make`, and publishes upstream's tag as a `Layer`. All three
consumers (`leanServer.ts`, `leanServerPool.ts`, `directLspAdapter.ts`) are
already Effect-typed against that same tag.

There is also no `ChildProcessSpawner` port in `src/platform/interfaces.ts` —
`grep` returns nothing. `effect` core contains zero `node:child_process`
references, so `unstable/process` is interface-only by design and a repo-side
Node implementation is the intended shape, not debt.

### `@effect/platform-node` is not dependency-free

**[reproduced]** Verified against the registry at `4.0.0-rc.112`:

```
deps:     {"mime":"^4.1.0","undici":"^8.10.0","@effect/platform-node-shared":"^4.0.0-rc.112"}
peerDeps: {"redis":">=5.0.0 <7.0.0","effect":"^4.0.0-rc.112"}
peerMeta: undefined
```

Three dependencies, and `redis` is a **non-optional** peer
(`peerDependenciesMeta` is absent, so it is not marked optional).
`NodeChildProcessSpawner.d.ts` is a one-line re-export of
`@effect/platform-node-shared`, which pulls `ws`.

**[reproduced]** This matters beyond one issue, and an earlier revision guessed
the failure mode wrong. It predicted an _unmet peer warning_ on
`cutover/native-runtime-llm-20260907`. There is no warning: `pnpm-lock.yaml:4`
sets `autoInstallPeers: true`, so pnpm silently installs the peer instead of
complaining.

What actually happens on that branch, verified in its lockfile:
`@effect/platform-node` is declared in **`dependencies`**, `redis` is declared
nowhere, and the lockfile nonetheless carries `redis@6.2.1(@opentelemetry/api@1.9.1)`
with the root importer resolving
`@effect/platform-node@4.0.0-rc.112(effect@4.0.0-rc.112)(redis@6.2.1(...))`.

So `pnpm install` pulls a full Redis client into the production install graph to
satisfy a peer of a package that branch uses for `NodeFileSystem` and `NodePath`
only. Nothing bundles it — esbuild includes only what is imported — so the cost
is install weight and supply-chain surface, on a product that ships a VS Code
extension, desktop installers and a published CLI. The cheapest escape is to take
`FileSystem` and `Path` from `effect` core and supply the two layers directly,
since those are the only pieces in use.

**Do not generalize this to the sibling packages.** `@effect/sql-sqlite-node`
at the same version genuinely has **zero dependencies**, one peer (`effect`),
and is backed by `node:sqlite` — its `SqliteClient.js` imports nothing outside
`effect/*`, and `SqliteClientConfig` documents the backend explicitly. The
error corrected here was assuming one sibling's profile applied to the other.

### `appendFile` is not a missing `FileSystem` operation

`writeFile` takes an `OpenFlag`, and `'a'` is in the union. Any list of
primitives that candidate B of R-1 would have to supply should read
`writeFileAtomic`, `publishFile`, `removeEmptyDirectory` — three, not four.

## 2. `FileSystem` — gaps that the `.d.ts` alone does not reveal

Relevant to R-1 (#12073) and #12078. These are costs of standing on `effect`'s
own `FileSystem` service that the issue does not currently name.

**The errno taxonomy is lossy.** `SystemErrorTag` has 11 members and contains
**none** of `ENOTEMPTY`, `ENOTDIR`, `EISDIR`, `EINVAL`, `ENOSPC`, and
`PlatformError` exposes no top-level `.code`.

`src/common/errors/errorPredicates.ts` exports **five** code-reading predicates,
but only **four** are filesystem ones. `isModuleNotFoundError` (`:19`) matches
`ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`, and its only two consumers
(`src/tools/claudeAgentImport.ts:50`, `src/tools/codexImport.ts:59`) are
dynamic-import paths that never receive a filesystem error. It is out of scope
here and counting it inflates the exposure.

Of the four filesystem predicates, the split is the useful part:

- **Three read the top-level `.code` and read `false` against a raw
  `PlatformError`**: `isFileNotFoundError` (`:2`, ENOENT),
  `isFileExistsError` (`:8`, EEXIST), `isNotADirectoryError` (`:14`, ENOTDIR).
  The inline `ENOTEMPTY` branch at `src/agent/storage/executionLease.ts:477`
  is a fourth exposure of the same shape.
- **`isDiskFullError` (`:57`) already works**, because it walks
  `causeChain(err)` rather than reading a top-level field. A `PlatformError`
  whose `cause` carries the underlying Node error still reports ENOSPC
  correctly.

So the exposure is three predicates plus one inline branch — not five, and
**ENOSPC is not among them.** The prerequisite claim below should be read as
scoped to ENOENT/EEXIST/ENOTDIR/ENOTEMPTY; ENOSPC is already recoverable
through the existing cause-chain path.

`isDiskFullError` is also the shape the other three would need. The alternative
— unwrapping at the boundary — has a working example on `main` in
`spawnFailure` (`src/tools/lean/direct/leanServer.ts:168`), which takes a
`PlatformError` and reads `error.reason.cause ?? error` back to the Node error
identity its callers match.

**Do not look for that pattern in `jsonStore.ts`.** An earlier revision cited
it, and on `main` it does no such thing: it wraps `node:fs/promises` calls in
`Effect.tryPromise`, casts the failure to `NodeJS.ErrnoException`, and hands
that raw error to `isFileNotFoundError` — there is no `PlatformError` to
unwrap. The unwrapping version of `jsonStore.ts` exists only on
`cutover/native-runtime-llm-20260907` (#11997), which is unmerged. Citing it
without that qualifier sent a reader to a file that does not demonstrate the
strategy.

Either every predicate walks the chain, or every boundary unwraps; a written
errno mapping that says which is a prerequisite for code motion touching those
four codes.

**`remove`'s contract is ambiguous exactly where the repo depends on it.** One
`remove` covers both unlink and rmdir, and the interface never says which a
directory receives. The `ENOTEMPTY` that `executionLease.ts:477` branches on
only appears if the implementer routes to `rmdir`; `fs.rm` yields
`ERR_FS_EISDIR`. This was demonstrated to bite: routing to `rmdir` in order to
serve `removeEmptyDirectory` **corrupted `delete`** in the prototype.

**Five further gaps:**

- No `lstat` at all, so `isSymlink` needs a `readLink`-plus-errno probe — the
  silent-degradation shape CLAUDE.md forbids.
- No `ctime` on `File.Info`.
- `mtime` is `Option<Date>`. The natural `none → 0` default makes
  `cleanupOldFiles` delete files it should keep.
- No `dereference` on `copy`.
- No `overwrite` on `rename`.

**`FileSystem.makeNoop` should be banned in this repo** if adoption proceeds:
it defaults `remove` to `Effect.void` and `exists` to `false`.

**Two directory walkers bypass the port entirely** and are untestable on memfs
under _either_ R-1 candidate: `src/agent/index/agentYamlScanner.ts` and
`src/tools/glob.ts` both call the `glob` npm package against the real
filesystem. `effect`'s own `glob` signature is `(pattern, {root?, exclude?})`
and accepts none of the `cwd`/`dot`/`nodir`/`absolute`/`signal`/`follow`
options those callers pass, so adoption does not close the hole.

### A method note, because the obvious experiment was run wrong once

A prototype built to break R-1's deadlock declared its layer
`implements FileSystemProvider` — the interface candidate B _deletes_. Every
ported suite still reached through `platform().fs` and still asserted Node
errno codes, so what was measured was candidate **A** with an Effect backend.
The seam question stayed unanswered.

**And the experiment first prescribed here repeated the same mistake.** An
earlier revision said: change the default `fs` in `createFakePlatform` to an
effect-backed provider and run the full suite. That is the identical error one
level up — swapping one `FileSystemProvider` for another leaves every consumer
reaching through `platform().fs`, so a green full suite would demonstrate only
that candidate A tolerates an Effect backend. It cannot show that the interface
is deletable, which is the whole of B.

A settling experiment has to remove or redirect that access path, not
re-implement behind it. The cheapest honest version: pick one leaf subsystem,
convert its call sites to take `FileSystem` from context, delete its use of
`platform().fs` entirely, and measure what the conversion cost and what broke
around it. That is a real slice of B's cascade; the suite-wide swap is not a
slice of anything.

## 3. Replacing the listener set with `PubSub` is a refactor, not a drop-in

Relevant to #12074 §B4. **This section has been corrected three times and the
conclusion has weakened each time**; what follows is what survives, and it is
"the cost exceeds the benefit", not "this is blocked".

**[reproduced]** `effect@4.0.0-rc.112` has **no synchronous `PubSub`
constructor**. `make`/`bounded`/`dropping`/`sliding`/`unbounded` all return an
`Effect`; only `makeAtomicBounded`/`makeAtomicUnbounded` are synchronous, and
they return a bare `Atomic` requiring a hand-written `Strategy`. `subscribe`
returns `Effect<Subscription<A>, never, Scope>`. The only synchronous publish
is `publishUnsafe`, documented to return `false` when a bounded hub is full.

`src/agent/modelHandlers/ModelHandler.ts:279` does `new TraceEmitter()` in a
**production class constructor**, and `src/transcript/runTrace.ts:34`
constructs a second one in a plain function.

**An earlier revision called that constructor "the actual blocker". It is not.**
Review pointed out that the handler-construction path is reached from inside an
`Effect.gen` — `src/agent/runtime/AgentLaunchContext.ts:388` yields
`Effect.tryPromise` around `createModelHandler` — so a caller can yield
`PubSub.unbounded()` there and pass the hub into the synchronous constructor.
What the constructor forbids is a **drop-in field initializer**; it does not
forbid replacing `TraceEmitter`. The honest characterisation is construction
and injection work: threading a hub through `createModelHandler`'s `async`
signature and into every construction site.

So nothing here is impossible. What remains is the size of the job — roughly
sixteen files, including about ten test call sites that pass plain synchronous
callbacks to `trace.subscribe` and read events out of a local array
immediately — against a 29-line listener set that works. That is the argument
against B4, and it is an economic one.

Beyond construction, three behavioural properties a replacement must reproduce.
An earlier revision listed the first two as objections that "survive even an
unbounded hub"; review showed that overstates them, and the corrected form is
below.

1. **A `PubSub` puts every subscriber behind one shared buffer, which changes
   how the existing coupling fails — it does not introduce coupling.**
   `AgentTrace.emit` returns `void`, so the only
   usable publish is `publishUnsafe`, which returns `false` when a bounded hub
   is full — dropping the event for _every_ subscriber at once, including the
   durable event plane. **This is a bounded-hub failure and does not apply to
   `PubSub.unbounded`**, where publishing cannot fail. What replaces it under
   an unbounded hub is not event loss but unbounded memory growth behind the
   slowest subscriber — a different, arguably worse, failure for a long run.
   **And the "today they are independent" half was also wrong.**
   `TraceEmitter.emit` fans out in a synchronous sequential `for...of`
   (`src/agent/trace/TraceEmitter.ts:78-93`), so a slow or non-returning
   synchronous subscriber already blocks every later subscriber in the loop,
   including a durable sink. Head-of-line blocking exists now. A hub changes
   the failure mode — retained backlog instead of a blocked loop — rather than
   introducing coupling where there was none.
2. **Per-event fault isolation becomes an adapter requirement rather than a
   given.** `TraceEmitter.emit` try/catches each subscriber and delivers the
   next event. Under a hub each subscriber is a fiber looping on `take`, and a
   naïve loop dies on the first defect, taking that sink dark for the run.
   **This is recoverable** — wrapping each handler invocation in
   `Effect.catchAllCause` (or inspecting its `Exit`) restores exactly today's
   isolation. So it is not an unavoidable regression; it is work the
   replacement must do and that the current code gets for free.

3. **Subscription readiness is synchronous today, and two consumers depend on
   it.** `TraceEmitter.subscribe` is `return this.subscribers.add(subscriber)` —
   registration completes before it returns. `SessionHandle.attachRunTrace`
   (`:496-502`) returns that detach handle directly, and
   `packages/agent/src/effect/sessions.ts:402-413` subscribes and only then
   signals admission via `Deferred.doneUnsafe(admitted, ...)`. `PubSub.subscribe`
   returns a **scoped `Effect`**, so an adapter that acquires or forks the
   subscription after exposing the trace loses every event emitted in between —
   and for `attachRunTrace` that is the durable event plane, so those events are
   missing from persistence, not merely from a view. A replacement must acquire
   the subscription **before the run starts** and own its scope until disposal.

**None of these three rejects `PubSub`.** They are the contract a replacement
has to reproduce: bounded-vs-unbounded chosen deliberately, per-handler fault
isolation added explicitly, and the subscription acquired before the first
emit. Together with the injection work above, that is the real size of B4 —
and the reason not to do it is that size, not impossibility.

### `StreamLogStore.onChange` is dead in production but is **not** a three-file deletion

This correction matters because the smaller claim was made twice, including by
this author, on #12074.

`onChange` has exactly one caller in the repository — a test. But it is also
the _only_ way to populate `StreamLogStore`'s listener set, and the private
`notify()` that fans out to that set does its work by calling
`log.drainEmission()`, which **mutates**: it clears `pendingAppendedIds`,
`pendingDirtiedIds` and `pendingTextChunks`.

So deleting `notify()` along with the listener surface removes the only drain
on unbounded accumulators for every `StreamLogStore`-owned log — converting a
cleanup into a memory leak. The drain must survive regardless of whether any
listener does.

An earlier revision offered a second argument — that
`src/test-kernel/transcript/StreamLogDelta.vitest.ts` uses `onChange` as the
observation seam for store-level delta behaviour (precedence, payload
immutability, the `reset` flag), so removing the surface deletes the only way
to observe it. **Review refuted that, correctly, against the repo's own rule.**
AGENTS.md is explicit: "When code or a historical format is retired, delete
tests and fixtures that exist only for that retired behavior instead of
rewriting them around the new implementation." If `onChange` has no production
consumer, that suite protects implementation-only machinery, not a durable or
user-visible contract — so losing the seam is a consequence of the deletion,
not an argument against it.

**The accumulator drain is the only real objection**, and it stands on its own.

The decision is therefore narrower than the earlier revision implied, but still
not mechanical: is the delta-emission machinery (accumulators, delta
computation, reset flags) dead weight to remove wholesale — in which case the
test goes with it — or a deliberately kept extension point? Either way the
drain has to be preserved or its accumulators removed with it.

## 4. `unstable/workflow` — what adoption would actually cost

Relevant to #12081. Prototypes typechecked at `tsc` exit 0 and ran against
`WorkflowEngine.layerMemory`.

**[reproduced]** `Workflow.Result<A,E> = Complete | Suspended` — no third arm.
`WorkflowEngine.Encoded` is exactly ten methods, with `never` in **every**
error channel and no pre-execution hook. The activity memo key includes the
attempt number. `interruptUnsafe`, `resume` and `deferredDone` carry no owner
identity. `resume` always means full replay of the workflow body from the top.
`Activity.make` and `Workflow.make` require Effect `Schema`.

**`interruptUnsafe` — scoped correctly.** Both shipped implementations need
either a live in-process `Fiber` (`WorkflowEngine.js:339`) or Sharding routing.
An earlier revision called it "not implementable cross-process"; review
correctly pointed out that this overstates an interface limitation. Nothing in
the signature forbids an engine from routing the execution id through its own
worker registry or IPC — the Sharding implementation is itself proof that such
routing works. What is unsupported is cross-process interruption **in TeXRA's
current architecture**, which has no such routing layer and would have to build
one. So the constraint is ours, not the interface's.

Tally for a repo-owned engine, **in TeXRA as it stands today**: 7 of 10 methods
implementable, 2 in-process bookkeeping, 1 requiring a routing layer the repo
does not have.

**The `Suspended` arm is the "not decided" channel.** It carries an optional
`cause`, `Activity.js:130-133` parks the run on it, and
`WorkflowEngine.js:350-352` deliberately does **not** memoize a `Suspended`
result. `Workflow.SuspendOnFailure` routes errors there too. A repo-owned
engine writes its own start marker and maps start-without-completion to
`Suspended`. The residual hazard is real and is the engine's to solve: on
resume a `Suspended` activity re-runs, so double-effect protection must be
built deliberately.

**Two costs that no issue currently names:**

1. `Workflow.withCompensation` — listed on #12081 as a reason to adopt — is
   documented as registering finalizers "only for top-level effects in the
   workflow" that "do not work for nested activities". The one framework
   mechanism for ambiguous external effects is unavailable at exactly the
   boundary model and tool calls would sit on.
2. `Activity`'s default `interruptRetryPolicy` re-runs an interrupted activity
   **up to 10 times, then dies** (`Activity.js:62-66`). Overridable per
   activity, but the default is backwards for a codebase whose cancellation is
   an `AbortController`.

   The cost is a defect, not provider traffic. An earlier version of this note
   claimed a naive `ModelInvocationNode` wrapper would turn one user cancel
   into up to ten further provider calls; that is wrong, and the mechanism
   that makes it wrong is worth recording. The signal is run-scoped, not
   per-attempt — bound once as `this.signal = this.services.runScope.signal`
   (`ModelInvocationNode.ts:386`) and aborted once by
   `interrupt: () => runAbortController.abort()`
   (`AgentLaunchContext.ts:632`) — and `runAttempts` throws before calling
   `exec` whenever it is already aborted (`ModelInvocationNode.ts:407-410`),
   with the aborted run routed to `execFallback` (`:441-450`). So each re-run
   short-circuits and reaches no provider. The schedule also only re-fires
   `while (meta.attempt <= 10 && Cause.hasInterrupts(meta.input))`
   (`Activity.js:62`), so a re-run that completes through `execFallback` ends
   the retry immediately.

   What remains is the real hazard: when cancellation also interrupts the
   enclosing fiber, each re-run is interrupted again, the policy walks its
   full schedule (exponential from 400ms, floored against a 10-second
   spacing), and the activity ends in
   `Effect.die('Activity "…" interrupted and retry attempts exhausted')`
   (`Activity.js:65`). A clean user cancel becomes a defect tens of seconds
   later. **[reproduced]** — the claim as originally written was not.

**Durability is not shipped.** `WorkflowEngine` has exactly one layer in
`unstable/workflow` — `layerMemory`. The only durable implementation is
`ClusterWorkflowEngine` in `unstable/cluster`, which brings `Sharding`,
`Runners`, `RunnerStorage`, `MessageStorage` and `Snowflake`. Not adoptable for
a single-process desktop application.

**The Effect-Schema boundary can be held.** An `Activity` with
`success: Schema.Unknown` round-trips a raw provider-shaped object through
`toCodecJson`, demonstrated running. Zod can remain the source of truth inside
the activity, so adoption does not force the deferred Zod → `Schema` migration.

**Engine records belong in `src/agent/storage/ExecutionKVStore.ts`** — its
header documents it as generic read/write for arbitrary keys, and
`src/agent/node/persistedFlow.ts` already stores arbitrary `flow_<runId>`
records there — not in the closed `SessionEventDraftSchema` vocabulary.

**Open and load-bearing:** whether `Activity.CurrentAttempt` survives a process
restart. The attempt-keyed memo argument rests on it; if numbering restarts at
1 after a crash, memo rows collide. One durable row per attempt is also
unbounded growth in the retry dimension.

## 5. `HttpClient` — two references worth knowing about

**[reproduced]** `HttpClient.TracerPropagationEnabled` is a
`Context.Reference` whose default value is `constTrue`
(`unstable/http/HttpClient.js:678`), and TeXRA installs a real `Tracer` via
`effectDiagnosticsLayer` (`src/controllers/session/sessionLayer.ts:727`). Any
request issued through `HttpClient` therefore carries `traceparent` headers
that a `fetch`- or `ky`-based call did not.

`HttpClient.make` copies every request header into span attributes. For a
request carrying `Authorization: Bearer <token>` this is safe **only** because
`Headers.CurrentRedactedNames` defaults to include `authorization` — so any
override of that reference is security-relevant.

`FetchHttpClient.Fetch` is also a `Context.Reference`, and Effect memoizes a
reference's default value permanently on the tag object. A process building the
bare `FetchHttpClient.layer` captures `globalThis.fetch` at first use and never
re-reads it, where `ky` resolved it per call. Inert in production today; it is
the hazard the repo already works around in tests via `testHttpClientLayer`.

## 6. One process finding

The six lanes that produced this note **shared one checkout** rather than
isolated worktrees. Four could not run `npm run typecheck` because borrowed
`node_modules` symlinks triggered `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`; two
mutated the shared `node_modules`; and at least one lane's `git status`
evidence captured another lane's mid-write. Every "green" claim from that run
is weaker than it should be.

Parallel agents editing one repository need a worktree **and** their own
`node_modules` each, or they need to be serialized. This is cheap to fix and
expensive to discover afterwards.

## References

- Effect migration tracking: #12025
- Open rulings, including R-1 and the terminal-row-form test: #12073
- Native-feature catalogue: #12074
- `unstable/sql` substrate lane: #12080
- `unstable/workflow` lane: #12081
