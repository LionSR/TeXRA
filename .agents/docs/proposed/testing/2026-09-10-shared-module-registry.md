# Kernel suite wall time: the module registry, not the tests

Status: proposed — measured 2026-09-10. The `pure` tier (D1) landed the same
day in `vitest.config.mjs`; the `kernel` flip (D2) is blocked on moving the
state that leaks between suites behind Effect layers, which is the 1.0
direction anyway.

Correction to the first baseline below: the ">45 min unfinished" run was not a
clean measurement. A clean full run of the current isolated config on the same
machine is **8m45s** (741 suites). The shared-registry number stands, so the
payoff of the `kernel` flip is ~3.5x on the full suite, not 20x.

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
   rejections from `src/agent/storage/executionLease.ts` (20 of 37 unhandled
   errors), `session.onResult is not a function`. 82 suites pull in
   `sessionTestUtils`, 23 reference the execution lease.

### Effect form alone does not fix it

70 of the 741 suites already use `@effect/vitest` (352 `it.effect` /
`it.live` / `it.scoped` sites), and 24 of them are among the 209 leakers —
the same rate as the rest (34% vs 28%). Their failures are the same shape:
`Cannot read properties of undefined (reading 'selfIdentity' | 'onRelease' |
'emit' | 'getToolUseFollowUpTarget')` and `vi.fn()` call counts — a handle a
neighbouring file replaced. Nothing that a test's own layer provided leaked;
everything the test reached _outside_ its layer did.

That is the actual boundary. The session graph is already Effect-native: a
`LayerMap` keyed by storage root under one `ManagedRuntime`
(`src/controllers/session/sessionLayer.ts`), and `setupPlatform.ts` builds a
`ManagedRuntime` per install. What is not Layer-provided is exactly what
leaks: `platform()` is a module global behind `initPlatform()` read at 74
production sites with no service behind it; `ownedLeases` in
`src/agent/storage/executionLease.ts:130` is a module-scope `Map`; and the
process runtime is installed once per process
(`installProcessRuntime`), so a suite that disposes or re-installs it
changes what the next suite's `it.effect` runs against.

## Proposal

Fix the leaks at their sources, then flip `isolate: false` as the default with
a shrink-only pinned list for what remains. Not the other way round: the
pinned list only converges once the shared set is deterministic, and it is
only deterministic once classes 2 and 3 are gone.

The remedy is the Effect-native one, not a per-file reset hook: a hook that
scrubs module globals before each suite is a transitional adapter whose purpose
disappears once the globals are services, which AGENTS.md rules out building.
A test that gets its dependencies from a layer scoped to the test cannot leak
them by construction, so the fix and the 1.0 migration are the same work,
done in this order:

- Class 3: put the state behind layers and give suites their own. The
  execution-lease registry becomes a service scoped under the session layer
  (it is per-root state already). Suites that today install or dispose the
  process runtime instead build a test runtime with `it.layer(...)` — the
  `ManagedRuntime` that `setupPlatform.ts` already constructs is the seed —
  so the process-global one is never touched from a test.
- Class 2: the platform. `platform()` behind a service is the 74-site
  migration; until it lands, the discipline is `setupPlatform(...)` overrides
  (which restore after each test) instead of `vi.mock('@platform/*')`, and
  any `vi.mock` that remains is complete (`importOriginal` spread) so a leaked
  mock is still a working module. Once the platform is a layer, the
  `vi.mock`s become `it.layer(TestPlatform)` and the discipline is unneeded.
- Class 1 stays isolated. Pin the DOM suites (`progressView`, `settings`,
  `frontend`, `desktop`, `webview` — ~50 files) into an `isolate: true`
  project; a Lit element class is bound to a window, and no layer changes
  that.

Converting a suite to `it.effect` without moving what it reaches into a layer
changes nothing — the 24 leaking Effect suites are the measurement of that.

Tried and measured on the way here, so nobody repeats them: `vmThreads` /
`vmForks` (33% faster, break cross-realm `instanceof Error`);
`vi.resetModules()` in a first setup file under `isolate: false` (6.2s on
`latex`, but on the full suite it re-evaluates the heavy graphs like isolation
and retains the invalidated ones — three workers at 5.2 / 3.7 / 3.7 GB, the
machine swapping at 28 min); and moving the process-runtime install from a
module-scope flag to `tryProcessRuntime()` with a per-file dispose in
`setupFakePlatform.ts` (217 failing files against the 136 baseline). The last
one fails for the reason that sizes the whole job: the kernel's per-file setup
is import-time side effects — `import '@test/support/sessionGraphTestSetup'`,
`defaultSessionTestSetup.ts` calling `initializeDefaultSession()` at import —
and a shared registry evaluates each of those once per worker, for the first
file only. The only per-file points are `setupFiles` (before a file's
`vi.mock`s, which the seam's own comment rules out) or explicit calls in each
file's body. So the migration is per suite, by design of the current kernel.

Once 2 and 3 are done, re-run `--no-isolate` on the non-DOM tree. The target
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
