---
created: 2026-09-07
status: measured-baseline
---

# Pre-cutover runtime baseline

Section 8 of the [Effect runtime delivery plan][plan] makes recorded budgets a
precondition of the cutover: "Record numeric performance budgets and the
baseline hardware/datasets in package C before the cutover implementation ...
Budgets are not yet measured by this planning pass; do not replace measurements
with guessed percentage wins or a net-LOC promise."

Nothing owned that, and the cutover is landing stage by stage, so a budget
recorded after the fact would compare the new runtime against nothing. This
document is the pre-cutover half of the comparison. It records what
`scripts/measure-runtime-baseline.mjs` measured on `origin/main` at
`854b36ee69`, the machine and datasets it measured on, and, for each metric the
Performance gate names that is not measurable today, the exact reason.

No production code changed. The harness only reads and writes its own temporary
session roots.

## 1. What the harness measures against, and why that matters

Every scenario reaches SQLite through `Database`
(`src/shared/session/database.ts:64`) and `databaseLayer`
(`src/controllers/session/Database.ts:219`), and through nothing else. That is
deliberate. A harness shaped around modules package D deletes would measure
nothing twice; the point of a baseline is that the same script runs unmodified
after the cutover and produces a back-to-back comparison on one machine.

`Database` is a surviving contract: it is the substrate lane's own boundary, it
is composed exactly once in production at
`src/controllers/session/sessionLayer.ts:457`, the per-session layer map every
host installs, and the delivery plan's deletion ledger does not name it.
`appendAll`, `readAll`, `readListing`, `readInputBatch` and `currentCommit` are
the operations the scenarios use.

A scenario composes the layer exactly the way
`src/test-kernel/controllers/session/sessionEvents.vitest.ts:819` does:

```
databaseLayer('persistent').pipe(
  Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
  Layer.provide(ProcessIdentity.layer(owner)),
  Layer.fresh,
)
```

Two context services and nothing more. `NEXT_SEQ`
(`src/controllers/session/Database.ts:203`) opens a fresh aggregate owned by the
caller on first append, so no scenario needs `acquireClaims`, `platform()`, or a
fixture file.

## 2. How to run it

```
node scripts/measure-runtime-baseline.mjs
```

It prints one JSON object per scenario on stdout, every numeric field
unit-suffixed, and exits non-zero if any scenario's invariants fail. Each record
carries the 1-minute load average it was taken under.

The script refuses to run above a 1-minute load average of 8 and says so, because
a wall-clock number from a busy shared machine is not a smaller number, it is a
meaningless one. `--allow-load` overrides that for an exploratory run whose
output is not going into a budget; do not record such a run here.

Three measurement primitives are first uses in this repository: `perf_hooks`
`monitorEventLoopDelay`, `os.loadavg`, and `process.memoryUsage`. Nothing else
in the tree measures with them, so there is no prior convention to match.

