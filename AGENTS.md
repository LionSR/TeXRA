# TeXRA repository guide

TeXRA is an AI theorist that helps academics with writing, research, and
document processing using LLMs. It ships as a VS Code extension, an Electron
desktop app, and a terminal CLI (`texra`): three hosts over one host-agnostic
core. This file holds the rules every change needs and what the tree won't tell
you. `CLAUDE.md` only imports it.

Read the nested guide before working in its subtree:

- [`packages/harness/AGENTS.md`](packages/harness/AGENTS.md): config and storage
  access, agent execution, the run loop, event channels, storage format, core
  quality, tool input schemas.
- [`packages/texra/AGENTS.md`](packages/texra/AGENTS.md): the app and its UI
  toolkit.
- [`packages/extension/src/AGENTS.md`](packages/extension/src/AGENTS.md):
  webviews, error surfacing.
- [`src/test-kernel/AGENTS.md`](src/test-kernel/AGENTS.md): the testing budget
  in full, test tiers, fixtures and fakes. Its live-LLM, journeys and E2E rules
  also bind `packages/llm` and `packages/desktop/tests/e2e`.

## Commands

```bash
corepack pnpm install
npm run compile:fast      # build (esbuild + Vite); watch:fast, package:fast, build:fast
npm run typecheck         # builds do NOT type check, see below
npm run gate              # the static CI jobs: invariants, typecheck + format, lint
npm run test:watch        # while editing: reruns what a save reaches
npm run test:changed      # before a commit: suites reachable from uncommitted edits
npm run test:pure         # before a push (~30s): the shared-registry tier and the architecture ratchets
npm test                  # before opening a PR: the full suite, minutes long
npm run format
npm run lint
npm run check:dead-code-ratchet
npm run hooks:install     # optional pre-commit hooks (needs `pip install pre-commit`)
```

**Builds don't type check.** esbuild and Vite only strip types. Run
`npm run typecheck` (or a `:safe` variant: `compile:safe`, `package:safe`,
`build:safe`) before committing; this is the most common way a change lands
broken. `typecheck` composes `typecheck:{workspace,test-kernel,harness,llm,cli,trace-viewer,desktop}`;
run the affected ones while developing. `typecheck:harness` is the full harness
build and regenerates `packages/harness/dist/`. `build:initial` validates a
full initial build (desktop app and VSIX).

The pre-commit hook (`scripts/format-staged.mjs`) formats and stages what you
staged, and never overwrites unstaged edits: when they overlap the reformat it
keeps the working-tree copy and asks you to run `npm run format` after the
commit. Use `git add -p` for a partially staged file, and re-run
`npm run hooks:install` after any manual `pre-commit install`.

Commits use [Conventional Commits](https://www.conventionalcommits.org)
(`fix:`, `feat:`, `docs:`), a present-tense summary under 72 characters. Changes
land on `main` through one PR per change; a `refactor:` / `simplify:` /
`consolidate` / `dedupe` / `extract` PR fills the `## Net elements (R6)` and
`## Consumer counts (R8)` sections of `.github/PULL_REQUEST_TEMPLATE.md`.

## TeXRA 1.0 direction

TeXRA 1.0 is the next release generation, developed on `main` with breaking
changes to the application and its stored state (not yet shipped).
`release/0.40` carries focused fixes under the released contracts.

- **Terminology.** Say **project** for the user's working unit (papers, code,
  data, other materials) and **paper** only for an actual scholarly document.
  Rename `paper` identifiers when their interfaces are revised.
- **SQLite is the authoritative store** for persistent application state. Do
  not import or migrate the legacy JSON store, histories, or checkpoints, and
  never delete existing user data: initialize new state beside it. Research
  files stay ordinary files; JSON is fine for configuration, interchange and
  export.
- **Effect-native.** Asynchronous logic is Effect services, layers, scoped
  resources, typed errors and structured concurrency, run only at the host,
  tool and SDK boundaries. Pure computation stays plain TypeScript. Don't
  preserve Promise-based orchestration or add adapters to keep an old internal
  interface.
