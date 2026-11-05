# Test suite guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md): the testing
budget, test tiers, how to write a test that earns its place, and the shared
fixtures and fakes.

## Testing discipline

Tests are production maintenance work, and this project breaks internal
interfaces often and on purpose. A test pinned to a boundary about to churn is
merge friction, not safety. The default for a PR is **zero new tests**; a test
earns its place by protecting a consequential current contract, a difficult
invariant, or a reproduced defect. Three rules override anything below:

1. **Never write unit tests after the code.** A test fitted to existing code
   asserts what it does, not what it should do. If the code is written, the
   evidence is an E2E run. Keeping an existing test is not writing one: when a
   cleanup deletes a suite, a live helper keeps its last direct test that
   protects a real contract.
2. **E2E is the default.** Drive the real app (the Playwright suite in
   `packages/desktop/tests/e2e/`, or the real `texra` binary) through the
   user-visible path, ending in a **verifiable, repeatable artifact** a
   reviewer can re-run and inspect: a screenshot, a saved transcript, run
   history, or an output file, written under
   `packages/desktop/tests/e2e/test-results/` (gitignored). The committed
   screenshot baselines live in `packages/desktop/tests/e2e/__screenshots__/`;
   how to refresh them is in `packages/desktop/tests/e2e/README.md`.
3. **An isolated test starts from a written list of failure modes**, before the
   implementation: bad input, malformed persisted data, ordering and
   cancellation races, partial writes, provider errors, boundary sizes, in the
   PR body or at the top of the suite. Each test encodes one entry.

So: a behavior-preserving refactor adds none; a bug fix gets at most one
regression test at the narrowest boundary that shows the defect, written to
fail first (E2E when reachable through the app); a feature gets E2E coverage
of its user-visible path, plus isolated tests only under rule 3 at a durable
boundary (wire contract, schema, parser). Delete tests that would not catch a
real bug: mock echoes, call-count pins, snapshots of copy, "renders without
crashing", re-asserted schema defaults. When code or a format is retired,
delete its tests and fixtures. In review, ask for tests only when the diff
leaves a consequential contract or reproduced defect unprotected.

## Test tiers

`vitest.config.mjs` runs suites in three projects, and a suite's cost is
decided by what it reaches, not by how many tests it has:

- **`pure`** — suites that reach no host: no setup file, no fake platform, no
  DOM, one module registry shared between files. Deterministic, because
  nothing in it installs or replaces anything.
- **`kernel`** — suites over a host, one module registry shared between the
  files a worker runs. A suite states what it runs over as layers its blocks
  build with `@effect/vitest`'s `layer(...)` and `it.layer(...)`
  (`support/testKernel.ts`: `FakeHost.layer`; `SessionGraph.layer` over the
  block's host, or `SessionGraph.hosted` with a default one; and
  `TestSession.layer`). No host is installed by default, and a block's scope
  releases what it built, so nothing a file installs outlives it. A host runs
  the harness alone (`HARNESS_APP`: its settings and built-in plugins) unless
  it names TeXRA (`FakeHost.layer({ app: TEXRA_APP })`, `texraHosted`, in
  `support/texraApp.ts`), which a suite of TeXRA's tools, settings or agents
  does.
- **`isolated`** — what a shared registry cannot serve, each file in its own
  registry and its own worker, several times the cost per suite: a suite that
  calls `vi.mock` / `vi.doMock` (its factory's module would be what the next
  suite imports) or `vi.resetModules`, or brings its own DOM (`lit`, `jsdom`),
  and every suite under `desktop`, `progressView` and `settings`, where
  helpers a scan of the suite does not see bring a window or load modules
  afresh. A Lit element class is bound to the window that first loaded it.

Membership is computed from the suite's source, not declared: a suite that
needs its own registry is `isolated`; otherwise a suite under a `pure`
directory is `pure` unless it imports `@platform/*` or a support module that
installs or reads a host, and every other suite is `kernel`. There is no list
of exempt suites. A shared worker runs file after file, so process-wide state
a source scan cannot see (the environment chalk takes its color level from, a
stubbed global, a host left installed) is found by file-order shuffles
(`--sequence.shuffle --sequence.seed=<n>`) and fixed in the suite: set the
state on the instance it lives on and restore it after. The worker's fake
root holds the files of the host installed now, and each new host empties
it: touch it only under a host your block built. A module under test that
reaches for an ambient host or the workspace roots itself is a production
defect; make it take its host as a layer or a value. So for a new suite: test
the module directly, provide dependencies as values or layers, and do not
mock repository modules. A `vi.mock` is what moves your suite to the slow
tier; the tier is not a target to opt into.

`packages/llm` carries a separate project, `packages/llm/vitest.live.config.mjs`:
one suite per HTTP route (a vendor endpoint and the credential it takes), run
against the real provider (`npm run test:live`). It is never part of `npm test`
because it spends money and needs the network; each suite gates itself on its
route's key, and CI runs it only on the `live-llm` label
(`.github/workflows/live-llm.yml`). `packages/cli/scripts/validate-journeys.mjs`
is the end-to-end sibling: the polish, latexFixer, latexdiff and citations
journeys run through the real `texra run` NDJSON on each cheap model the script lists. It runs
only by hand, never in CI or `npm test`, and skips a model whose key is not set.

