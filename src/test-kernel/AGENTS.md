# Test suite guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md), which holds the
testing budget ("Testing discipline"). This file covers the test tiers, how to
write a test that earns its place, and the shared fixtures and fakes.

## Test tiers

`vitest.config.mjs` runs suites in two projects, and a suite's cost is decided
by what it reaches, not by how many tests it has:

- **`pure`** — suites that reach no host: no setup file, no fake platform, no
  DOM, one module registry shared between files. Roughly 8x cheaper per suite
  than `kernel`, and deterministic, because nothing in it installs or replaces
  anything.
- **`kernel`** — everything that needs a host: the fake platform installed per
  file, each file in its own module registry. The DOM suites (`progressView`,
  `settings`, `frontend`, `desktop`) live here too; a Lit element
  class is bound to the window that first loaded it.

Membership is computed from the suite's source, not declared. A suite under a
`pure` directory is `pure` unless it calls `vi.mock` / `vi.doMock` on a
repository module, imports `@platform/*` or a support module that installs or
reads a host, or brings its own DOM (`lit`, `jsdom`) — then it is `kernel`.
Process-wide state a source scan cannot see (such as the environment chalk takes
its color level from) is found by file-order shuffles and fixed in the suite:
set the state on the instance it lives on and restore it after. There is no
list of exempt suites. A module under test that reaches for an ambient host or
the workspace roots itself is a production defect; make it take its host as a
layer or a value. So for a new suite: test the module directly, provide
dependencies as values or layers, and do not mock repository modules. A
`vi.mock` is what moves your suite to the slow tier; the tier is not a target
to opt into.

`packages/llm` carries a third project, `packages/llm/vitest.live.config.mjs`:
one suite per HTTP route (a vendor endpoint and the credential it takes), run
against the real provider (`npm run test:live`). It is never part of `npm test`
because it spends money and needs the network; each suite gates itself on its
route's key, and CI runs it only on the `live-llm` label
(`.github/workflows/live-llm.yml`). `packages/cli/scripts/validate-journeys.mjs`
is the end-to-end sibling: the polish, latexFixer, latexdiff and citations
journeys run through the real `texra run` NDJSON on each cheap model the script lists. It runs
only on demand, on the `live-journeys` label or by dispatch
(`.github/workflows/live-journeys.yml`), never on a schedule or in `npm test`;
in CI a missing model key fails the run, locally it skips that model.

## Scoping the test run

The loop (`test:watch`, `test:changed [ref]`, `test:pure`, `npm test`) is in CLAUDE.md "Commands". `test:pure` includes the architecture ratchets, which read the repository from disk and are never selected by a module graph. Selection is only as good as that graph: a changed YAML resource or image selects nothing, and a change to the harness itself (`vitest.config.mjs`, `src/test-kernel/support/`) is not covered; those are what `npm test` is for.

## Writing tests that earn a place

How to write the tests that do earn a place (adapted from the testing guides
in [opencode](https://github.com/sst/opencode/blob/dev/AGENTS.md)):

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
  one only when the module has no existing suite (one suite per module,
  path-mirrored under `src/test-kernel/`) or for one named cross-module
  scenario, stated in the PR body. Collapse 4+ structurally identical cases
  into `test.each`.
- Do not test what `npm run typecheck` or a Zod schema already guarantees, and
  do not create tests for speculative abstractions, trivial data plumbing,
  implementation details, or compatibility behavior that the product does not
  intend to preserve.

## Test fixtures and fakes

- **Fixture rule of three.** When the same literal setup block appears three or more times in one test file, extract it to a file-local helper. Setup shared across suites is promoted to `src/test-kernel/support/`.

- **One fake per port.** Tests use the shared fakes in `src/test-kernel/support/` for platform ports. A local fake for a port that already has a shared fake requires a one-line comment naming the capability the shared fake deliberately lacks.

- **Effect-based tests use `@effect/vitest`.** A test body that executes an `Effect` program uses `it.effect` (`import { it } from '@effect/vitest'`; `describe`/`expect` stay on `vitest`) with `Effect.gen` + `yield*` instead of `await Effect.runPromise(...)`; rejection assertions use `Effect.flip` or `Effect.exit` plus `expect`. `it.effect` provides a `TestContext` whose clock starts at 0, so tests that depend on real time (real sleeps, polling loops, subprocess or network timeouts) use `it.live` instead. Keep `Effect.runPromise` only in hooks and non-test helpers. Inside `it.effect`/`it.live`, cleanup goes through `Effect.addFinalizer` or `Effect.acquireRelease` (the tester already provides a `Scope`), never `try/finally` around `yield*`: Effect's generator driver does not resume the generator's `finally` after a failed yield. Exemplar: `src/test-kernel/tools/Cancellation.vitest.ts`.

- **`expect` and `node:assert` are both supported.** New `src/test-kernel/` suites use Vitest `expect`. Existing `node:assert` suites stay as they are; convert only in a dedicated mechanical PR (one file or directory, no behavior changes) using the strict mapping: `assert.equal` to `toBe`, `assert.deepEqual` to `toStrictEqual` (never `toEqual`), `assert.ok` to `toBeTruthy()`. `shared/stateSettings.vitest.ts` keeps `node:assert` for its per-key message argument.
