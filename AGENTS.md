# Repository Guidelines: TeXRA

This document sets the common conventions for contributions. Follow these norms when working anywhere in this repository.

## Folder-scoped guides

This file holds the rules every change needs. Material for one subtree lives in a
nested `AGENTS.md`; read it before working there:

- [`src/test-kernel/AGENTS.md`](src/test-kernel/AGENTS.md): test tiers, writing tests, fixtures and fakes.
- [`packages/harness/AGENTS.md`](packages/harness/AGENTS.md): config and storage access, agent execution, run
  loop, tool input schemas, storage format, core quality.
- [`packages/texra/AGENTS.md`](packages/texra/AGENTS.md): the UI toolkit.
- [`packages/extension/src/AGENTS.md`](packages/extension/src/AGENTS.md): webviews, error surfacing.

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
     test run" in `src/test-kernel/AGENTS.md`). Run the full suite with `npm test` before opening a
     pull request.
4. Commit only when `npm run lint` completes without errors.

### Build system: esbuild + Vite

The extension host is bundled with esbuild and the webviews with Vite
(`compile:fast`, `watch:fast`, `package:fast`, `build:fast`). Both only strip
TypeScript types, so a build never catches a type error: run `npm run typecheck`
or the `:safe` variants (`compile:safe`, `package:safe`, `build:safe`), which
type check first. CI always runs `typecheck`.

`npm run typecheck` composes independently runnable checks:
`typecheck:workspace`, `typecheck:test-kernel`, `typecheck:harness`,
`typecheck:llm`, `typecheck:cli`, `typecheck:trace-viewer`, and
`typecheck:desktop`. Run the affected ones while developing and the full command
before committing. `typecheck:harness` performs the complete harness-package build
and regenerates `packages/harness/dist/`. There is no `typecheck:extension`: the
root `tsconfig.json` already includes `packages/extension/src/**`. Use
`build:initial` to validate a full initial build (desktop app and VSIX).

## Commit messages

