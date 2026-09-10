# Kernel suite wall time: the module registry, not the tests

Status: proposed — measured 2026-09-10; the flip is blocked on fixing
cross-file state leaks, listed below.

## Finding

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

## Why the flip is blocked

A shared registry exposes every cross-file leak, and the leaks are
order-dependent: which files share a worker depends on timing. Pinning the
failures into an `isolate: true` project and re-running converged
geometrically (136 → 38 → 21 new failures per round) but never stabilised —
two back-to-back runs of the identical split config failed 21 and 15 suites
with **one** file in common. Across four runs, 209 distinct suites failed at
least once
([evidence list](../../evidence/2026-09-10-shared-module-registry/leaking-suites.txt)).
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
   rejections from `src/agent/storage/executionLease.ts` (20 of 37 unhandled
   errors), `session.onResult is not a function`. 82 suites pull in
   `sessionTestUtils`, 23 reference the execution lease.

## Proposal

Fix the leaks at their sources, then flip `isolate: false` as the default with
a shrink-only pinned list for what remains. Not the other way round: the
pinned list only converges once the shared set is deterministic, and it is
only deterministic once classes 2 and 3 are gone.

- Class 3 is one fix per singleton: `setupFakePlatform.ts` already reinstalls
  the fake host per file; the session runtime, execution-lease registry and
  default-session state need the same per-file reset in that hook, and suites
  that tear them down must restore them.
- Class 2 is a discipline change: replace partial `vi.mock` factories on
  `@platform/*` with `setupPlatform(...)` overrides (which restore after each
  test), and keep any remaining `vi.mock` complete (`importOriginal` spread)
  so a leaked mock is still a working module.
- Class 1 stays isolated. Pin the DOM suites (`progressView`, `settings`,
  `frontend`, `desktop`, `webview` — ~50 files) into an `isolate: true`
  project; they are the ones that genuinely need a fresh registry.

Once 2 and 3 are fixed, re-run `--no-isolate` on the non-DOM tree. The target
is the measured floor: the shared project ran 567 suites in 81s here, against
a full run that does not finish in 45 minutes.

Until then, `npm run test:changed` is the commit-loop gate; `npm test` stays
the pre-PR gate.

## Reproduction

```bash
# per-phase breakdown on one directory
npx vitest run --config vitest.config.mjs src/test-kernel/latex
npx vitest run --config vitest.config.mjs --no-isolate src/test-kernel/latex

# the full-suite trial; expect ~2.5 min and a few hundred order-dependent failures
npx vitest run --config vitest.config.mjs --no-isolate --reporter=dot
```
