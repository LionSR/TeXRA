# Kernel suite wall time: the module registry, not the tests

Status: implemented. Every suite a module registry shared between files can
serve gets one (`vitest.config.mjs`; `src/test-kernel/AGENTS.md`, "Test
tiers"): the `pure` tier since 2026-09-10, and the `kernel` project since
2026-11-02 (slice A6 of
[the tech-debt target designs](../../proposed/architecture/2026-10-27-tech-debt-target-designs.md)).
Only the `isolated` project keeps one registry per file, for the suites that
mock a module, reset the registry or bring a DOM. Membership is computed from
each suite's source, with no list of exempt suites.

The numbers below up to "The flip" are the 2026-09-10 measurement (741 suites
then, 277 at the flip), which sized the payoff of a `kernel` flip at ~3.5x on
the full suite; "The flip (2026-11-02)" has its own.

## Finding (measured 2026-09-10)

`npm test` is slow because every one of the ~741 kernel suites rebuilds its
whole import closure from scratch. Assertions are under a tenth of the work.

`src/test-kernel/latex` (18 files), current config, 4 vCPU:

| phase     | cumulative |
| --------- | ---------- |
| transform | 3.90s      |
| setup     | 28.67s     |
| import    | 3.06s      |
| tests     | 3.03s      |

Wall 14.1s; assertions are 8% of the cumulative work.

Three controlled runs on that directory locate the cost:

- Remove `setupFiles` entirely: setup 0ms, but import rises 3.06s → 25.80s.
  Total unchanged. The cost follows the module graph, not the setup hook —
  suites import the platform/schema graph themselves.
- `--pool=threads`: 12.87s vs 13.01s. Not process spawning.
- `--no-isolate`: setup 28.67s → 7.00s; wall 14.1s → 7.1s.

Vitest's default `isolate: true` gives each file a fresh module registry, so
the Zod schema barrel, the platform ports, Effect (206ms per cold import) and
`typescript` (340ms, via `repoScan`) are re-evaluated per file. At ~1.6s of
graph construction per file this is ~20 CPU-minutes before any assertion runs.

Full suite, same machine:

| config                          | files     | wall                        |
| ------------------------------- | --------- | --------------------------- |
| current (`isolate: true`)       | 741       | killed unfinished at 45 min |
| `--no-isolate`                  | 741       | **2m24s** (136 failed)      |
| shared/isolated split (round 2) | 567 + 174 | 4m07s (21 failed)           |
| shared project alone (round 2)  | 567       | **1m21s** (15 failed)       |

CI's own figure for the current config is ~10 min per shard, two shards, on
2-vCPU runners.

## Why the flip was blocked (2026-09-10)

A shared registry exposes every cross-file leak, and the leaks are
order-dependent: which files share a worker depends on timing. Pinning the
failures into an `isolate: true` project and re-running converged
geometrically (136 → 38 → 21 new failures per round) but never stabilised —
two back-to-back runs of the identical split config failed 21 and 15 suites
with **one** file in common. Across four runs, 209 distinct suites failed at
least once — a number not worth keeping as a list, since which suite leaks
depends on its neighbours; what a suite _reaches_ is the stable fact, and the
`pure` tier is computed from that instead.
Shipping that as the CI default is a flaky CI by construction, and a subset
run (`npm run test:changed`) reorders neighbours every time, so it would be
flaky in the commit loop too.

Three leak classes, from the error tallies:

1. **Lit custom-element registry.** `Invalid constructor, the constructor is
   not part of the custom element registry` (125), `d.createComment is not a
   function` (47). Element classes are bound to the first jsdom window a worker
   created; later suites' windows never see them. `progressView`, `settings`,
   `frontend`, `desktop`, `webview` suites. Structural: these need a fresh
   registry, or a per-worker window they all share.
2. **Partial `vi.mock()` factories staying in the shared cache.** `No
   "workspaceRoots" export is defined on the "@platform/workspaceRoots" mock`
   (15), `No "platform" export …` (8), `platform(...).fs.stat is not a
   function`, `client.buildURL is not a function`. 164 of 741 suites call
   `vi.mock`; 37 mock `@platform/platform` directly. A later suite importing
   the real module gets the earlier suite's partial mock.
3. **Module-scope singletons installed by one file, observed by the next.**
   `Sessions not initialized: call installProcessRuntime()`, `The default
   session has not been initialized`, unhandled `ExecutionLeaseLostError`
   rejections from the execution lease (20 of 37 unhandled errors),
   `session.onResult is not a function`.

## Where the leak classes stand (2026-10-22)

- **Class 1 (Lit registry)** is structural and stays isolated: a Lit element
  class is bound to the window that first loaded it.
- **Class 2 (partial `vi.mock` factories)** shrank: one suite still mocks
  `@platform/*`, and 82 suites still call `vi.mock`. A `vi.mock` moves its
  suite to `kernel`, where it stays isolated.
- **Class 3 (module-scope singletons)** lost its named sources: the
  `platform()` module global, `installProcessRuntime` and the execution
  lease are gone from production. What remains is the kernel's per-file
  setup done as import-time side effects:
  `src/test-kernel/support/defaultSessionTestSetup.ts` opens the default
  session with `Effect.runSync` when imported (about 80 suites import it or
  `sessionGraphTestSetup.ts`), and a shared registry evaluates that once per
  worker, for the first file only.

## Where the counts stand (2026-10-30)

273 suites; 58 import `defaultSessionTestSetup` or `sessionGraphTestSetup`,
27 call `vi.mock`, and the `kernel` project still runs `isolate: true`. The
per-suite migration below is sliced as A3 to A6 in
[the tech-debt target designs](../../proposed/architecture/2026-10-27-tech-debt-target-designs.md)
("Tests and ratchets"); this note keeps the measurements and the reasons.

## How it was done

Each kernel suite's per-file setup moved out of import-time side effects into
layers its blocks build (`support/testKernel.ts`, slices A3 to A5), so a
shared registry has nothing to evaluate once per worker. The non-DOM kernel
tree then went to a shared registry with no pinned list: what needs a
registry of its own is computed from the source, like the rest of the tiers.
The DOM suites (`desktop`, `progressView`, `settings`) stay isolated.

Not a per-file reset hook: a hook that scrubs module globals before each
suite is a transitional adapter whose purpose disappears once the state is
in layers, which AGENTS.md rules out building. Converting a suite to
`it.effect` without moving what it reaches into a layer changes nothing — the
24 leaking Effect suites in the 2026-09-10 run measured exactly that.

Tried and measured on the way here, so nobody repeats them: `vmThreads` /
`vmForks` (33% faster, break cross-realm `instanceof Error`);
`vi.resetModules()` in a first setup file under `isolate: false` (6.2s on
`latex`, but on the full suite it re-evaluates the heavy graphs like isolation
and retains the invalidated ones — three workers at 5.2 / 3.7 / 3.7 GB, the
machine swapping at 28 min); and a per-file dispose of the process runtime in `setupFakePlatform.ts`
(217 failing files against the 136 baseline). The last one fails for the
reason that sizes the whole job: per-file setup done at import runs once per
worker under a shared registry. The only per-file points are `setupFiles`
(before a file's `vi.mock`s, which rules it out) or explicit calls in each
file's body. So the migration is per suite.

## The flip (2026-11-02)

277 suites: `pure` 113 (unchanged), `kernel` 120 on a shared registry, and
`isolated` 44, where the `kernel` project isolated 164 before. Of the 44, 25
call `vi.mock` / `vi.doMock` and 19 sit under `desktop`, `progressView` and
`settings`. Three shuffled runs of the old `kernel` project before the flip
and of the shared one after it (seeds 101, 202 and 303 each), and one run of
every shared suite in a single worker (seed 11, `--maxWorkers=1`), passed
with no failure.

The same 164 suites on one machine (10 cores, five workers), two runs each:
88s and 83s before, 75s and 81s after, with import and setup down from 45%
of the work to 26%. The wall time is now one file's: `crashConformanceTexra`
runs 54s of tests alone (65s beside the other workers), and the 120 shared
suites take 58s to 61s with it and 72s in a single worker. Vitest queues the
`isolated` files first (its default order is by project name), so that file
started 13s into the run and ended it; without a duration cache, as on CI, a
project's files queue by size, which puts that seven-line file last.

What a shared worker carries from one file to the next, and what holds it:

- the installed host (`support/setupPlatform.ts`): each `FakeHost.layer`
  release reinstalls the host it replaced, so a file ends with none;
- the worker's fake root: each new host empties it, and every shared suite
  that touches it builds a host first;
- the worker's storage root and its global database, shared by every host a
  worker builds as `~/.texra` is by a machine's processes: the runs above
  found no suite that reads a global value another one wrote, and the suites
  of the global store open their own (`globalValuesOver` over a temp
  directory);
- the environment, the log sink and the CLI's module state: each suite that
  changes them restores them (`vi.unstubAllEnvs`, `setLogSink(null)`,
  `resetCliState()`), and Vitest restores `vi.spyOn` spies after every file;
- the counter `isolatedTestSession` names storage roots with: it now counts
  per worker, and its numbers stay unique;
- the setup files: they run before every file, and a worker swaps its home
  once, for its first file.

## Reproduction

```bash
# the shared project in a shuffled file order: another seed, other neighbours
npx vitest run --project kernel --sequence.shuffle --sequence.seed=101

# every shared suite in one worker, each file after all the others before it
npx vitest run --project kernel --sequence.shuffle --sequence.seed=11 --maxWorkers=1
```