## Scoping the test run

The loop (`test:watch`, `test:changed [ref]`, `test:pure`, `npm test`) is in root `AGENTS.md` "Commands". Selection is only as good as that graph: a changed YAML resource or image selects nothing, and a change to the harness itself (`vitest.config.mjs`, `src/test-kernel/support/`) is not covered; those are what `npm test` is for.

## Writing tests that earn a place

Adapted from [opencode](https://github.com/sst/opencode/blob/dev/AGENTS.md)'s
testing guides.

- **Test the real implementation; avoid mocks.** Run the production code
  against real resources: a temp directory, a real git repo, a real SQLite
  file, a real child process. Fake only at an edge — the provider's HTTP
  endpoint (a scripted local server replaying recorded responses), or a host
  port through its shared fake (see "Test fixtures and fakes") — never a
  repository module (see "Test tiers"). Never patch `globalThis`. When a test
  must stub a service, stub only the methods it needs with `Layer.mock`: any
  other method throws, so an unexpected dependency fails loudly rather than
  returning a quiet placeholder.
- **Do not duplicate logic into tests.** An expected value that the test
  computes by re-running the algorithm passes whenever the code is wrong in
  the same way. Write the expected output down as a literal, or check a
  property the code has to satisfy.
- **Synchronize on published signals, never wall-clock.** A fixed sleep that
  waits "long enough" for a forked fiber, a process, or a render is a flake on
  a slow CI host. Wait on the state the next step needs: a `Deferred`, a
  session status, an event on the trace, a file appearing, a Playwright
  web-first assertion. A real sleep is acceptable only where wall-clock time
  is the thing under test (mtime resolution, a real subprocess timeout); an
  Effect program's delays, retries, and debounces run on the test clock
  instead (see "Test fixtures and fakes").
- **E2E hygiene.** Drive the app through user-visible roles, labels, and text,
  with isolated, deterministic data per test. Register an event or network wait
  before the action that triggers it. Retry idempotent readiness checks, never
  state-changing actions. Assert exact outcomes and identities, so stale state,
  duplicate rendering, or the wrong element cannot pass. Never use
  `waitForTimeout`.
- Extend the module's existing suite rather than adding a new test file. Add
  one only when the module has no existing suite (one suite per module, in
  its package's `test/` when it tests one package, otherwise path-mirrored
  under `src/test-kernel/`) or for one named cross-module scenario, stated in
  the PR body. Collapse 4+ structurally identical cases
  into `test.each`.
- Do not test what `npm run typecheck` or a schema already guarantees, and
  do not create tests for speculative abstractions, trivial data plumbing,
  implementation details, or compatibility behavior that the product does not
  intend to preserve.

## Test fixtures and fakes

- **Fixture rule of three.** When the same literal setup block appears three or more times in one test file, extract it to a file-local helper. Setup shared across suites is promoted to `src/test-kernel/support/`, which awaits nothing and runs no Effect at module scope: what a suite runs over is a layer its blocks build.

- **No `!`, no unexplained `as`.** A fixture id or stored row decodes with its schema (`Schema.decodeUnknownSync(RunIdSchema)`), a lookup that may miss narrows with Vitest `assert`, and a deferred value is `Promise.withResolvers`. A partial test double keeps its `as` with a `// cast:` reason on its line or the line before. oxlint fails `value!` here and in `packages/*/test`.

- **One fake per port.** Tests use the shared fakes in `src/test-kernel/support/` for platform ports. A local fake for a port that already has a shared fake requires a one-line comment naming the capability the shared fake deliberately lacks.

- **Effect-based tests use `@effect/vitest`.** A test body that executes an `Effect` program uses `it.effect` (`import { it } from '@effect/vitest'`; `describe`/`expect` stay on `vitest`) with `Effect.gen` + `yield*` instead of `await Effect.runPromise(...)`; rejection assertions use `Effect.flip` or `Effect.exit` plus `expect`. `it.effect` provides a `TestContext` whose clock starts at 0, so tests that depend on real time (real sleeps, polling loops, subprocess or network timeouts) use `it.live` instead. Keep `Effect.runPromise` only in hooks and non-test helpers. Inside `it.effect`/`it.live`, cleanup goes through `Effect.addFinalizer` or `Effect.acquireRelease` (the tester already provides a `Scope`), never `try/finally` around `yield*`: Effect's generator driver does not resume the generator's `finally` after a failed yield. Exemplar: `packages/harness/test/tools/Cancellation.vitest.ts`.

- **`expect` and `node:assert` are both supported.** New `src/test-kernel/` suites use Vitest `expect`. Existing `node:assert` suites stay as they are; convert only in a dedicated mechanical PR (one file or directory, no behavior changes) using the strict mapping: `assert.equal` to `toBe`, `assert.deepEqual` to `toStrictEqual` (never `toEqual`), `assert.ok` to `toBeTruthy()`. `shared/stateSettings.vitest.ts` keeps `node:assert` for its per-key message argument.
