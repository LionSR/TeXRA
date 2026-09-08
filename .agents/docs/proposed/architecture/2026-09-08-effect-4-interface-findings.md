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

**Six further gaps:**

- No `lstat` at all, so `isSymlink` needs a `readLink`-plus-errno probe — the
  silent-degradation shape CLAUDE.md forbids.
- **`readDirectory` returns `Array<string>`, not `[name, type]`.** The port
  reads each entry's type off the `withFileTypes` dirent for free; Effect's
  shape forces a `stat` per entry. This is load-bearing, not tuple
  adaptation. **At least twelve production consumers** branch on the type bits
  — a floor rather than a total, since this count has grown at each of three
  review passes (two, then eight, then twelve):
  `indentDirectory.ts:82`, `diffOperations.ts:244,266,284`,
  `memoryFileSystem.ts:252`, `runGeneratedFiles.ts:93`,
  `desktopWorkspaceIpc.ts:261-270`, `workspaceFileListing.ts:37,44`,
  `executionListing.ts:136`, `runOutputFiles.ts:70-72,126`,
  `relativeFS.ts:74` (`cleanupOldFiles` keeps only files — note this is a
  **deletion** path, where a misclassification is unrecoverable),
  `ArxivDownloadTool.ts:23-42` (renders file-vs-directory identity),
  `externalInquiryStorage.ts:456` (accepts only directories), and
  `KVStore.ts:102` (accepts only `.json` files). Four of them —
  `indentDirectory.ts`, `diffOperations.ts`, `memoryFileSystem.ts` and
  `desktopWorkspaceIpc.ts` — call `isSymlink(type)` to **reject** symlinks; because `stat` follows links
  (previous bullet), a symlink-to-file classifies as `File` and those walkers
  would silently start following what they exist to skip. Two —
  `runOutputFiles.ts:68` and `desktopWorkspaceIpc.ts:149` — additionally call
  the port's `isSymlink()` directly, which has no Effect equivalent at all.

  **A third category sits outside this inventory entirely: symlink checks
  made through `stat` rather than `readDirectory`.** `inspectRunStorageEntry`
  (`runStorageFs.ts:64-125`) resolves the root, every ancestor and the leaf
  via `StorageFS.stat(target)).type` and rejects the `SymbolicLink` bit at
  `:108` and `:125`. The Node provider preserves that bit by using `lstat`;
  Effect's `stat` follows links, so under candidate B the check would
  silently never fire and a symlinked ancestor would be accepted as an
  ordinary directory — after which run-file reads and copies could escape the
  execution directory. This is a containment property, not a listing
  nicety, and it means the `lstat` gap reaches code that never calls
  `readDirectory` at all.

  A second member of the same category writes rather than reads.
  `XmlOutputManager.ts:47` guards `writeRoundOutput` with
  `AbsoluteFS.isSymbolicLink` — `stat().type` plus `isSymlink`
  (`baseFS.ts:223-228`) — and deletes a pre-staged symlink before writing.
  Its comment says why: "so the write never follows the link into the
  immutable snapshot". Under link-following `stat` the guard returns false,
  the delete is skipped, and the write goes **through** the link into the
  snapshot it exists to protect. So in this path the `lstat` gap is not a
  weakened check but silent corruption of immutable state.
  So the cost is a correctness rewrite of each walker, on top of the syscall
  cost.

- No `ctime` on `File.Info` — **a cost for candidate A only**, and arguably
  not one at all. A repo-wide search finds `ctime` in the `FileStat`
  declaration (`interfaces.ts:91`), the Node provider that populates it
  (`nodeFilesystem.ts:26`), and test fakes satisfying the type. **No
  production code reads it.** Candidate B deletes the port and so need not
  emulate it; candidate A keeps supplying a field nobody consumes. Listing
  this as a gap charged B for preserving dead weight.
- `mtime` is `Option<Date>`. The natural `none → 0` default makes
  `cleanupOldFiles` delete files it should keep.
- No `dereference` on `copy`.
- No `overwrite` on `rename`.

**`FileSystem.makeNoop` should be banned in this repo** if adoption proceeds:
it defaults `remove` to `Effect.void` and `exists` to `false`.