- Use the [Conventional Commits](https://www.conventionalcommits.org) style such as `fix:`, `feat:`, or `docs:`.
- Keep the summary short (under 72 characters) and written in the present tense.
- Provide additional context in the body when needed.

## Coding style

- TypeScript code in `packages/*/src/` and the test suite targets ES2022.
- Use the provided ESLint configuration (`eslint.config.mjs`) and Prettier settings (`.prettierrc`). Run `npm run format` before committing. `import/order` and `no-nested-ternary` are enforced at error level.
- Prefer `const` and `let` over `var`.
- Group imports by source and prefix each block with a descriptive comment (e.g., `// Third-party imports`, `// Local imports - component`).
- Use the path aliases defined in `tsconfig.json` (for example `@frontend/*`, `@common/*`, `@utils/*`) instead of long relative import chains.
- Document functions with concise comments. Use JSDoc style for public APIs.
- Keep functions small and focused; extract helpers or modules when logic becomes complex.
- Place a host's own request handling beside the view it serves (e.g. `packages/extension/src/progressView/extensionHostRequests.ts`, `packages/desktop/src/main/desktopHostRequests.ts`); host-neutral session bridging lives under `packages/harness/src/controllers/session/`.

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

- Package directories: the nested guides' "Directory organization" (see "Folder-scoped guides").

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

How to write the tests that do earn a place: `src/test-kernel/AGENTS.md`
"Writing tests that earn a place".

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

Union branches, `nullishWithDefault`, and designing for the model's first call:
`packages/harness/AGENTS.md` "Tool input schemas".

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
build fails loudly at the parse boundary (#12359). The session database's format stamp and row versions:
`packages/harness/AGENTS.md` "Storage format".

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

1. **Never import `vscode` in VS Code-free zones.** See CLAUDE.md "Separation of concerns: VS Code coupling" for the full list. The key ones: `packages/harness/src/agent/`, `packages/harness/src/model/`, `packages/harness/src/tools/`, `packages/harness/src/controllers/`, `packages/harness/src/shared/`, and the whole app, `packages/texra/src/`. Do not add new `@agent/*` imports under `packages/harness/src/shared/` or `packages/texra/src/ui/`; host-neutral orchestration belongs under `packages/harness/src/controllers/`.

2. **Use platform-agnostic helpers instead of VS Code types:**
   - `isFile(type)` / `isDirectory(type)` from `@utils/files/fsEntryType` — not `vscode.FileType.File` / `vscode.FileType.Directory`
   - `isFileNotFoundError(err)` from `@common/errors` — not `instanceof vscode.FileSystemError`
   - Use `number` for file type annotations instead of `vscode.FileType` — the numeric values are compatible

3. **Push UI side-effects to the caller.** Business logic functions should return error information (result objects, thrown errors) instead of calling `vscode.window.show*Message()` directly. The command/frontend layer handles user-facing notifications.

4. **Read host capabilities from the Context service that owns them.** When agnostic code needs something only the host provides (e.g., whether an editor extension is installed), take it from the typed service the composition root provides once per process (`SetupPlatform.extensions?.isInstalled`, `Secrets`, `AppState`, the Effect-native `FileSystem`/`Path`). There is no `Platform` object to add a field to; a process fact has one home, the service the runtime serves.

5. **Prefer the session's own `roots.workspace` over `vscode.workspace.workspaceFolders`.** Carry it as data from the caller that holds it (a run's `session.roots`, a tool's `ToolContext.env.roots`); inside Effect, take it from the `WorkspaceFs` service, whose `root` is the same value. There is no ambient fallback: code that cannot name a caller holding the root has an owner to thread it from, not a helper to reach for.

### Patterns across the codebase

Config and storage access, agent execution, the run loop, webviews: see "Folder-scoped guides".

**Logging and telemetry**

- Log with `Effect.log*` and name the channel with `withLogChannel` (`@logger/effectLog`). Only a synchronous publication point with no fiber (the trace emitter, pre-runtime and shutdown paths) writes `writeLogEntry` from `@logger/logSink` directly. Agent flows should use `AgentTrace` (`@agent/trace`) to get grouped output and tool-use aware channels.
- Always pass structured payloads as raw `data` (`Effect.annotateLogs({ data })`) (file lists, missing outputs, latexdiff results, usage statistics) so the progress view can render rich entries without custom parsing.
- Publish runtime progress through session events and `SessionHandle.interactions.emit`; keep non-agent logs on the shared `TeXRA` output channel.

### Prompt and agent files

These rules cover every prompt the repo ships: bundled agents in
`packages/extension/resources/agents/`, plugin agents, templates, skills, and
the workflow prompts in `.github/prompts/`.

- Prompts use general behavioral rubrics, never an identifiable person's name,
  private writing samples, voice or style calibration, feedback transcripts,
  biography, or account metadata.
- Public examples are synthetic, or have documented consent and a compatible
  license.
- User content, retrieved documents, model output, credentials, and account
  state are runtime inputs; never commit them as prompt fixtures.
- A prompt change is reviewed as the final resolved prompt, with representative
  behavior checks, not only a YAML or Markdown syntax check.

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

- **The core holds the pi bar, shrink-only.** What `npm run check:core-quality` holds in the harness and llm cores (`CORE_QUALITY_DIRS` in `eslint.config.mjs`) is in `packages/harness/AGENTS.md` "Core quality".

- **No convenience barrels.** A barrel/index re-export file exists only for a documented public surface (for example, the trace events SDK contract, which declares its surface in its own docstring). Everything else imports the file that defines the symbol. Nothing has a re-export shim.

- **Never hand out a shared mutable literal.** A module-level object that a function returns, or that crosses a module boundary, must be frozen (`as const` plus `Object.freeze`) or produced fresh by a factory. `Object.freeze` is shallow: for nested objects/arrays or a `Map`/`Set`, deep-freeze or use a factory.

- **Global registration requires a global consumer.** Register something globally (components, commands, providers) only when an external surface references it; internal-only consumers import locally.

- **No bare module-level mutable singletons in tested code.** State that tests need to isolate belongs behind an injectable, resettable handle.

- **Serialize asynchronous work through Effect.** Use Effect concurrency primitives or `withPerKeyLane` (`packages/harness/src/utils/core/perKeyQueue.ts`) when operations must run one at a time per key. Resource ownership must be released on success, failure, and interruption. Do not hand-write Promise chains for it; follow the TeXRA 1.0 direction above.

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
