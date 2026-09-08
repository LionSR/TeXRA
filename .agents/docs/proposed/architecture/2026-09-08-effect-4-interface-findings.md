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

This matters beyond one issue: `cutover/native-runtime-llm-20260907` already
adds `@effect/platform-node`, so that branch likely carries an unmet `redis`
peer warning. Worth checking there.

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

`src/common/errors/errorPredicates.ts` holds **five** code-reading predicates,
and the split between them is the useful part. Four read the top-level `.code`
— `isFileNotFoundError` (`:2`), `isFileExistsError` (`:8`),
`isNotADirectoryError` (`:14`), `isModuleNotFoundError` (`:19`) — and all four,
along with the `ENOTEMPTY` branch at `src/agent/storage/executionLease.ts:477`,
read **false** against a raw `PlatformError`. The fifth, `isDiskFullError`
(`:57`), walks `causeChain(err)` instead, so it still finds `ENOSPC` on a
wrapped cause.

That fifth one is the shape the other four would need. `jsonStore.ts` already
demonstrates the alternative at a boundary — unwrapping `error.reason.cause`
back to the Node error identity its callers match. Either every predicate walks
the chain, or every boundary unwraps; a written errno mapping that says which is
a prerequisite for any code motion, not a follow-up.

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

The experiment that would settle it is one line: change the default `fs` in
`createFakePlatform` to an effect-backed provider and run the **full** vitest
suite, not a chosen subset.

## 3. `PubSub` cannot replace a synchronous listener set

Relevant to #12074 §B4, which should be moved to that note's rejected list.

**[reproduced]** `effect@4.0.0-rc.112` has **no synchronous `PubSub`
constructor**. `make`/`bounded`/`dropping`/`sliding`/`unbounded` all return an
`Effect`; only `makeAtomicBounded`/`makeAtomicUnbounded` are synchronous, and
they return a bare `Atomic` requiring a hand-written `Strategy`. `subscribe`
returns `Effect<Subscription<A>, never, Scope>`. The only synchronous publish
is `publishUnsafe`, documented to return `false` when a bounded hub is full.

`src/agent/modelHandlers/ModelHandler.ts:279` does `new TraceEmitter()` in a
**production class constructor** — there is no `Effect.gen` to yield in.
(`src/transcript/runTrace.ts:34` constructs a second one, in a plain function.)

Two semantic objections survive even an unbounded hub:

1. **A `PubSub` couples subscribers into one shared buffer; a listener set
   keeps them independent.** `AgentTrace.emit` returns `void`, so the only
   usable publish is `publishUnsafe`. If one subscriber stalls and the hub
   fills, the event is dropped for _every_ subscriber at once — including the
   durable event plane. Today one stalled subscriber structurally cannot affect
   another.
2. **Subscriber fault degrades from per-event to permanent.**
   `TraceEmitter.emit` try/catches each subscriber and delivers the next event.
   Under a hub each subscriber is a fiber looping on `take`; one defect kills
   it and that sink goes dark for the rest of the run.

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

Furthermore, `src/test-kernel/transcript/StreamLogDelta.vitest.ts` uses
`onChange` as the observation seam for genuinely valuable store-level
behaviour: delta precedence (value supersedes chunks), immutability of already
emitted payloads, and the `reset` flag. Removing the surface deletes the only
way to observe that, and `StreamLog.vitest.ts`'s direct `drainEmission` tests
do not cover the store-level half.

The real decision is therefore larger than a deletion: is the delta-emission
machinery itself (accumulators, delta computation, reset flags) dead weight to
remove wholesale, or a deliberately kept extension point? That is a maintainer
call, not a mechanical cleanup.

## 4. `unstable/workflow` — what adoption would actually cost

Relevant to #12081. Prototypes typechecked at `tsc` exit 0 and ran against
`WorkflowEngine.layerMemory`.

**[reproduced]** `Workflow.Result<A,E> = Complete | Suspended` — no third arm.
`WorkflowEngine.Encoded` is exactly ten methods, with `never` in **every**
error channel and no pre-execution hook. The activity memo key includes the
attempt number. `interruptUnsafe`, `resume` and `deferredDone` carry no owner
identity, and `interruptUnsafe` requires a live in-process `Fiber` or Sharding
routing — it is **not implementable cross-process** and degenerates into
`interrupt`. `resume` always means full replay of the workflow body from the
top. `Activity.make` and `Workflow.make` require Effect `Schema`.

Tally for a repo-owned engine: **7 of 10 methods implementable, 2 in-process
bookkeeping, 1 not.**

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
   **up to 10 times, then dies** (`Activity.js:62-66`). TeXRA cancels model
   calls via `AbortController`. Wrapping `ModelInvocationNode` naively turns
   one user cancel into up to ten further provider calls. Overridable per
   activity, but the default is backwards for this codebase.

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