**Eight production modules bypass the port entirely**, so a memfs-backed port
does not control their inputs. The hole is closable for testing by handing
`glob` a memfs instance directly. For real wiring the candidates differ:
**candidate A can serve the five async importers, candidate B none of the
eight** — so B keeps a second filesystem seam here permanently (below). This paragraph has been
wrong three times in three different directions: it counted two importers,
then called the set unclosable, then called it independent of R-1. Weigh it
accordingly.
The full set of `glob`-package importers outside the test kernel is
`src/agent/index/agentYamlScanner.ts`, `src/tools/glob.ts`,
`src/tools/approval/latexPreview.ts`, `src/latex/formatter/latexindentpt.ts`,
`src/housekeeping/clean.ts`, `src/housekeeping/utils.ts`,
`src/utils/system/platformPaths.ts`, and
`packages/cli/src/runtime/workflowInputs.ts`. Several combine real-filesystem
glob discovery with `WorkspaceFS` operations, so a memfs-backed port does not
control their inputs today.

**All eight are closable for testing with memfs; candidate A can serve five
of them for real, candidate B none.**
The pinned `glob@13.0.6` takes an `fs?: FSOption` — "an fs implementation to
override some or all of the defaults" (`glob.d.ts:231-234`) — while keeping
the `cwd`/`dot`/`nodir`/`absolute`/`signal`/`follow` behaviour these callers
rely on. Supplying memfs **directly** closes the testability hole for all
eight, since memfs has the synchronous methods `glob` wants.

What does _not_ work — and an earlier revision proposed it — is routing
`glob` through Effect's `FileSystem`. `FSOption` (`path-scurry`
`index.d.ts:22-42`) carries both a synchronous set — `lstatSync`,
`readdirSync`, `readlinkSync`, `realpathSync` — and a `promises` sub-object
with async `lstat`, `readdir`, `readlink`, `realpath`, which is what the async
traversal actually calls. So:

- **Candidate A can serve the five async callers.** Its `lstat`-backed stat
  supplies what `promises.lstat` needs, given an adapter shaping the result
  as Node `Stats`. An earlier revision of this paragraph said `FSOption`
  requires synchronous methods and so overcharged A; it does not, for the
  async path.
- **Candidate B can serve none of them.** Not because of sync — because
  `path-scurry` wants **`lstat`**, at `:900` and `:705`, and Effect's
  `FileSystem` has no `lstat` in either form. The three `globSync` callers
  additionally need the synchronous set, which Effect also lacks.

So under B the repo keeps a second filesystem seam for `glob` permanently;
under A the seam is closable for the five async callers and stays only for
the three synchronous ones.

**Three of the eight are synchronous**, which compounds it:
`latexPreview.ts:78`, `latexindentpt.ts:49` and `platformPaths.ts:47` call
`globSync`, so even an async adapter is unavailable to them — they must
become async or keep explicit synchronous wiring.

And Effect's own `glob` is not a route for any of the eight: its signature is
`(pattern, {root?, exclude?})` and accepts none of the
`cwd`/`dot`/`nodir`/`absolute`/`signal`/`follow` options these callers pass.

So the honest summary: **under candidate A the five async importers can be
adapted onto the port and only the three `globSync` callers keep separate
wiring; under candidate B all eight keep it**, because Effect's `FileSystem`
offers no `lstat` in either form. The second seam is a cost B carries and A
mostly does not.

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

**And the hub need not be injected at all.** `Effect.runSync(PubSub.unbounded())`
succeeds on rc.112 — verified by running it — so `TraceEmitter` can build its
own hub in its constructor and none of the 19 `new TraceEmitter()` sites has
to change. That removes most of the construction churn from the estimate
below; the subscription and lifecycle work remains.

One repo-specific cost attaches to it: `src/agent/trace/TraceEmitter.ts` is
not one of the ratchet's boundary kinds
(`packages/{extension,desktop,cli,agent}/src/**` or `src/tools/**/*Tool.ts`),
so a `runSync` there lands in the `Effect.run*` row as below-boundary debt and
`--update` refuses it without a `debtLanes` entry naming the lane that removes
it. Workable, but it converts constructor churn into a tracked debt row rather
than eliminating it.

