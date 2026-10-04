# Repository Guidelines: TeXRA

This document sets the common conventions for contributions. Follow these norms when working anywhere in this repository.

## TeXRA 1.0 direction

TeXRA 1.0 is the next release generation, developed on `main`, with breaking
changes to the application and its stored state (accepted 2026-09-09; a
development target, not a claim that 1.0 has shipped). The
[implementation and retirement plan](.agents/docs/proposed/architecture/2026-09-09-texra-1-0-implementation-plan.md)
records the audited removal targets. `release/0.40` carries focused fixes for
existing users under the released storage and execution contracts.

- **Project terminology.** Use **project** for the user's working unit in
  product text, documentation, and new or revised application interfaces. A
  project may contain papers, code, data, and other research materials. Use
  **paper** when referring to an actual scholarly document, not as a synonym
  for a project. Existing application identifiers using `paper` should be
  renamed coherently when their surrounding interfaces are revised.
- **Breaking storage format.** SQLite is the authoritative store for persistent
  application state. 1.0 does not import or migrate the legacy JSON store,
  histories, or execution checkpoints (see "Compatibility and format
  retirement"). This does not authorize deleting existing user data:
  initialize new state separately and leave old state untouched. Research
  files remain ordinary files; JSON remains fine for deliberate configuration,
  interchange, and export formats.
- **Effect-native implementation and tests.** Express asynchronous application
  logic through Effect services, layers, scoped resources, typed errors, and
  structured concurrency, with execution kept at the established host, tool,
  and SDK boundaries; do not preserve Promise-based orchestration or add
  pass-through adapters to retain an old internal interface. Pure computation
  stays simple TypeScript. Test Effect programs with `@effect/vitest`,
  `it.effect`, scoped test layers, and the test clock for retries, delays, and
  deadlines; use `it.live` only for real external I/O or real time. Pure
  functions and schemas may use ordinary Vitest. Retire tests with their
  implementation and keep coverage at the final application's durable
  boundaries.
- **Use the supported stack before writing infrastructure.** Prefer the
  maintained facilities of Effect, SQLite, Node, and the host APIs
  (concurrency, resource lifetime, retries, streams, database, filesystem) and
  check their actual APIs before adding a custom implementation. Custom
  infrastructure needs a product requirement those facilities cannot meet;
  preserving an old internal interface is not one. Build the 1.0 design
  directly, in complete changes that stay useful.

## Changelog Guidelines

When updating CHANGELOG.md:

- Cover user-visible features and bug fixes in plain language, grouped into
  Features, Bug Fixes, and (rarely) Breaking Changes
- Describe the net difference from the previous released version, not the
  commit sequence; omit defects introduced and fixed before the release
- Do not expose internal architecture, protocol names, schemas, or codenames;
  describe the effect in product terms
- Exclude refactors, tests, dependency maintenance, and other changes with no
  user-visible effect

## Development workflow

1. **Install dependencies**: run `corepack pnpm install` if needed.
2. **Install the local hooks (recommended)**: install `pre-commit`
   (`python -m pip install pre-commit`), then run `npm run hooks:install`. The
   chained hook (`scripts/format-staged.mjs`) stages Prettier's output for you
   and never overwrites unstaged edits (it keeps the working-tree copy and asks
   you to run `npm run format` afterward). Use `git add -p` for a partially
   staged file, and re-run `npm run hooks:install` after any manual
   `pre-commit install`.
3. **Run checks before committing**:
   - Format code using `npm run format`.
   - Build the extension bundle with `npm run compile:fast`.
   - Lint TypeScript sources with `npm run lint`.
   - Run the affected Vitest suites with `npm run test:changed`, and the
     `pure` tier with `npm run test:pure` before pushing (see "Scoping the
     test run" below). Run the full suite with `npm test` before opening a
     pull request.
4. Commit only when `npm run lint` completes without errors.

### Test tiers

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

### Scoping the test run

The loop (`test:watch`, `test:changed [ref]`, `test:pure`, `npm test`) is in CLAUDE.md "Commands". `test:pure` includes the architecture ratchets, which read the repository from disk and are never selected by a module graph. Selection is only as good as that graph: a changed YAML resource or image selects nothing, and a change to the harness itself (`vitest.config.mjs`, `src/test-kernel/support/`) is not covered; those are what `npm test` is for.

### Build system: esbuild + Vite

The extension host is bundled with esbuild and the webviews with Vite
(`compile:fast`, `watch:fast`, `package:fast`, `build:fast`). Both only strip
TypeScript types, so a build never catches a type error: run `npm run typecheck`
or the `:safe` variants (`compile:safe`, `package:safe`, `build:safe`), which
type check first. CI always runs `typecheck`.

`npm run typecheck` composes independently runnable checks:
`typecheck:workspace`, `typecheck:test-kernel`, `typecheck:agent`,
`typecheck:llm`, `typecheck:cli`, `typecheck:trace-viewer`, and
`typecheck:desktop`. Run the affected ones while developing and the full command
before committing. `typecheck:agent` performs the complete agent-package build
and regenerates `packages/agent/dist/`. There is no `typecheck:extension`: the
root `tsconfig.json` already includes `packages/extension/src/**`. Use
`build:initial` to validate a full initial build (desktop app and VSIX).

## Commit messages

- Use the [Conventional Commits](https://www.conventionalcommits.org) style such as `fix:`, `feat:`, or `docs:`.
- Keep the summary short (under 72 characters) and written in the present tense.
- Provide additional context in the body when needed.

## Coding style

- TypeScript code in repo-root `src/` and `packages/*/src/` targets ES2022.
- Use the provided ESLint configuration (`eslint.config.mjs`) and Prettier settings (`.prettierrc`). Run `npm run format` before committing. `import/order` and `no-nested-ternary` are enforced at error level.
- Prefer `const` and `let` over `var`.
- Group imports by source and prefix each block with a descriptive comment (e.g., `// Third-party imports`, `// Local imports - component`).
- Use the path aliases defined in `tsconfig.json` (for example `@frontend/*`, `@common/*`, `@utils/*`) instead of long relative import chains.
- Document functions with concise comments. Use JSDoc style for public APIs.
- Keep functions small and focused; extract helpers or modules when logic becomes complex.
- Keep webview directory structure aligned where views share a concern (`components/`, `styles/`); beyond that `progressView` and `settingsView` intentionally diverge (see "Webview Consistency Patterns").
- Place a host's own request handling beside the view it serves (e.g. `packages/extension/src/progressView/extensionHostRequests.ts`, `packages/desktop/src/main/desktopHostRequests.ts`); host-neutral session bridging lives under `src/controllers/session/`.

### Naming conventions

- **Const object naming**:
  - Use **PascalCase** for service singletons that encapsulate state and behavior (e.g., `SessionEvents`, `ModelInvoker`)
  - Use **camelCase** for simple command/function namespaces (e.g., `latexCommands`)
- **Constants**: Use `UPPER_SNAKE_CASE` for true constants (e.g., `MAX_ERROR_LENGTH`, `SESSION_CLOSE_DEADLINE_MS`)

### Directory organization

This is a pnpm workspace; CLAUDE.md "Layout" describes the packages and the frozen `@agent/*` surface. Never widen a baseline under `config/ratchets/`; a decrease is always welcome. Kernel architecture tests under `src/test-kernel/architecture/` (for example `approvalPolicyAuthorityRatchet.vitest.ts`) pin single-authority invariants with hardcoded rules rather than baseline JSON.

One of those baselines budgets the code itself rather than an import edge, and it runs in the pure tier:

- `refuted-candidates.json` — the refactor candidates that were investigated, costed and refused, with their ruling anchors (`refutedCandidatesRatchet.vitest.ts` pins each symbol's shape; `.github/workflows/refuted-candidates.yml` fails a PR whose diff touches one without citing its ruling id in the body). Re-proposing a refused candidate as specified is what it stops; landing one on new evidence cites the id and rewrites the entry.

Another code budget reached zero and is now a hardcoded rule: `unknownErrorChannelRatchet.vitest.ts` fails on any production `Effect.Effect<A, unknown, R>` or `Effect.fn.Return<A, unknown, R>`. Type the channel with the tagged error the path already raises; a port whose hosts each fail with their own surface's error takes `Error`; a foreign rejection becomes an `Error` at its boundary with `ensureError` (`@utils/errors/errorMessage`), never a `catch: (e) => e` / `onError: (e) => e` pass-through (the same test fails one, outside its `IDENTITY_CATCH_JOINS` list of late-rejection joins that compare the raw value by identity), and never the thunk form `Effect.try(() => …)` / `Effect.tryPromise(() => …)`, whose `UnknownError` hides the real message behind a fixed one; a combinator that absorbs any failure is generic in it.

- `packages/extension/src/frontend/` contains extension-host utilities that power shared UI flows (agent directories, file listers, instruction banners, tool workflows; subfolders `system/`, `ui/`, `editor/`, `agents/`, `latex/`, `media/`). Prefer these helpers over duplicating logic in commands or webviews.
- `src/common/` holds host-neutral, cross-cutting logic with domain meaning (errors, files, parsing, storage, constants), not a backend-only zone. Some browser-adjacent shared code imports dependency-light modules such as `@common/parsing/safeParseJson`; import through the `@common/*` alias and check the target's dependencies before using it from browser code.
- `packages/extension/src/common/` holds extension-only helpers (webview base classes, shared styles):
  - `packages/extension/src/common/webview/` - Webview content provider (`BundledViewContentProvider`), webview HTML builder (`buildWebviewHtml`), command constants
- `src/utils/` is host-agnostic; only the four `BROWSER_SAFE_UTILS` modules in `eslint.config.mjs` are browser-reachable (CLAUDE.md "Layout"). Helpers specific to one side belong in `frontend/` or `common/`; an import added to one of the four must stay browser-safe.
  - `utils/core/` - Async, type-guard, math, comparator, and path-basics primitives (`debounce`, `filterNotNull`, `clamp`, `byName`, `normalizeFilePath`, `getBasename`, `getFileStem`)
    - `utils/core/perKeyQueue.ts` - `withPerKeyLane`, the one per-key serialization lane (Effect-based; `KeyedMutex` and `async-mutex` were retired by #12696)

- `src/platform/` - Platform abstraction layer: the host ports and the process runtime types. Each host's composition root calls `installProcessRuntime()` once at startup; agnostic code reads the ports from the Effect context that runtime serves.
- `src/ui/` (`@ui/*`) - The host-neutral UI toolkit all three hosts render from (`ui/wa/`, `ui/styles/`, `ui/transcript/`, `ui/markdown/`, `ui/copy/`); see CLAUDE.md "Layout" for its boundaries, including the `litControllers/`, `monaco/`, `highlighting/` trio that stayed in `src/shared/`. `src/transcript/` (`@transcript`) is the unrelated run-transcript persistence layer.

### Pragmatic implementations

- **Start simple**: Choose the most direct solution, using built-ins (objects, Maps, Sets, arrays), host APIs, and JSON for state. A new abstraction earns its place only when it clearly reduces complexity.
- **Trust your inputs**: When data flows from code you control, pass it through directly. Transform or validate only at true system boundaries (user input, external APIs).
- **One error path**: Surface errors once, and let exceptions propagate naturally to that single handler rather than being caught and re-reported at every level. Two modules serve different halves of this and both are correct:
  - `@common/errors` — classification and surfacing: `classifyAgentError`, the SDK-error inspection under `sdkError/`, `errorPredicates`, `errorFormatUtils`. Reach for this when the _kind_ of failure changes what happens next.
  - `@utils/errors/errorMessage` — the three `unknown`-narrowing primitives `toErrorMessage`, `ensureError`, `extractErrorMessage`. Browser-safe, which `@common/errors` is not required to be.

### Testing discipline

Tests are production maintenance work, and this project breaks internal
interfaces often and on purpose. A test pinned to a seam that is about to churn
is not safety — it is merge friction the next refactor has to pay down. The
default for a PR is **zero new tests**; a test must earn its place — protecting
a consequential current contract, a difficult invariant, or a reproduced
defect — and is never proof of work or PR padding.

Three rules come first and override anything below that seems to allow more:

1. **Never write unit tests after you write code.** A unit test written to
   fit code that already exists asserts what the code does, not what it
   should do. It passes on day one, catches nothing, and pins the
   implementation for the next refactor to pay down. If the code is already
   written, the evidence is an E2E run, not a retrofitted unit suite. Keeping
   an existing test is not writing one: when a cleanup deletes a suite, a live
   helper keeps its last direct test that protects a real contract.
2. **E2E tests are the preferred and default testing mechanism.** Verify a
   complex feature by driving the real app (the Playwright suite in
   `packages/desktop/tests/e2e/`, or the real `texra` binary for CLI
   behavior) through the user-visible path. Every E2E test ends by producing
   a **verifiable, repeatable artifact** — a screenshot compared against a
   committed baseline, a saved transcript, run history, or output file —
   written to a known path (`packages/desktop/tests/e2e/test-results/`), so a
   reviewer can re-run the test and diff the artifact rather than trusting a
   green checkmark.
3. **If you must test a system in isolation, write down how it can fail
   first, then write the code.** Before any implementation, list every way the
   unit can fail — bad input, malformed persisted data, ordering and
   cancellation races, partial writes, provider errors, boundary sizes — in the
   PR body or at the top of the suite. Each isolated test encodes one entry
   from that list; a test that maps to no listed failure mode does not get
   written. This is the only route to a new unit test.

Concretely:

- A behavior-preserving refactor adds no new tests; the existing suite passing
  is the evidence.
- A bug fix gets at most one regression test that reproduces the defect, at the
  narrowest boundary that exhibits it — written to fail before the fix lands.
  Prefer an E2E reproduction when the defect is reachable through the app.
- A new feature gets E2E coverage of its user-visible path, ending in an
  artifact. Isolated tests only under rule 3, at its durable boundary — the
  wire contract, the schema, the parser — never a unit test for each internal
  layer the data passes through.
- Delete a unit test that would not catch a real bug the E2E suite misses:
  mock echoes, call-count and call-order pins, snapshot tests of copy,
  "renders without crashing", and re-assertions of a schema's defaults are
  cost with no signal.

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

The same discipline applies in review: do not ask an author to add tests unless
the diff leaves a consequential contract or reproduced defect unprotected. When
code or a historical format is retired, delete tests and fixtures that exist
only for that retired behavior instead of rewriting them around the new
implementation.

### Zod v4 Schema Patterns

This project uses Zod v4. Follow these idiomatic patterns:

**Schemas as the single source of truth**

- Define schemas first, then derive TypeScript types using `z.infer<typeof Schema>`
- Use schema composition (`.extend()`, `.pick()`) instead of duplicating field definitions
- Avoid `z.custom<T>()` when a proper schema exists; prefer `z.discriminatedUnion()` for union types
- Co-locate types with schemas in the same file for maintainability
- Add compile-time assertions (using `satisfies`) when schemas must stay synchronized with external types

**Type and validation idioms**

- `z.int()`, `z.uuid()`, `z.iso.datetime()`, `z.enum(MyEnum)`, `z.looseObject({...})`; `z.strictObject({...})` for tool input schemas, except discriminated-union branches (see "Tool input schemas")
- `.describe('...')` on tool schema fields; `.nullable()` is distinct from `.nullish()` (null or undefined)
- `.custom<T>()` only for external SDK types, with an explanatory comment

**Default values**

- `.prefault(val)` - Substitutes for `undefined` BEFORE validation and transforms; use for documented absent-input defaults
- `.default(val)` - Returns a valid output default for `undefined` without parsing that default
- `.catch(val)` - Substitutes after a validation error; use only where malformed present data may be discarded by policy

Preserve the distinction between absent and invalid present data. In security,
accounting, lifecycle, and durable-state schemas, use `.prefault(...)` only for
documented absent fields with explicit product or compatibility meaning, and let
malformed present values fail validation. Do not use `.catch(...)` to turn
corruption or contract drift into an ordinary default.
An absent required field is also a validation error, so `.catch(...)` replaces
missing required data as well as invalid present data.

Examples: `.prefault(0)` / `.prefault([])` when loading saved state; `.catch('comfortable')` on a non-authoritative view-state field, or `Schema.catch(DEFAULT).parse(data)` for an all-or-nothing view-state fallback (never `safeParse` plus a ternary).

**Null handling from databases**: accept null with `z.string().nullish()` and normalize to undefined.

**Tool input schemas (IMPORTANT)**

Use `.nullish()` instead of `.optional()` for optional fields in tool input schemas (`z.strictObject({ required: z.string(), optional: z.string().nullish() })`). OpenAI-compatible APIs (DeepSeek, Kimi, etc.) require optional fields to also be nullable for structured output compatibility. Check for missing optional values with `== null` (not `=== undefined`), and coalesce with `?? undefined` when passing a nullish tool value to a function expecting `T | undefined`.

**Discriminated-union branches use `.looseObject()`, not `.strictObject()`.** Provider conversion flattens a top-level union into ONE object schema whose properties are the union of every branch's, and it emits no `additionalProperties` key - so the model is never told the flattened object is closed. OpenAI-compatible providers (DeepSeek, Kimi, etc.) then fill every advertised property, including ones that belong to a different command, with `null` rather than omitting it. A `strictObject` branch rejects that as an unrecognized key regardless of nullability; `looseObject` tolerates the cross-branch leakage while still enforcing each branch's own required fields.

A union-branch field with a default needs `nullishWithDefault` (`src/tools/core/inputSchema.ts`) rather than `.prefault()`: `.prefault()` substitutes only for `undefined`, so an explicit `null` fails validation inside the correctly-selected branch, where `looseObject` gives no help.

**Design for the model's first call**

Any parameter with an obvious default should be optional with that default applied at dispatch time (`.nullish()` plus a default when the tool runs), not required: a required parameter that models routinely omit is a tool bug, not a model error. When a description string enumerates dispatch behavior, verify it against the actual dispatch table whenever either changes.

**Compatibility and format retirement**

TeXRA 1.0 keeps no compatibility with earlier persisted data, config shapes,
agent YAML fields, or flags (see "TeXRA 1.0 direction"). Do not add legacy
readers, aliases, migrations, dual-format unions, or compatibility writers, and
there is no retirement window to wait out: delete existing ones on sight, with
their schemas, transforms, fixtures, and compatibility-specific tests. The only
exceptions are formats with consumers outside TeXRA and wire protocols TeXRA
still supports; normalize those once at their boundary, and reject any other
unsupported state with a clear error. `trace.json` is **not** such an exception:
the owner ruled that 1.0's exports start fresh, so a document from an older
build fails loudly at the parse boundary (#12359). The session database is
the same stance made mechanical: `storeSchema.ts`
(`src/controllers/session/`) stamps every `texra.db` with its schema version
and moves a store written before 1.0 aside whole at open (`texra.db.pre1`,
never read again, settings included) and refuses one of a newer schema. Row
kinds carry their own versions (`src/shared/schemas/rowVersions.ts`), read by
the row codec (`rowCodec.ts`) alone; until the 1.0 release freezes them, every
kind is unreleased and changes with no upcaster and no bump.

`config.json` is additive-only from 1.0 (ruled 2026-09-30): a key may be added,
and a released key keeps its meaning, so no retired-key list and no rewrite of
old files is kept.

### ES2023+ Patterns

Use the modern features the ES2022+ target provides: `.at()`, `Object.hasOwn()`,
`.flatMap()`, `.replaceAll()`, `.toSorted()` / `.findLast()` / `.toReversed()`
instead of mutate-then-sort or backwards index loops, `.slice()` over
`.substring()`, `for...of` (with `.entries()` when the index is needed) over
index loops, `Number.parseInt(value, 10)` with an explicit radix, the `node:`
protocol for Node builtins, and `node:timers/promises` for sleeping in
Node-only code. Use `?? false` for boolean coercion, not `|| false`. Copies from
a Set/Map still need the spread before `.toSorted()`.

Index-based loops are still right when the index is the point: token consumers
that advance `i` by a variable stride, queue/BFS loops that append mid-iteration,
and `charCodeAt(i)` hash loops (`for...of` walks code points, not UTF-16 units,
which changes persisted hash output).

### Platform decoupling rules

For good separation of concerns and platform independence, core business logic should stay free of host-specific imports. This improves testability and keeps the door open for future reuse outside VS Code.

1. **Never import `vscode` in VS Code-free zones.** See CLAUDE.md "Separation of concerns: VS Code coupling" for the full list. The key ones: `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/controllers/`, `src/shared/`, `src/ui/`. Do not add new `@agent/*` imports under `src/shared/` or `src/ui/`; host-neutral orchestration belongs under `src/controllers/`.

2. **Use platform-agnostic helpers instead of VS Code types:**
   - `isFile(type)` / `isDirectory(type)` from `@utils/files/fsEntryType` — not `vscode.FileType.File` / `vscode.FileType.Directory`
   - `isFileNotFoundError(err)` from `@common/errors` — not `instanceof vscode.FileSystemError`
   - Use `number` for file type annotations instead of `vscode.FileType` — the numeric values are compatible

3. **Push UI side-effects to the caller.** Business logic functions should return error information (result objects, thrown errors) instead of calling `vscode.window.show*Message()` directly. The command/frontend layer handles user-facing notifications.

4. **Read host capabilities from the Context service that owns them.** When agnostic code needs something only the host provides (e.g., whether an editor extension is installed), take it from the typed service the composition root provides once per process (`SetupPlatform.extensions?.isInstalled`, `Secrets`, `AppState`, the Effect-native `FileSystem`/`Path`). There is no `Platform` object to add a field to; a process fact has one home, the service the runtime serves.

5. **Prefer the session's own `roots.workspace` over `vscode.workspace.workspaceFolders`.** Carry it as data from the caller that holds it (a run's `session.roots`, a tool's `ToolCall.roots`); inside Effect, take it from the `WorkspaceFs` service, whose `root` is the same value. There is no ambient fallback: code that cannot name a caller holding the root has an owner to thread it from, not a helper to reach for.

### Patterns across the codebase

**Configuration, storage, and workspace files**

- For a raw config path, read with `config.get(path)` on the `ConfigProvider` the caller holds (a tool call's `call.roots.config`, a run's `session.roots.config`, a host command's `session.roots.config`) and write with that provider's `update(...)`; there is no standalone `updateConfig`/`watchConfig` helper and no change-notification API. Nearly every `texra.*` path is modeled in the Zod catalog (`src/shared/schemas/coreSettings.ts` / `src/shared/state/stateSettings.ts`); for those, prefer the catalog helpers in `src/utils/config/platformSettings.ts` (`readSettingFrom(stores, key)`, `writeSettingTo(stores, key, value)`) over a raw cast, since they route through the shared validation/`onWrite` path. The `stores` are the settings slots the caller holds (a `WorkspaceRoots` is a `SettingsStores`); there is no ambient reader, so a caller that cannot name its slots has an owner to fix, not a fallback to reach for. Exceptions: the `configTarget: 'global'` rows (the five Models-tab provider toggles, `texra.telemetry.enabled`) keep merged-config semantics on runtime reads and do not go through the catalog reader, which answers a global-target row from global scope only (telemetry's project-file rule, opt out but never in, is the store's `projectValueIgnored` in `jsonConfigProvider.ts`, driven by the row's `projectMayOptOut`); and the CLI's git-author keys (`GIT_MARK_COMMITS`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_WORKTREE_SUPPORT`) go through the CLI's own `readGitAuthorSettingsFromState`, since the catalog helpers default to the `'vscode'` storage slot. For a write reachable from a settings UI (extension/desktop `UPDATE_STATE_SETTING`, CLI `/config`), call `applyStateSettingUpdate` (`src/shared/settingsView/handlers/stateSettingWrite.ts`) rather than `writeSettingTo` directly: it adds the open-workspace guard and the approval-policy side effect a bare catalog write skips.
- Inside Effect, reach a session's files through the rooted services (`WorkspaceFs`, `StorageFs`, `GlobalStorageFs` in `@platform/rootedFs`): each captures its root when its layer is built and refuses a path that escapes it. Workspace path math is a pure function of the root (`workspaceAbsolutePath`/`workspaceRelativePath`/`locateInWorkspace` in `@utils/files/workspaceFS`). Outside Effect, a helper takes the root as data: every run-storage path helper in `@utils/files/runStorageFs` has the root as its first parameter. Nothing in `@utils/files` resolves a root on its own.
- Generate and identify pasted-image filenames with `@utils/files/pastedImageName` and resolve, validate, and persist their paths with `@utils/files/pastedImageUtils` (keeps Node filesystem code out of browser bundles).
- Surface files through the shared listing (`listWorkspaceFilesOfType` in `src/controllers/session/workspaceFileOptions.ts`) and agents through the process catalog (`@agent/index`) instead of duplicating discovery logic.

**Logging and telemetry**

- Log with `Effect.log*` and name the channel with `withLogChannel` (`@logger/effectLog`). Only a synchronous publication point with no fiber (the trace emitter, pre-runtime and shutdown paths) writes `writeLogEntry` from `@logger/logSink` directly. Agent flows should use `AgentTrace` (`@agent/trace`) to get grouped output and tool-use aware channels.
- Always pass structured payloads as raw `data` (`Effect.annotateLogs({ data })`) (file lists, missing outputs, latexdiff results, usage statistics) so the progress view can render rich entries without custom parsing.
- Publish runtime progress through session events and `SessionHandle.interactions.emit`; keep non-agent logs on the shared `TeXRA` output channel.

**Agent execution and tool-use**

- Define agents using `AgentDataclass` and `AgentConfig` (`src/agent/core/`) and compose them via the factories in `src/agent/runtime`.
- Launch executions via `runAgent` and resume via `resumeRun` (see CLAUDE.md "Agent system"); use the lower-level `executeAgent` only when you already own the `runId` (e.g. subagent dispatch in `src/tools/delegation/inBandSubagentRun.ts`). Attach presentation and approval behavior to the run's `SessionHandle.interactions`.
- A new provider is a protocol arm in `packages/llm` plus a route row in `src/agent/runtime/modelRoutes.ts` and `src/agent/runtime/run/modelBinding.ts`; there is no per-provider handler class. Register capabilities/pricing in `src/model/computeModelOptions.ts`.

**Run loop architecture**

A run is one Effect program in `src/agent/runtime/loop/`, no cursor and no graph:

- **One program**: `runToolUse` (`loop/toolUse.ts`, with `loop/toolUseDispatch.ts`). Workflow agents run it in round mode (`loop/rounds.ts`): the documents plugin's continuation policy opens each round's turn and processes its output (`src/agent/output/documentRounds.ts`), and the agent is offered no tools. `loop/rows.ts` builds every run history draft the loop appends. `core/tools/toolCallParsing.ts` parses the response's tool calls.
- **State is row data.** The loop never holds its own copy of the conversation: it continues from the folded `RunState` (`src/shared/session/runStateFold.ts`) that `RunHistory.appendBatch` returns, so the live path and the resume path are one function. Resume reads only the fold; `flow_<id>.json` is never read.
- **Services come from context**, provided once at the `executeAgent` boundary: `AgentRun` (`runtime/run/AgentRun.ts`, everything one run owns), `ModelInvoker` (the only service that calls the `packages/llm` `Model`), and the session-root `RunHistory` and `Runs` (`runtime/runRegistry.ts`: admission, lanes, live handles, waiting termination; built by the session layer). No services bag, no node fields.
- **A run's input queue is its own, never context.** A conversation run claims its lease over the follow-up queue in its own scope (`claimFollowUps` in `runtime/FollowUps.ts`, from `runToolUse`); a round-mode run takes no input and claims none. A child launched from a parent's tool call runs in that call's fiber, so a context-provided queue would hand it the parent's: never read another run's input from context.
- **Write points are the contract**: a `model.message attempt` before a billed request leaves the process; the `response` row before any tool dispatches; `tool.intent` before every barrier call; `tool.result` before the loop continues; a `run.position` for every wait and every halt; a `run.snapshot` authored only from the state the run history returned (reconcile-never-overwrite).
- **Retry has two owners**, both inside `ModelInvoker`: an automatic route-scoped batch under the session's `ModelRetryGate`, and a durable human permit (`request.opened` bound through the snapshot's `pendingRetry`: `waiting` -> `authorized` -> `started`). Nothing else retries a model call; provider SDK retries stay disabled. Compaction summaries and helper calls take the invoker's call path (`run/modelCall.ts`): the same gate, automatic batch, pricing and usage report, marked with a `purpose`.
- **Interruption is the fiber's.** Each activity/append pair runs under `Effect.uninterruptibleMask` with only the handoff and the durable append masked; there is no `AbortSignal` threading inside the loop.
- **Agent owns lifecycle**: `executeAgent` / `AgentRunLifecycle` handle init and finalize; the loop only executes.

**Webviews and UI**

- Generate HTML through `BundledViewContentProvider` (`packages/extension/src/common/webview/BundledViewContentProvider.ts`) and its `buildWebviewHtml` helper. There is no shared message-handler base class: `settingsView` owns its inbound dispatch inside `SettingsViewMessageHandler` and `progressView` routes through typed host requests, so follow the pattern of the view you are touching (see "Webview Consistency Patterns").
- Use Web Awesome (`<wa-icon>` via `waIcon()` from `@ui/wa/webAwesomeIcons`) and shared utilities from `@utils/text/stringUtils` and `@utils/core` (path basics: `normalizeFilePath`, `getBasename`, `getFileStem`). Keep CSS modular: per-component styles as TypeScript in each view's `frontend/` directory, shared tokens in `packages/extension/src/common/styles/common.css`.

**Error handling and types**

- Format and surface errors through `showLoggedErrorMessage` and `showLoggedMessageWithDocs` in `packages/extension/src/frontend/ui/errorHandlingUtils.ts` for consistent telemetry and documentation links.
- Derive runtime-safe interfaces with `zod` plus `z.infer`, colocated with their domains (e.g., `src/agent/core/state`).

**Miscellaneous**

- Execute VS Code commands with `safeExecuteCommand` from `packages/extension/src/frontend/system/commandUtils.ts` and shell commands with `executeCommand` from `src/utils/system/execUtils.ts` so logging and error handling stay uniform.
- Retrieve included file extensions via `getIncludedExtensions` in `src/common/files/fileTypeUtils.ts`.
- Use `packages/extension/src/frontend/ui/dialogs.ts` and `instruction.ts` for notification primitives shared across the extension.

### Webview Consistency Patterns

Two message-passing architectures coexist for the extension's views. Match the
one the view you're touching already uses:

- **`settingsView`** is request/response: `SettingsViewMessageHandler`
  (`packages/extension/src/settingsView/`) owns its inbound dispatch directly
  over the shared settings body
  (`src/controllers/settingsView/sharedSettingsCommands.ts`) and its page
  modules; only the VS Code-specific LaTeX arms live in
  `settingsView/handlers/latexSettingsHandlers.ts`. Commands are named constants in `src/shared/ipc.ts` (`COMMON_COMMANDS`,
  `SETTINGS_VIEW_COMMANDS`), not string literals. Frontend state lives in
  module-level reactive signals in `settingsView/frontend/settingsState.ts`
  (`trackedSignal`); `settingsView/frontend/messageDispatcher.ts` holds the one
  outbound handler registry (`settingsViewHandlers`, typed
  `SettingsViewOutboundHandlerRegistry` so it stays exhaustive).
- **`progressView`** (the sidebar and editor-tab conversation shell) is
  event-fold: `ProgressViewProvider` implements `vscode.WebviewViewProvider`
  directly, composed with `BundledViewContentProvider`, and routes through
  `SessionBridge` / `HostDraftRequests` as typed `runtime.request` /
  `host.request` calls (see
  `.agents/docs/implemented/architecture/2026-09-03-one-view-state-three-renderers.md`).
  Its Lit components (`progressView/frontend/components/`) read the
  `SessionView` fold (`src/shared/session/sessionView.ts`) and `Surface`
  records as properties.
- **Naming Convention**: within whichever pattern applies, follow
  `[Domain]View[Component]` (e.g. `SettingsViewMessageHandler`,
  `ProgressViewProvider`). Adding a genuinely new pattern needs an update to
  this section, not a silent third variant.
- **Resource Access**: Include all common module paths in `localResourceRoots` to prevent 401 errors.
- **Design system**: tokens, control skins, and the brand and human-in-the-loop rules are in `src/ui/README.md`. Read it before adding a control or a local style override

### UI anti-patterns

Never compensate for data-model problems at render time: no `Date.now()`, synthetic IDs, DOM existence checks or deduplication in renderers. Store data once at the source with all metadata. One home per user action: secondary surfaces show read-only status, never a second control (exceptions: a global default versus a per-item override, or one command plus a single UI button). Grep procedure: code-review checklist § 5.

## Design and refactoring

Draw on John Ousterhout's _A Philosophy of Software Design_ when adding or
refactoring code:

- Simplify sources of complexity (change amplification, cognitive load, unknown
  unknowns) before adding features.
- Deepen shallow modules that merely pass data through: hide implementation
  behind small interfaces and combine functionality that leaks across modules.
- Aim for the structure you would have had if you had designed the system with
  the change in mind. In a PR, describe the design issues found and how the
  refactoring addresses them.
- After large renames, search for missed files and paths.
- Share state between managers by passing the shared dependency through the
  constructor.

### Flattening abstraction layers

Entry points (`executeAgent`) run the loop program (`runToolUse`) directly. Inline a wrapper that only creates state, runs the program, and interprets results; delete unused wrapper files and leave no empty re-exports; import from the module that defines the symbol, never a re-exporting file.

### Discouraged factory patterns

Avoid factories that add indirection without value: a two-layer factory whose inner `buildX` is called only from `createX` (inline it), and a trivial identity factory that only spreads into a new object (use an object literal).

A factory IS justified when it is called from multiple locations, contains meaningful logic (validation, defaults, transforms), creates class instances or complex objects, or captures closures with initialization context.

At review time this extends into the abstraction-cost guardrails (code-review checklist § 13): grep the caller count before approving any new shared helper (single-caller extractions are banned), and hold new ports/facades/template-methods to build-implies-delete-in-the-same-PR with net-LOC accounting.

## Code quality rules

These rules were learned from a 2026-07 whole-repo simplification campaign. They complement the guardrails above ("Flattening abstraction layers", "Discouraged factory patterns", "UI anti-patterns", the code-review checklist § 13, and Zod-as-SSOT).

- **Exports are contracts; default to file-local.** A new export needs a consumer in the same PR. The dead-export ratchet (`npm run check:dead-code-ratchet`, per-symbol baseline in `config/ratchets/knip-baseline.json`) fails any unused export not in the baseline.

- **The core holds the pi bar, shrink-only.** In the harness and llm cores (`CORE_QUALITY_DIRS` in `eslint.config.mjs`), `npm run check:core-quality` holds the sixteen rules of the core-quality study (texra-design-pages `core-quality-study.md` §14) plus a few of its own, per file: `any`, `!`, `as` casts without a `// cast:` reason, object-literal assertions, exported functions without a return type, exports without TSDoc, runtime import cycles, files over 400 lines, functions over 150 physical lines (layer closures included) or modified complexity 15 or depth 4, `new Promise`, `.then(`, `Effect.run*` outside a named entry, try/catch around Effect code, silent fallbacks, exported records over 20 public members, non-erasable syntax, `vi.mock` of a core module, ranged core dependencies, the files and packages each core entry reaches, the numbered durable invariants, and core READMEs without a diagram. Decision codes in comments are measured only. Baselines live in `config/ratchets/core-quality/`; a value that rises fails, and one that falls must be lowered with `--update` in the same change (`--move old=new` carries a rename). `config/api-reports/` holds each core package entry's public surface, regenerated by `--update`, so a surface change shows as a diff. When a hotspot is too complex, find the data structure, duplicated fact or misplaced owner behind it; never split a file mechanically.

- **No convenience barrels.** A barrel/index re-export file exists only for a documented public surface (for example, the trace events SDK contract, which declares its surface in its own docstring). Everything else imports the file that defines the symbol. Nothing has a re-export shim.

- **Never hand out a shared mutable literal.** A module-level object that a function returns, or that crosses a module boundary, must be frozen (`as const` plus `Object.freeze`) or produced fresh by a factory. `Object.freeze` is shallow: for nested objects/arrays or a `Map`/`Set`, deep-freeze or use a factory.

- **Global registration requires a global consumer.** Register something globally (components, commands, providers) only when an external surface references it; internal-only consumers import locally.

- **No bare module-level mutable singletons in tested code.** State that tests need to isolate belongs behind an injectable, resettable handle.

- **Serialize asynchronous work through Effect.** Use Effect concurrency primitives or `withPerKeyLane` (`src/utils/core/perKeyQueue.ts`) when operations must run one at a time per key. Resource ownership must be released on success, failure, and interruption. Do not hand-write Promise chains for it; follow the TeXRA 1.0 direction above.

### Test fixtures and fakes

- **Fixture rule of three.** When the same literal setup block appears three or more times in one test file, extract it to a file-local helper. Setup shared across suites is promoted to `src/test-kernel/support/`.

- **One fake per port.** Tests use the shared fakes in `src/test-kernel/support/` for platform ports. A local fake for a port that already has a shared fake requires a one-line comment naming the capability the shared fake deliberately lacks.

- **Effect-based tests use `@effect/vitest`.** A test body that executes an `Effect` program uses `it.effect` (`import { it } from '@effect/vitest'`; `describe`/`expect` stay on `vitest`) with `Effect.gen` + `yield*` instead of `await Effect.runPromise(...)`; rejection assertions use `Effect.flip` or `Effect.exit` plus `expect`. `it.effect` provides a `TestContext` whose clock starts at 0, so tests that depend on real time (real sleeps, polling loops, subprocess or network timeouts) use `it.live` instead. Keep `Effect.runPromise` only in hooks and non-test helpers. Inside `it.effect`/`it.live`, cleanup goes through `Effect.addFinalizer` or `Effect.acquireRelease` (the tester already provides a `Scope`), never `try/finally` around `yield*`: Effect's generator driver does not resume the generator's `finally` after a failed yield. Exemplar: `src/test-kernel/tools/Cancellation.vitest.ts`.

- **`expect` and `node:assert` are both supported.** New `src/test-kernel/` suites use Vitest `expect`. Existing `node:assert` suites stay as they are; convert only in a dedicated mechanical PR (one file or directory, no behavior changes) using the strict mapping: `assert.equal` to `toBe`, `assert.deepEqual` to `toStrictEqual` (never `toEqual`), `assert.ok` to `toBeTruthy()`. `shared/stateSettings.vitest.ts` keeps `node:assert` for its per-key message argument.

## Documentation

- Documentation lives in `docs/` as Markdown; follow existing heading levels and keep lines under 120 characters.

## Branching

- Changes land on `main` through pull requests, one feature branch per change.
- `.github/PULL_REQUEST_TEMPLATE.md` requires `## Net elements (R6)` and
  `## Consumer counts (R8)` sections on any `refactor:` / `simplify:` /
  `consolidate` / `dedupe` / `extract` PR — see the review checklist § 14.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first. If `effect-solutions`
is not installed (the repository does not provision it), consult the pinned
package sources and types in `node_modules/effect`. Effect is v4; v3 material
may differ from the installed version.

<!-- effect-solutions:end -->
