# Kernel suite wall time: the module registry, not the tests

Status: proposed. The `pure` tier landed on 2026-09-10 in `vitest.config.mjs`:
a module registry shared between files, membership computed from each suite's
source, no list of exempt suites (`src/test-kernel/AGENTS.md`, "Test tiers").
Still open: the `kernel` project runs with `isolate: true`, one module
registry per file, and that is where the suite's wall time goes.

The numbers below are the 2026-09-10 measurement (741 suites then; about 440
today, after consolidation). A clean full run of the isolated config was
**8m45s**; the shared-registry number stands, so the payoff of a `kernel`
flip was sized at ~3.5x on the full suite. Re-measure before acting on it.

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

## Proposal

Move each kernel suite's per-file setup out of import-time side effects into
a layer scoped to the suite (`it.layer(...)`), so a shared registry has
nothing to evaluate once per worker. Then re-run `--no-isolate` on the
non-DOM kernel tree, and flip it to a shared registry with a shrink-only
pinned list for what still leaks. Keep the DOM suites (`progressView`,
`settings`, `frontend`, `desktop`) isolated.

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

## Reproduction

```bash
# per-phase breakdown on one directory
npx vitest run --config vitest.config.mjs src/test-kernel/latex
npx vitest run --config vitest.config.mjs --no-isolate src/test-kernel/latex

# the full-suite trial; expect ~2.5 min and a few hundred order-dependent failures
npx vitest run --config vitest.config.mjs --no-isolate --reporter=dot
```