**An earlier revision called that constructor "the actual blocker". It is not.**
Review pointed out that the handler-construction path is reached from inside an
`Effect.gen` — `src/agent/runtime/AgentLaunchContext.ts:388` yields
`Effect.tryPromise` around `createModelHandler` — so a caller can yield
`PubSub.unbounded()` there and pass the hub into the synchronous constructor.
What the constructor forbids is a **drop-in field initializer**; it does not
forbid replacing `TraceEmitter`. And since the hub can be built in place (see
above), threading one through `createModelHandler`'s `async` signature is not
required either — an earlier revision prescribed that, and it is withdrawn.

So nothing here is impossible. What remains is the size of the job, and it is
smaller than earlier revisions of this note claimed. 26 files touch the seam
in total, but **10 of them only construct** a `TraceEmitter` — and a
constructor that builds its own hub leaves those unchanged. The migration
surface is the **16 files that subscribe**, directly or through
`attachChannelSubscriber`.

This figure has moved three times: "roughly sixteen" estimated, 24 from too
narrow a grep, 26 counted as the union, and now 16 once constructor sites fall
out. Treat it as measured at this tree, not as authoritative.

The composition matters more than the total. **5 of the 16 are production** —
`packages/agent/src/effect/sessions.ts`, `ModelHandler.ts`,
`SessionHandle.ts`, `channelTrace.ts`, `runTrace.ts` — and the other 11 are
test-kernel, most passing a plain synchronous callback to `trace.subscribe`
and reading events out of a local array on the next line. So the production
blast radius is five files, and the cost is concentrated in rewriting eleven
test files that would each need a fiber, a scope and a drain to observe what
a callback observes today.

That is the argument against B4, and it is an economic one: 16 files of
churn, mostly tests, plus the six behavioural properties below, against the
listener machinery being replaced — the `subscribers` field (`:47`),
`subscribe` (`:66-68`) and `emit` (`:70-94`), about 29 lines inside a
217-line class that does much else besides. Not impossibility — price.

Beyond construction, six behavioural properties a replacement must reproduce.
An earlier revision listed the first two as objections that "survive even an
unbounded hub"; review showed that overstates them, and the corrected form is
below.

1. **A `PubSub` puts every subscriber behind one shared buffer, which changes
   how the existing coupling fails — it does not introduce coupling.**
   `AgentTrace.emit` returns `void`, so the **simplest** publish is
   `publishUnsafe`, which returns `false` when a bounded hub is full —
   dropping the event for _every_ subscriber at once, including the durable
   event plane. **This is a bounded-hub failure and does not apply to
   `PubSub.unbounded`**, where publishing cannot fail.

   A `void` signature does not force `publishUnsafe`, though, and an earlier
   revision implied it did. An adapter can launch the ordinary effectful
   `PubSub.publish` on the process runtime — `effectRuntime().runFork(...)`,
   the pattern `SessionHandle.ts:679` already uses from a synchronous method.
   On a full bounded hub that fiber **waits** instead of dropping, which
   removes the cross-subscriber loss entirely. The cost moves rather than
   vanishing: those fibers become lifetime the adapter must track and join at
   disposal, which is property 4 again. So bounded-with-backpressure is a
   third option beside bounded-with-drops and unbounded-with-growth, and B4's
   trade-off should be stated over all three. What replaces it under
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
   **The isolation is recoverable** — wrapping each handler invocation in
   `Effect.catchAllCause` (or inspecting its `Exit`) keeps the fiber alive.
   But `catchAllCause` **alone** silently consumes the failure, and today's
   `emit` does more than survive it: its catch calls
   `log.warn("Trace subscriber threw while handling event: …")`
   (`TraceEmitter.ts:89-91`), with a comment recording that staying quiet
   would be "the quiet-degradation shape the guardrail forbids". That warning
   is the only signal when the subscriber that threw is the **durable sink**
   and an event has therefore been lost. So a replacement must catch _and
   report_, not merely catch. So it is not an unavoidable regression; it is work the
   replacement must do and that the current code gets for free.