- **Use the supported stack first.** Effect, SQLite, Node and the host APIs
  already cover concurrency, resource lifetime, retries, streams, storage and
  files; check their actual APIs before writing infrastructure. Preserving an
  old internal interface is not a requirement.

### Compatibility and format retirement

1.0 keeps no compatibility with earlier persisted data, config shapes, agent
YAML fields, or flags. Add no legacy readers, aliases, migrations, dual-format
unions, or compatibility writers; delete existing ones on sight, with their
schemas, fixtures and tests. The only exceptions are formats with consumers
outside TeXRA and wire protocols TeXRA still supports: normalize those once at
the boundary and reject anything else with a clear error. `trace.json` is not
an exception: a document from an older build fails loudly at parse (#12359).
`config.json` is additive-only from 1.0: a key may be added, and a released key
keeps its meaning. The session database's format stamp and row versions:
`packages/harness/AGENTS.md` "Storage format".

## Layout

A pnpm workspace in three layers (design:
`.agents/docs/implemented/architecture/2026-10-02-harness-package-split.md`):

- `packages/harness/src` (`@texra-ai/harness`): the Effect-only harness and SDK
  surface, built and releasable at 0.x. There is no `@texra/core`.
- `packages/texra/src` (`@texra-ai/texra`): the app: TeXRA's plugins, LaTeX,
  the UI kit (`@ui/*`) and the host-side controllers.
- `packages/llm`: model access.
- `packages/extension`, `packages/desktop`, `packages/cli`,
  `packages/trace-viewer`: hosts and apps over them.
- Repo-root `src/` holds only the test suite (`src/test-kernel/`);
  `src/README.md` maps the tree.

Use the path aliases in `tsconfig.json` instead of relative chains. Harness
aliases (`@agent/*`, `@platform/*`, `@common/*`, `@utils/*`, …) point into
`packages/harness/src`; `@texra/*`, `@latex/*`, `@replacement/*`,
`@telemetry/*`, `@housekeeping/*` and `@ui/*` point into the app. Inside
`packages/harness/src` (an ESM package) a relative import names its `.js` file.

**The harness boundary is frozen, not open.** The app and hosts reach the
harness only through `@texra-ai/harness` and its subpaths (`/node`, `/plugins`,
`/schemas`, `/transcript`); a host holds the `LocalSession` that
`Sessions.open` returns. The harness imports nothing from the app
(`HARNESS_NO_APP_IMPORT_PATTERNS` in `eslint.config.mjs`), and harness, app and
llm import no host layer. ESLint also fails:

- an `Effect.run*` call outside `packages/{extension,desktop,cli}/src/` and
  the named runtime entries (`EFFECT_RUN_ENTRIES`); the SDK's entry files run
  nothing;
- `new AbortController()` outside its two permanent residents;
- in the core (`CORE_QUALITY_DIRS`), `new Promise`, `.then(` and `any`, with
  no disable comment honored;
- any `@adapter-until` marker: there are no temporary adapters.

The ratchets in `config/ratchets/` freeze the remaining edges. **Never widen a
baseline**; a decrease is always welcome. `harness-deep-import-baseline` admits
no new harness-internal specifier (`@agent/*`, `@shared/*`, `@platform/*`, …)
from the app or a host, type-only included. `row-readers-baseline.json` lists,
per session row type, the files that read it outside its reducers;
`factOwnerRatchet.vitest.ts` fails a new reader and a second writer of a fact
in its `OWNERS` table (shrink the list with
`npx vitest run src/test-kernel/architecture/factOwnerRatchet.vitest.ts -u`).
`refuted-candidates.json` records refactors investigated and refused; landing
one on new evidence rewrites its entry in the same PR. Other invariants are
hardcoded tests under `src/test-kernel/architecture/`, e.g.
`sharedSchemasDeepImportRatchet.vitest.ts` (no `@shared/schemas/<leaf>`
import) and `unknownErrorChannelRatchet.vitest.ts` (below). The open work is
the public surface in
`.agents/docs/proposed/architecture/2026-10-21-harness-general-package-design.md`
and shrinking the frozen lists, not another lint rule. Publishing the harness
and llm packages is the owner's manual step (`releasing` skill).

Where things go:

- `packages/harness/src/shared/` holds wire contracts and UI-shared message
  types; `@ui` (`packages/texra/src/ui/`) is the rendering toolkit over them.
  Neither takes new `@agent/*` imports. Host-neutral app orchestration goes in
  `packages/texra/src/controllers/` (the session bridge in its `session/`); a
  host's own request handling sits beside the view it serves
  (`packages/extension/src/progressView/extensionHostRequests.ts`,
  `packages/desktop/src/main/desktopHostRequests.ts`).
- `packages/harness/src/utils/` is host-agnostic, **not** browser-safe. The
  webview frontends import no `@utils/*` module at runtime; they get path,
  error, text and escaping helpers from `@texra-ai/harness/schemas` and the
  transcript helpers from `@texra-ai/harness/transcript`.
- `packages/harness/src/eventBus/` is `AppSignals` only (auth, subscriptions,
  credentials, workspace-file writes), not run or session progress.
- Webview base classes are in `packages/extension/src/common/webview/`, not in
  the harness.
- The transcript row model is `packages/harness/src/shared/transcript/`
  (`@shared/transcript`); `packages/harness/src/transcript/` (`@transcript`) is
  run-transcript persistence.

Two wiring points fail silently: a new VS Code command is registered through
`packages/extension/src/commands.ts`, and a new setting is declared in the
settings catalog by its owner (`packages/harness/AGENTS.md` "Configuration,
storage, and workspace files") and shown in the native TeXRA settings view.
`packages/extension/package.json` must not contribute `configuration`
(`scripts/sync-package-contributes.mjs` throws).

## Separation of concerns: VS Code coupling

Core logic must not import `vscode`. Check this first on any diff.

**VS Code-free zones:** `packages/harness/src/`, `packages/texra/src/`,
`packages/llm/src/`, `packages/desktop/src/`, and the webview frontends
`packages/extension/src/progressView/frontend/` and
`packages/extension/src/settingsView/frontend/`. Enforced by
`VSCODE_FREE_ZONE_DIRS` in `eslint.config.mjs`, mirrored in
`src/test-kernel/architecture/dependencyDirection.vitest.ts`; keep both in sync
with this list.

**VS Code-allowed:** `packages/extension/src/extension.ts` (builds its runtime
over `processLayer()` once), `packages/extension/src/commands/`,
`packages/extension/src/frontend/` (the extension-host frontend, not a webview),
`packages/extension/src/common/` (not the harness's `common/`), and the view
providers in `packages/extension/src/{progressView,settingsView}/` outside
their `frontend/`.

- Reach process services (`AgentDirectories`, `AppState`, `Secrets`,
  `FileSystem`, `SetupPlatform`, …) from the Effect context the process
  runtime serves, and per-workspace ones from the `WorkspaceRoots` the caller
  holds. When agnostic code needs a host-only capability, add a typed port
  served by that runtime, not an import or a field on a `Platform` object.
- Use the Effect `FileSystem` (`stat(...).type`), not `vscode.FileType`, and
  `isFileNotFoundError` (`@common/errors/errorPredicates`), not
  `vscode.FileSystemError`.
- Return errors to the caller; the command or frontend layer shows the message.
- Carry the workspace root as data from its holder (a run's `session.roots`, a
  tool's `ToolContext.env.roots`, the `WorkspaceFs` service), never
  `vscode.workspace.workspaceFolders`. There is no ambient fallback.

## Agent system

The harness's `packages/harness/src/agent/` holds the domain model (`core/`,
see its README) and the runtime. A run is one Effect program
(`runtime/loop/toolUse.ts`) that appends rows to the run history and continues
from the `RunState` each append returns; resume is the same function over the
same rows. There is no flow engine: do not add a node, a cursor, a services
bag, or a second writer of the run history. Every model call goes through
`runtime/ModelInvoker.ts` and the `packages/llm` `Model` bound by
`runtime/modelAccess/ModelAccess.ts`, and retries in the one loop in
`runtime/run/invocation.ts`.

Launch runs with `session.runs.launch({ request, options })` (requires the
composition root's `SessionOwner`) and resume with `resumeRun`; call
`executeAgent` only when you already own the `runId`. Run-loop rules, write
points, and the event and card channels: `packages/harness/AGENTS.md`.

Agents are flat persona YAML (`name`, `description`, `prompt`, `tools`,
`temperature`) in `packages/extension/resources/agents/`, created with the
built-in `creator` agent or the settings view's Agents tab. A plugin may own
one block of an agent file (`Plugin.agentBlock`); the documents plugin's
`task:` block (`packages/texra/src/tools/documents/documentTask.ts`) makes an
agent a document task, run by `packages/texra/src/agent/output/documentRecipe.ts`.

**Prompts** (bundled agents, plugin agents, templates, skills,
`.github/prompts/`) use general behavioral rubrics: never an identifiable
person's name, writing samples, voice calibration, or account metadata. Public
examples are synthetic or licensed with consent; user content, model output and
credentials never become fixtures. Review a prompt change as the final resolved
prompt with representative behavior checks.

## Effect

Effect is v4; v3 material often differs. Check the installed sources and types
in `node_modules/effect` instead of guessing a pattern.

- **Forward a captured context only through `Context.pick`.**
  `Effect.context<T>()` returns the whole fiber context; re-providing it
  shadows every more specific provision inside. Prefer `yield*`-ing the
  services you need; when a context must travel, `Context.pick(A, B)(ctx)`
  (`tools/liveTools.ts`).
- **A service with a sensible default is a `Context.Reference`**, never a
  hand-provided null (`RunCall`, `ChildRuns`).
- **Serialize async work through Effect** (concurrency primitives, or
  `withPerKeyLane` in `packages/harness/src/utils/core/perKeyQueue.ts` for one
  at a time per key), never a hand-written promise chain. Release resources on
  success, failure and interruption.
- **No `unknown` error channel** (`unknownErrorChannelRatchet.vitest.ts`). Type
  it with the tagged error the path raises, or `Error` for a port whose hosts
  fail differently. Turn a foreign rejection into an `Error` at its boundary
  with `ensureError` (`@utils/errors/errorMessage`), never a `(e) => e`
  pass-through and never the thunk form `Effect.try(() => …)` /
  `Effect.tryPromise(() => …)`, whose `UnknownError` hides the message.
- **Errors**: surface each once and let it propagate to that handler.
  `@common/errors/*` classifies (`classifyAgentError`, the `sdkError/` leaves,
  `errorPredicates`; no barrel); `@utils/errors/errorMessage` narrows `unknown`
  (`toErrorMessage`, `ensureError`, `formatError`) and is browser-safe.
- **Logging**: `Effect.log*` with `withLogChannel` (`@logger/effectLog`), and
  structured payloads as `Effect.annotateLogs({ data })` so the progress view
  renders them. Agent flows log through `AgentTrace` (`@agent/trace`); only a
  fiberless publication point writes `writeLogEntry` (`@logger/logSink`).

## Effect Schema Patterns

Schemas are Effect Schema (`import { Schema } from 'effect'`) and the single
source of truth. Zod is gone (ruled 2026-10-24); do not add it back for any
shape. Normalize external input once at the boundary; downstream code never
branches on format version.

- Derive types: `typeof S.Type` (decoded), `typeof S.Encoded` (stored or wire).
  Compose with `S.mapFields(Struct.assign/pick/omit)` or `...S.fields`. A union
  is `Schema.Union([...])` of literal-discriminated structs; `Schema.TaggedUnion`
  for `_tag`. `Schema.declare<T>(guard)` only for an external SDK type, with a
  comment saying why.
- Pass a schema as `Schema.Codec<T, unknown>` when it decodes unknown input,
  `Schema.Codec<T>` only when both forms match, or `<S extends Schema.Top>`
  when the caller's type is wanted back; never `Schema.Top` for something a
  caller decodes with.
- Decode with `Schema.decodeUnknownEffect` in Effect code,
  `decodeUnknownResult` at a sync boundary that handles failure,
  `decodeUnknownSync` where failure is a defect. The error `message` is the
  rendered issue tree.
- Checks are `.check(...)`: `Schema.isMinLength(n)`, `isPattern(re)`,
  `isBetween({ minimum, maximum })`, `isUUID()`, …; a custom one is
  `Schema.makeFilter(predicate, { message })` (wrap a predicate with optional
  parameters: `(v) => pred(v)`). A literal subset is `Lit.pick([...])`; JSON is
  `Schema.JsonObject` / `Schema.Json`.
- `Schema.optional(S)` is absent or `undefined`, `optionalKey(S)` absent only,
  `NullOr(S)` adds `null`. Accept a database null with
  `Schema.optional(Schema.NullOr(S))` and normalize to `undefined`.
- Structs ignore undeclared keys. Refuse them with
  `{ onExcessProperty: 'error' }` at the one site that must; keep them with
  `Schema.StructWithRest`.
- Transformations: `S.pipe(Schema.decodeTo(Target, { decode, encode }))` with
  `SchemaGetter.transform` (present values), `transformOptional` (fills an
  absent key) or `transformEffect` (can fail with
  `SchemaIssue.InvalidValue`). Decode-only (`SchemaGetter.forbidden` encode) is
  allowed only at a provider boundary. An `.annotate({ description })` after
  `decodeTo` or a default lands on the decoded side and misses the JSON Schema;
  annotate the encoded layer first.
- Errors are `Schema.TaggedError` with schema fields (`cause: Schema.Defect()`).

**Defaults are not interchangeable.** `withDecodingDefault` substitutes for an
absent field before decoding, `withDecodingDefaultType` fills it with a decoded
value, and `catchDecoding` swallows any decoding failure, including a missing
required field. On security, accounting, lifecycle and persisted data, use a
default only for a documented absent field and let malformed values fail:
`catchDecoding` there turns corruption into a silent default, and permanent data
loss once that value feeds a whole-file write. It is fine on non-authoritative
view state.

**Tool input schemas.** An optional field is `Schema.optional(Schema.NullOr(S))`,
not `Schema.optional(S)`: OpenAI-compatible APIs (DeepSeek, Kimi, …) require
optional fields to be nullable. Test with `== null`, coalesce with
`?? undefined`. Numbers are `Schema.Finite` or `Schema.Int`, never
`Schema.Number` (its JSON Schema admits `"NaN"` and drops checks). The model's
JSON Schema comes from `packages/harness/src/agent/core/tools/toolSchema.ts`.
Decode with `{ errors: 'all' }`. Union branches and defaults:
`packages/harness/AGENTS.md` "Tool input schemas".

## Design guardrails

- **Modern, scalable, not over-engineered (owner rule).** Use what SQLite and
  Effect provide instead of a hand-written version. Prefer shapes that keep
  working as data grows: content addressing, a version per record kind,
  projections rebuilt from history, one owner per fact. Then write the fewest
  lines that do the job; build nothing speculative. Trust data from code you
  control and validate only at real boundaries.
- **Find the design problem.** Reduce change amplification and cognitive load
  before adding features, deepen shallow modules, and aim for the structure you
  would have designed with the change in mind. When a hotspot is too complex,
  look for the data structure, duplicated fact or misplaced owner behind it;
  never split a file mechanically.
- **Flattening abstraction layers.** Entry points run the loop program
  directly. Inline a wrapper that only creates state, runs a program and
  interprets results. Import from the defining module; leave no re-export
  shims. No convenience barrels: an index file exists only for a documented
  public surface.
- **Discouraged factory patterns.** A factory needs multiple callers, real
  logic, class construction, or captured context; inline a `buildX` called only
  from `createX` and replace an identity factory with a literal. Grep the
  caller count before adding a shared helper: single-caller extractions are
  banned (narrowing an export surface to one entry point is not one). New
  ports, facades and template methods delete what they replace in the same PR.
- **Exports are contracts.** Default to file-local; a new export needs a
  consumer in the same PR (`npm run check:dead-code-ratchet` against
  `config/ratchets/knip-baseline.json`).
- **Silent degradation is a defect.** A fallback that masks a failure logs the
  cause at `warn` and surfaces it, or does not exist. `catch {}`, `??` over a
  failed read, `catchDecoding` on persisted data and a `default: return` that
  drops an unknown event all hide bugs. Accepted exceptions: §15 of
  `.claude/skills/code-review/references/review-checklist.md`.
- **No shared mutable state.** A module-level object that is returned or
  crosses a module boundary is deep-frozen or built fresh by a factory. State
  tests must isolate sits behind an injectable, resettable handle. Register
  something globally only when an external surface references it.
- **UI anti-patterns.** Never compensate for data-model problems at render
  time (no `Date.now()`, synthetic IDs, DOM existence checks or dedup in
  renderers); fix the data upstream. One home per user action: secondary
  surfaces show read-only status, not a second control (exceptions: a global
  default versus a per-item override, or one command plus one UI button).

### Plain names and comments

Name things for what they do in ordinary programming English, and write
comments for a reader who has read the code but none of the planning docs.

| Avoid                       | Write instead                                     |
| --------------------------- | ------------------------------------------------- |
| fold (as a noun), folded    | update, apply, rebuild; applied                   |
| park, parked                | wait, waiting, blocked                            |
| settle, settled, settlement | finish, finished, result (name which result)      |
| admit, admission            | accept, start, requires                           |
| arm (of a union or a fold)  | case, branch, handler                             |
| move, grammar, transition   | outcome, handlers, next step                      |
| tombstone, hydration        | deletion marker, initial load                     |
| seam, plane, ledger, spine  | boundary, layer, record, the specific module name |
| refusal (our own rejection) | rejection, error (a model refusing stays refusal) |

Documented API names (`withPerKeyLane`, `SessionEvents`) keep their names, and
persisted or wire strings (row and event `type` literals, `_tag`s, settings
keys, command ids) keep their spelling: renaming them is a format change. Grep a
word before giving it a new meaning. No document citations in code (`5.2`,
`D5`, "ruled", "owner rule"): state the reason. A false comment is a bug; fix
it in the commit that changes the behavior.

## Testing discipline

Tests are a budget, not proof of work: internal interfaces here break often by
design, and a test pinned to one is merge friction. The default for a PR is
**zero new tests**. A refactor adds none; a bug fix gets at most one regression
test, written to fail first; a feature gets E2E coverage ending in a verifiable
artifact. Never write unit tests after the code: an isolated test starts from a
written list of failure modes. Extend existing suites, and don't ask for tests
in review beyond this bar. Full rules: `src/test-kernel/AGENTS.md`.

## Code style

ESLint (`eslint.config.mjs`) and Prettier enforce most style. Beyond them:

- Group imports by source, each block under a comment
  (`// Third-party imports`, `// Local imports - component`).
- PascalCase for service singletons (`SessionEvents`, `ModelInvoker`),
  camelCase for function namespaces (`latexCommands`), `UPPER_SNAKE_CASE` for
  constants. JSDoc on public APIs.
- The target is ES2022 with the ES2024 library. Use `.at()`, `Object.hasOwn()`,
  `.flatMap()`, `.replaceAll()`, `.toSorted()` / `.toReversed()` /
  `.findLast()` (spread a Set or Map first), `.slice()` over `.substring()`,
  `for...of` with `.entries()`, `Number.parseInt(v, 10)`, the `node:` prefix,
  `node:timers/promises` for sleeps, and `?? false` over `|| false`. Index
  loops stay where the index is the point: variable-stride token consumers,
  queues that grow mid-loop, and `charCodeAt(i)` hash loops (`for...of` walks
  code points and would change persisted hashes).

## Docs

`docs/guide/` and a few root docs publish to texra.ai (VitePress); internal
directories are excluded by `docs/.vitepress/publicDocs.js`. A new file at the
`docs/` root can silently freeze the deploy: check that allowlist and
`docs/scripts/check-root-docs.mjs` first. PRDs and proposals live under
`.agents/docs/` (`.agents/docs/README.md`). Every repo path cited in guidance
must exist (`npm run check:guidance-refs`). Changelog rules: the `releasing`
skill.

## Skills

- **code-review**: `/review` and any review of this repo; always include a
  `Verified` section.
- **find-simplification**: deletion and collapse candidates, recorded as dated
  proposals or tech-debt issues.
- **texra-cli**: the Ink TUI, transcript rendering, headless output, CLI flags
  and help.
- **releasing**: changelog, tags, GitHub Releases, desktop installers, npm
  packages.