The measured program is an inline TypeScript template compiled by esbuild with
`packages: 'external'` and run in a child process, which is the house
measurement idiom introduced by the bounded session readers work
([#12005](https://github.com/LionSR/TeXRA/pull/12005)); that script is not on
this base commit, so the shape is matched rather than imported. The bundle is
written under `node_modules/.cache/texra-measure/` and removed in a `finally`. It cannot go to `os.tmpdir()`: with external packages, Node resolves
bare specifiers upward from the importing file's directory, and a bundle outside
the repository dies on `import { Effect } from 'effect'`.

## 3. Baseline machine and datasets

| Property      | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Commit        | `854b36ee69` (`origin/main`, 2026-09-07)                 |
| Node          | v26.8.1                                                  |
| Platform      | darwin arm64                                             |
| CPU           | Apple M1 Ultra, 20 logical cores                         |
| Memory        | 68,719,476,736 bytes (64 GiB)                            |
| 1-minute load | 6.83 at start, 5.29 to 7.00 across scenarios (ceiling 8) |
| Measured at   | 2026-09-07T21:06:28Z                                     |

Datasets, all synthetic, all written through `appendAll`:

- **Short retained session**: 1,000 `transcript.entry` rows of 240 characters
  plus one `run.start`.
- **Long retained session**: 100,000 `transcript.entry` rows of 240 characters
  plus one `run.start`.
- **Write load**: 512-character `transcript.entry` rows, appended one per
  commit.
- **Growth shapes**: `status` rows (about 105 payload bytes), 1 KiB
  `transcript.entry` rows, and 256 KiB `transcript.entry` rows standing in for
  retained media.

## 4. Results

### 4.1 Cold open, substrate half

A fresh Node process, `databaseLayer('persistent')` over an existing file, to
the first completed `readListing()`.

| Retained history | Layer build | First listing | Open to listing | Process start to listing | Listing rows |
| ---------------- | ----------- | ------------- | --------------- | ------------------------ | ------------ |
| 1,000 rows       | 9.08 ms     | 2.04 ms       | 11.12 ms        | 782.06 ms                | 1            |
| 100,000 rows     | 8.87 ms     | 2.01 ms       | 10.89 ms        | 783.50 ms                | 1            |

The substrate open does not scale with retained history. `readListing`
(`READ_LISTING`, `src/controllers/session/Database.ts:148`) selects the latest
row per aggregate and listing type, so it is O(aggregates), not O(rows): both
datasets are one stream, so both return one row.

"Process start to listing" is `performance.now()` at that moment, so it includes
Node boot and evaluating the bundled module graph. At about 783 ms in both runs
it dwarfs the 11 ms of actual database work, and it is a floor any host pays
before its first session read. Treat it as an upper bound on module-graph cost,
not as a host startup figure: the harness bundle is not a host bundle.

### 4.2 Idle memory

Same fresh process, after the open and first listing, `gc()`, 400 ms settle,
`gc()`.

Memory figures below are decimal: 1 MB is 10^6 bytes.

| Retained history | Heap used | RSS       | External |
| ---------------- | --------- | --------- | -------- |
| 1,000 rows       | 42.54 MB  | 224.25 MB | 4.33 MB  |
| 100,000 rows     | 42.52 MB  | 225.36 MB | 4.33 MB  |

Idle cost is flat in retained history, as it should be: an open connection holds
prepared statements and pragmas, not rows.

### 4.3 Replay memory

`readAll(0)` over the whole history, then `readInputBatch` over the one stream,
with heap and RSS sampled every millisecond.

| Retained history | `readAll`  | `readInputBatch` | Decoded JSON | Peak heap growth | Peak RSS   | Settled heap |
| ---------------- | ---------- | ---------------- | ------------ | ---------------- | ---------- | ------------ |
| 1,000 rows       | 21.63 ms   | 21.74 ms         | 527,651 B    | 35.17 MB         | 229.29 MB  | 43.32 MB     |
| 100,000 rows     | 1436.93 ms | 1569.39 ms       | 53,933,663 B | 677.82 MB        | 1008.75 MB | 42.33 MB     |

This is the largest number on the page. A 100-fold increase in rows costs 66x the
read time and 19x the transient heap, and peak heap growth runs about 12.6x the
decoded JSON the read returns: `decodeEvent`
(`src/controllers/session/Database.ts:187`) parses each row's JSON and then runs
`SessionEventSchema.parse` over it, and the whole prefix is materialised as one
array. Settled heap returns to the idle figure, so this is a transient, not a
leak, but a 1 GB RSS peak on a single 100,000-row replay is the pre-cutover
number the ledger design has to beat or justify.

### 4.4 Commit latency

Two shapes, because they answer different questions. Batched appends are what a
seeding or import path does; single-row appends are what a live run does.

| Workload                                            | Samples | p50      | p95      | p99      | Max      |
| --------------------------------------------------- | ------- | -------- | -------- | -------- | -------- |
| Batch of 500 rows, seeding 100,000                  | 200     | 14.87 ms | 24.01 ms | 31.33 ms | 38.80 ms |
| One row, one paper, no contention                   | 25,197  | 0.077 ms | 0.115 ms | 0.543 ms | 8.61 ms  |
| One row, four fibers, plus a second writing process | 34,412  | 0.079 ms | 0.123 ms | 1.744 ms | 22.10 ms |

The p95 barely moves under contention; the tail does. That is what
`BEGIN IMMEDIATE` behind one `Semaphore.make(1)` permit
(`src/controllers/session/Database.ts:261`) with `busy_timeout = 5000`
(`src/controllers/session/Database.ts:947`) should look like: work queues rather
than fails, and the cost lands in p99 and max.

### 4.5 Event-loop delay under SQLite contention

The gate asks how much other work SQLite delays, so the reading that answers it
is an independent 10 ms `setInterval` probe measuring its own per-tick lateness,
with `monitorEventLoopDelay` beside it. The append loop's own latency is section
4.4 and cannot answer this question.

Load is four Effect fibers appending single rows plus a second OS process
holding its own connection to the same file. The scenario asserts the
cross-process part actually happened: it failed the run if the commit ordinal
does not advance by more foreign commits than its own.

| Phase                                | Probe p50 | Probe p95 | Probe p99 | Probe max | Loop mean | Loop p95 | Loop max  |
| ------------------------------------ | --------- | --------- | --------- | --------- | --------- | -------- | --------- |
| Idle, database open, no writes       | 0.236 ms  | 0.986 ms  | 1.251 ms  | 1.500 ms  | 1.278 ms  | 1.437 ms | 3.443 ms  |
| 4 fibers + 1 foreign writing process | 0.108 ms  | 3.892 ms  | 7.168 ms  | 13.182 ms | 1.416 ms  | 4.276 ms | 23.167 ms |

Own commits in the loaded phase: 34,416. Foreign commits observed on the same
file in the same window: 1,250.

**The budget: a process committing about 6,900 rows per second, while another
process commits about 250 per second into the same file, delays unrelated
event-loop work by about 2.9 ms at p95 and 5.9 ms at p99.** The median is
unaffected, and is in fact lower under load because the loop is busy and the
timer fires promptly. Nothing here is close to a stall, but the tail is real and
it is entirely synchronous SQLite work: `appendAll` validates, serialises and
commits inside `Effect.try`, on the loop.

### 4.6 Two-paper concurrency

Two session roots are two `databaseLayer` instances over two SQLite files. Each
paper's own `readAll` is checked for the other's rows, and the run fails if it
finds any. It found none.

| Phase      | Rows committed in 3 s | Per paper       | Commit p95 | Probe p95 | Probe max |
| ---------- | --------------------- | --------------- | ---------- | --------- | --------- |
| One paper  | 25,197                | 25,197          | 0.115 ms   | 1.293 ms  | 6.88 ms   |
| Two papers | 27,105                | 13,553 / 13,552 | 0.105 ms   | 4.429 ms  | 208.79 ms |

Aggregate throughput rises 7.6% with the second paper; each paper's own rate
falls to 53.8% of solo. Papers are isolated for correctness and share the event
loop for throughput, which is the expected shape and the thing to re-check after
the cutover. The 208.79 ms probe outlier is a single tick, and the
`monitorEventLoopDelay` maximum agrees with it at 210.76 ms, so it is a real
stall of the whole loop rather than a timer artefact; the most likely cause is a
WAL growth or checkpoint inside one commit, and it is one sample in 281.

### 4.7 Bytes written as history grows

Each shape gets its own database, and the figures below are taken after the
connection closes, because closing is what checkpoints and truncates the WAL. The
scenario fails if any WAL survives the close.

| Row shape                   | Rows   | Payload bytes | On disk    | Per row     | Amplification |
| --------------------------- | ------ | ------------- | ---------- | ----------- | ------------- |
| `status`, about 105 B       | 10,000 | 1,054,450     | 2,990,080  | 299.0 B     | 2.84x         |
| `transcript.entry`, 1 KiB   | 10,000 | 12,355,568    | 15,831,040 | 1,583.1 B   | 1.28x         |
| `transcript.entry`, 256 KiB | 100    | 26,234,964    | 26,333,184 | 263,331.8 B | 1.004x        |

Small rows are where the substrate's per-row overhead shows, and a run emits far
more small rows than large ones, so 2.84x on `status` is the number to watch.
Large rows are essentially free of overhead.

While the connection is open, small-row growth lands entirely in the WAL: the
main file stayed at one page (4,096 B) through all 10,000 `status` rows while the
WAL reached 3,444,352 B, settling to 2,990,080 B on close. A long-lived session
therefore carries its recent history in a WAL that grows until something
checkpoints it, and on this path only closing does.

## 5. Metrics the gate names that are not measurable today

Each of these is recorded rather than dropped, with what would have to exist
first.

**Host-process cold open.** Section 4 measures the substrate half: a fresh Node
process opening an existing session database to its first usable listing. The
host half (VS Code extension activation, the desktop window, the CLI's first
paint) has no launcher harness on this commit. The nearest things in the tree
drive packaged artifacts, not startup timing:
`scripts/smoke-desktop-package-launch.mjs` and
`scripts/smoke-webviews-electron.mjs` assert that a build launches, and
`packages/cli/scripts/validate-run.mjs` drives a packaged CLI. Measuring host
cold open needs a launcher that reports a first-paint timestamp, which is its own
piece of work and is not in this lane.

**p95 stop latency.** Cancellation latency is a property of a run in flight:
cancel during model call, during tool execution, during approval, during queued
admission. Driving one needs a model handler, and the only network-free handler
in the repository is `ModelHandlerValidation`
(`src/agent/modelHandlers/modelHandlerValidation.ts`), reachable only through
`shouldUseInternalValidationModelHandler`
(`src/agent/runtime/internalValidationOverride.ts:30`), which requires all four
of `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1`, a named per-run env var set
to `1`, `CI=1`, and an absolute flag file whose contents match a build-time
sentinel. Any partial activation throws rather than falling through. The
include flag is an esbuild `define` in `packages/cli/scripts/build-bundle.mjs`,
so outside a CLI package-validation build the predicate constant-folds to
`false`. A repository-root script cannot reach it.

**Tool concurrency under load.** Same gate, plus a second limit:
`ModelHandlerValidation.createResponse`
(`src/agent/modelHandlers/modelHandlerValidation.ts:154`) emits at most one tool
call per turn, and only when `TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT=1`. It
cannot produce the parallel fan-out that `ToolUseDispatchNode`'s partition,
dedup and barrier behavior exists to handle, so a concurrency number taken
through it would describe the stub, not the product.

**Representative media through the run path.** Section 4 measures 256 KiB rows
through `appendAll`, which is the durable cost. What it does not measure is
media arriving through the real attachment and transcript path, because that
path needs a run, which needs the model handler above.

## 6. What to compare after the cutover

Run the same script on the post-cutover head, on this machine, at a load average
below the same ceiling, and compare record for record. The scenarios that should
be watched hardest:

1. `replay-memory` heap growth at 100,000 rows. It is the largest number here and
   the one a durable execution ledger is most likely to move, in either
   direction.
2. `loop-delay` probe lateness in the loaded phase. The gate's question is how
   much other work SQLite delays, and the probe is the only reading that answers
   it; commit latency alone cannot.
3. `bytes-written` settled amplification for the `status` shape. Small rows are
   where a ledger's per-row overhead shows, and a run emits far more small rows
   than large ones.

A regression in any of these needs a stated reason, not a percentage. A number
that improves needs the same scrutiny: check the invariants still hold, because
every scenario throws rather than reporting a smaller number when its contract
breaks.

[plan]: ../../.agents/docs/proposed/architecture/2026-09-06-effect-runtime-delivery-plan.md