3. **Subscription readiness is synchronous today, and four consumers depend on
   it.** `TraceEmitter.subscribe` is `return this.subscribers.add(subscriber)` —
   registration completes before it returns. `SessionHandle.attachRunTrace`
   (`:496-502`) returns that detach handle directly, and
   `packages/agent/src/effect/sessions.ts:402-413` subscribes and only then
   signals admission via `Deferred.doneUnsafe(admitted, ...)`. `PubSub.subscribe`
   returns a **scoped `Effect`**, so an adapter that acquires or forks the
   subscription after exposing the trace loses every event emitted in between —
   and for `attachRunTrace` that is the durable event plane, so those events are
   missing from persistence, not merely from a view.

   Two channel sinks depend on the same guarantee and are easy to miss because
   they are not on the durable plane. `createRunTrace` calls
   `attachChannelSubscriber(trace, …)` (`runTrace.ts:37`) **before returning
   the trace**, so no caller can emit before the sink exists; and
   `ModelHandler`'s constructor attaches its default `'Agent'` channel
   (`ModelHandler.ts:280`) immediately after constructing the emitter —
   deliberately, since the comment above it records that this default is
   exercised through `createThinkingStream`/`createOutputStream` before
   `setLogger` swaps in the real per-run trace on some paths. An adapter that
   exposed either trace before acquiring the scoped subscriber would lose the
   opening agent logs.

   A replacement must acquire every one of these subscriptions **before the
   run starts** and own their scopes until disposal.

4. **Disposal is synchronous today, and tail events depend on that too.**
   Acquiring early is necessary but not sufficient. `AgentRunLifecycle.ts:782`
   calls `ctx.disposeTrace()` without awaiting any subscriber work, which is
   safe only because `emit` delivers inline — by the time disposal runs, every
   emitted event has already reached `SessionHandle.publishRunEvent`. Under a
   hub the consumer is asynchronous, so events published just before disposal
   may still be sitting untaken when the scope closes, and they never reach
   `schedulePublication` for the later persistence flush. These are a run's
   **final** events — outcome and status — so the loss is silent and lands on
   the durable plane. A replacement needs a drain/ack barrier at disposal, or
   must keep the subscriber scope alive until every published event's handler
   has **completed**. Waiting for an empty queue is not sufficient and is not
   a cheaper substitute: a consumer that has already taken the final outcome
   event but is still inside `SessionHandle.publishRunEvent` leaves the queue
   empty while the event has not yet reached `schedulePublication`, so closing
   the scope there interrupts the in-flight handler and loses exactly the tail
   event this property exists to protect. The barrier has to be an
   acknowledgement, not a depth check.

5. **`emit` stamps the stage before fan-out, and the transcript groups on
   it.** `TraceEmitter.emit` resolves a missing `stageId` from the emitter's
   own scope stack before delivering — `event.stageId !== undefined ? event :
{ ...event, stageId: this.currentStageStack().at(-1) }`
   (`TraceEmitter.ts:70-76`) — and `traceFold.ts` uses that value as the
   transcript entry's `groupId`. The stamp is per-emitter context, not part
   of the event a caller publishes. An adapter that puts the caller's raw
   event into a hub loses grouping for everything emitted inside a
   `StageHandle` scope without an explicit id, producing orphaned or
   misgrouped transcript entries. The adapter must hold the per-trace stage
   context and stamp before publishing.

6. **Detachment is synchronous too, and mid-run.** The inverse of property 3,
   and not covered by property 4. `packages/agent/src/effect/sessions.ts`
   holds `release()` — `detach?.(); detach = undefined;` — a plain `void`
   function called while the run continues: by the reader's close, and by the
   `TRACE_HANDOVER_EVENTS` cap at `:404` when nobody is reading. Both rely on
   delivery having **stopped** by the time it returns. A hub adapter whose
   detach merely begins an effectful scope close can keep offering events to a
   consumer fiber that has not yet stopped, which defeats the bounded-handover
   safeguard exactly when it matters — an unread run buffering past its cap.
   Detach must establish a stop-delivery barrier before returning, or the
   lifecycle must become asynchronous and await one. Property 4 drains tail
   events at whole-run disposal; this is about ending one subscription early,
   mid-run.

**None of these six rejects `PubSub`.** They are the contract a replacement
has to reproduce: bounded-vs-unbounded chosen deliberately, per-handler
failures **caught and reported** (isolation alone silently consumes them),
the subscription acquired before the first emit, **every published event's
handler acknowledged** before disposal (an empty queue is not that), each
event stage-stamped on the way in, and detachment stopping delivery before it
returns. Together with the subscription and lifecycle work above — but not
the constructor sites, which can build their own hub — that is the real size
of B4, and the reason not to do it is that size, not impossibility.

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

**The accumulator drain is the only objection to removing the _listener_**,
and it stands on its own. A second and independent constraint applies to the
machinery beneath it:

**The delta machinery is not dead weight, and that question is now settled.**
An earlier revision left open whether the accumulators and delta computation
could be removed wholesale. They cannot:
`src/shared/session/sessionFold.ts:1710` calls `indexes.source.drainEmission()`
for every durable trace event and folds the returned `appended`/`dirtied`
entries into the session transcript view. That is a live production consumer,
independent of `StreamLogStore` — and `StreamLogStore.ts:455` is a _second_
drain, over a different instance of the same class, not the only one.

So the scope is smaller and unambiguous. The `onChange` **listener** and its
store-specific suite may be retired, but the shared `StreamLog` delta
machinery in `src/shared/session/traceEntries.ts` must stay, and
`StreamLogStore`'s own `notify()` drain must be preserved or its accumulators
removed with it. Removing the machinery wholesale would stop live session
transcripts from incorporating trace entries.

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
engine writes its own start marker, but **must not map every
start-without-completion to `Suspended`** — that parks the activity on every
resume, for the reason set out under the storage-error path below. Only a
_live_ marker suspends; a stale one has to be claimed and re-run. The residual hazard is real and is the engine's to solve: on
resume a `Suspended` activity re-runs, so double-effect protection must be
built deliberately.

**Two costs that no issue currently names:**

1. `Workflow.withCompensation` — listed on #12081 as a reason to adopt — is
   **rollback for failures the live workflow observes, not protection against
   abrupt process loss.** It registers finalizers "only for top-level effects
   in the workflow" that "do not work for nested activities", so it is
   unavailable at exactly the boundary model and tool calls would sit on. But
   nesting is not the reason it cannot close the crash window: when a side
   effect succeeds and the process dies before the result is memoized, **no
   finalizer runs at all**, top-level or otherwise. Replay then meets an
   ambiguous incomplete attempt and may repeat the side effect. An earlier
   revision framed this as compensation being unavailable where it is needed;
   the accurate framing is that compensation is the wrong tool for this
   window, and the crash boundary needs **idempotent side effects or durable
   deduplication** instead.
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

**Everything outside an activity replays.** `resume` re-executes the workflow
body from the top; only activity _exits_ are memoized. So any ordinary effect
sitting between activities — a session-progress emission, a KV update, a
filesystem mutation — runs again on every resume, even when every model and
tool activity short-circuits to its stored result. This is distinct from the
crash-window discussion below, which is about an activity whose own effect may
have completed: these are effects that never were activities and replay
_successfully_, duplicating durable events or repeating mutations.

Adoption therefore has to state that the workflow body is deterministic and
free of externally visible effects, and inventory which of TeXRA's current
between-step emissions must either become activities or acquire stable
deduplication keys. For a run whose progress events are the user-visible
transcript, that inventory is not small.

**The Effect-Schema boundary can be held, but not by validating inside the
activity alone.** An `Activity` with `success: Schema.Unknown` round-trips a
raw provider-shaped object through `toCodecJson`, demonstrated running, so
adoption does not force the deferred Zod → `Schema` migration.

The trap is that a memo hit **does not run the activity body** — the engine
returns the stored exit directly (`WorkflowEngine.js:354`, and the replay
mechanics above). A Zod parse placed inside the activity therefore runs on
first execution and is skipped on every replay, while `Schema.Unknown`
accepts whatever was stored without inspecting it. A payload corrupted at
rest, or one written before a contract change, would enter the resumed
workflow unvalidated — the persisted-data failure mode CLAUDE.md's Zod rules
exist to prevent. So Zod stays the source of truth only if the parse runs on
**both** paths: at the memo boundary as well as on fresh execution, or by
giving the activity an Effect schema that enforces the durable contract.

**A durable engine needs a declared storage-error path, and the interface
gives it nowhere to go.** `WorkflowEngine.Encoded` has `never` in **every**
error channel. Replacing `layerMemory` with `ExecutionKVStore` makes every
read and write able to fail — malformed JSON, permissions, a full disk — and
`KVStore` deliberately propagates every failure that is not "missing". With
no error channel, an implementer's default is `Effect.orDie`, which converts
ordinary recoverable storage failures into defects outside TeXRA's normal
reporting path. Adoption must therefore say which operations can map a
failure onto `Suspended` and
where an outer, typed engine boundary has to surface the rest. That decision
is not expressible inside the interface and so belongs in the adoption plan.

**Classify by cause _and_ by phase.** Grouping malformed JSON with
permission and disk failures and then deciding per operation gets it wrong in
both directions. A corrupt persisted row is _present state_, not a transient
condition: every resume reads the same bytes and parks again, so suspending
on it is a permanent hang wearing a retry's clothing. Only genuinely
transient causes may suspend; malformed state has to reach the typed outer
failure path where someone is told about it.

**But cause alone is not sufficient either — the phase matters too.** A
transient failure on a _read_ or a _start marker_ can suspend safely: nothing
is lost by trying again later. A transient failure on the **completion
write** cannot. The activity's effect has already run; suspending discards
the only copy of its result and leaves recovery facing an incomplete marker,
which is the ambiguous-orphan case above — so a disk-full error while
persisting a model call's exit can cost the call itself. That phase needs the
result retained or reconciled before any suspension, not a mapping rule. An
earlier revision rejected per-operation classification outright; the honest
rule is cause **and** phase. The same applies to the
incomplete-attempt marker below — `Suspended` is not the answer there
either.

**Engine records belong in `src/agent/storage/ExecutionKVStore.ts`** — its
header documents it as generic read/write for arbitrary keys, and
`src/agent/node/persistedFlow.ts` already stores arbitrary `flow_<runId>`
records there — not in the closed `SessionEventDraftSchema` vocabulary.

**But an arbitrary key is not automatically internal metadata, and the
`flow_` precedent is precisely what shows the missing half.** `isKVFile`
(`src/tools/executions/executionKvFiles.ts:25`) recognises a key only by
deferring to each owning subsystem: `isReservedKvKeyName`, `FLOW_KEY_PREFIX`,
`isWorkflowScriptCheckpointKvKey`, `isStableSubagentStateKvKey`.
`isReservedKvKeyName` itself knows only the store's fixed vocabulary and the
`child-` prefix — it returns **false** for `flow_abc123`, which the existing
suite pins (`ExecutionKVStore.vitest.ts:102`). `runGeneratedFiles.ts:89`
skips an entry only when `isKVFile` says so.

So an engine that writes rows under an unregistered key surfaces its own JSON
as generated output in **both** the agent-facing `/executions/{id}/files`
listing and the CLI's history listing. The recommendation is therefore: give
the engine an owned key prefix and register it in `isKVFile`, exactly as
`persistedFlow` does.

**The memo key collides across repeated invocations in one live workflow.**
The key is `` `${executionId}/${activity.name}/${attempt}` ``
(`WorkflowEngine.js:347`) and `CurrentAttempt` defaults to 1, advancing only
under `Activity.retry`. So invoking one named `Activity` **twice in the same
workflow** — without `Activity.retry` between them — produces the same key
both times, and the second call returns the first's stored exit without
executing. This is not the restart case below; it happens in a single live
process. TeXRA's runs are repeated model and tool calls, so a generic
activity wrapper needs a deterministic per-invocation identity in the name
(a step index, a call ordinal), or the adoption plan has to guarantee each
activity name occurs at most once per workflow. Neither is free, and nothing
in the interface surfaces the hazard.

**Settled: `Activity.CurrentAttempt` is in-memory, and that is deliberate —
it is how replay works, not a collision.** `Activity.js:75` is
`let attempt = 1` inside a closure, incremented per retry by
`Effect.provideService(effect, CurrentAttempt, attempt++)`, and
`CurrentAttempt` defaults to 1. `makeExecute` passes it straight through as
`engine.activityExecute(activity, attempt)` (`Activity.js:126,130`), and the
engine keys on `` `${executionId}/${activity.name}/${attempt}` ``, returning a
stored exit rather than re-executing (`WorkflowEngine.js:347,354`).

So a resumed run restarting at attempt 1 **reads its own prior result**: the
workflow re-executes from the top, each completed activity short-circuits to
its memoized exit, and `attempt++` walks the stored rows in order until it
reaches the first unmemoized or suspended one. That is deterministic replay,
and it is the mechanism a durable engine depends on.

**An earlier revision of this note got that backwards**, calling the reuse a
collision and prescribing that a durable engine derive the attempt from
persisted state. That prescription is actively harmful: starting at attempt
_N_ would skip rows 1…*N*−1, bypassing prior activity results and changing
the replayed workflow's control flow.

The real requirements are narrower and different:

- **How an incomplete attempt is represented.** The engine inserts a state row
  with `exit: undefined` _before_ running the activity
  (`WorkflowEngine.js:356-360`) and falls through to execute when it finds
  one. `layerMemory` makes that moot, but a durable engine persisting the row
  must distinguish an attempt orphaned by a crash from one a live process is
  still executing. (One way such a marker is created: a completion write that
  failed transiently and suspended — see the storage-error path above.) Nothing in the interface expresses that,
  and the distinction cannot be made by suspending: mapping every
  start-without-completion to `Suspended` parks the activity on every replay,
  since the marker stays incomplete and the next resume meets the same state.
  What is needed is an **ownership or lease transition** — a live marker
  suspends, a stale one is claimed. The repo already has that shape in
  `executionLease.ts`, which is the natural place to look rather than
  inventing one.

  **But claiming a stale marker is not the same as its work being safe to
  re-run**, and an earlier revision of this note said "safe to re-run" as
  though it were. A lease proves no prior owner is still live; it says
  nothing about whether that owner's model or tool call already reached the
  outside world before the process died. That is the same crash window
  `withCompensation` cannot close, so reclaiming a marker requires
  idempotency, durable deduplication, or reconciliation against the external
  effect — the lease is the precondition, not the answer.

- **The interrupt-retry schedule is non-durable state, and it is a different
  counter from `CurrentAttempt`.** `makeExecute` — which reads
  `CurrentAttempt` and performs the memo lookup — wraps `executeWithoutInterrupt`
  from _outside_ (`Activity.js:26,53,59`), so all ten interruption retries run
  **inside a single memo key**, re-running that invocation's effect rather than
  allocating a row each. `CurrentAttempt` advances only through the separate
  `Activity.retry` helper (`Activity.js:74-77`). What a crash resets is the
  in-memory schedule: an activity eight interruption-retries deep resumes
  against the existing `exit: undefined` row with a fresh ten-step budget.

  An earlier revision claimed "one durable row per attempt, unbounded in the
  retry dimension." That conflated the two counters and is withdrawn — the
  interrupt schedule creates no durable rows at all.

- **`Activity.retry`'s schedule replays its delays.** Distinct from the
  interruption schedule above. On resume, prior memoized _failures_ are
  handed back to a freshly initialised `Effect.retry` driver, so the run
  sleeps through the earlier delays again before reaching the first
  unmemoized attempt — and a duration-based budget restarts from zero rather
  than accounting for time already spent. The memo result carries no
  replay-hit flag, so an adapter cannot tell a fresh failure from a replayed
  one. Adoption therefore needs persisted schedule state, a wrapper that
  skips delays on memo hits, or a restriction to replay-safe (delay-free,
  count-bounded) policies. Left alone, a workflow that crashed after eight
  slow retries pays those delays again on every resume.

This was left open in an earlier revision, answered on #12081 in the
collision form, and corrected here after review. The correction on #12081
follows.

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
