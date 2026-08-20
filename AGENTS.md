# Repository Guidelines: TeXRA

This document sets the common conventions for contributions. Follow these norms when working anywhere in this repository.

## Changelog Guidelines

When updating CHANGELOG.md:

- Focus on user-visible features and bug fixes
- Use clear, concise language that end users can understand
- Group changes into Features, Bug Fixes, and (rarely) Breaking Changes
- Describe the net difference from the previous released version, not the
  sequence of commits made during development
- Do not include defects that were introduced and fixed before the release;
  intermediate implementation states are not release changes
- Do not expose internal architecture, protocol names, schemas, codenames, or
  implementation mechanics; describe the effect in product terms
- Exclude refactors, tests, dependency maintenance, and other changes with no
  user-visible effect

## Development workflow

1. **Install dependencies**: run `corepack pnpm install` if needed.
2. **Install the local hooks (recommended)**: install `pre-commit` with
   `python -m pip install pre-commit`, then run `npm run hooks:install`. That
   runs `pre-commit install` and chains a git hook (`scripts/format-staged.mjs`)
   ahead of it which stages Prettier's output automatically: when staged
   content needs formatting, the hook formats the staged blob, stages the
   result, and folds the same formatting into the working tree, so the commit
   proceeds without a manual re-stage. Unstaged edits are never overwritten --
   if Prettier's rewrite overlaps them, the hook keeps the working-tree copy
   and prints a notice to run `npm run format` after committing to sync.
   Without the chained hook, the `npm-format` pre-commit hook rewrites
   supported staged files and aborts; review the diff and stage only the
   intended hunks before retrying. For a partially staged file, use
   `git add -p` so unrelated unstaged edits stay out. Re-run
   `npm run hooks:install` after any manual `pre-commit install`, which does
   not know about the chained hook.
3. **Run checks before committing**:
   - Format code using `npm run format`.
   - Build the extension bundle with `npm run compile:fast`.
   - Lint TypeScript sources with `npm run lint`.
   - Run the Vitest suite with `npm test`.
4. Commit only when `npm run lint` completes without errors.

### Build system: esbuild + Vite

The extension host is bundled with esbuild and the webviews with Vite (`compile:fast`, `watch:fast`, `package:fast`, and `build:fast`).

**Why the build doesn't catch type errors**: Vite and esbuild only strip TypeScript types without checking them. They treat TypeScript as "JavaScript with type annotations to remove."

**Safe build scripts** run `tsc --noEmit` before building to catch type errors:

| Script                 | Description              |
| ---------------------- | ------------------------ |
| `npm run typecheck`    | Standalone type checking |
| `npm run compile:safe` | typecheck + compile:fast |
| `npm run package:safe` | typecheck + package:fast |
| `npm run build:safe`   | typecheck + build:fast   |

The full `npm run typecheck` command composes independently runnable checks:
`typecheck:workspace`, `typecheck:test-kernel`, `typecheck:agent`,
`typecheck:cli`, `typecheck:trace-viewer`, and `typecheck:desktop`. During
development, run the checks for the affected parts; before committing, run the
full command. Unlike the other targeted commands, `typecheck:agent` performs the
complete agent-package build and regenerates `packages/agent/dist/`.

There is deliberately no `typecheck:extension`: the root `tsconfig.json` already
includes `packages/extension/src/**`, so `typecheck:workspace` compiles the
extension sources — a separate extension-scoped `tsc` run checked a strict
subset of the same files under the same options.

**Recommended workflow**:

- Use `compile:fast` during development for speed
- Use `compile:safe` before committing to catch type errors
- Use `build:initial` when validating a full initial build because it builds the desktop app and VSIX artifacts
- CI should always run `typecheck` or use safe variants

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
- Keep the directory structure aligned among different webviews (webview, progressView, settingsView). Use the same folder names for modules of the same type and functionality but in different webviews.
- Place view-specific, extension-only manager classes under that view's `managers` folder (e.g. `FileManager.ts` in `packages/extension/src/webview/managers/`). Host-neutral view backend logic instead lives under `src/controllers/<view>/backend/` (e.g. `src/controllers/progressView/backend/LitSessionRenderer.ts`), per the `controllers/` host-neutral-orchestration rule.

### Naming conventions

- **Const object naming**:
  - Use **PascalCase** for service singletons that encapsulate state and behavior (e.g., `StreamStatusService`, `ModelRegistry`)
  - Use **camelCase** for simple command/function namespaces (e.g., `agentCommands`, `latexCommands`)
- **Constants**: Use `UPPER_SNAKE_CASE` for true constants (e.g., `MAX_ERROR_LENGTH`, `STREAM_STATUS`)

### Directory organization

This repository is a pnpm workspace. Repo-root `src/` contains host-agnostic production code and centralized tests for both shared and host-specific behavior,
`packages/extension/` contains the VS Code extension, `packages/desktop/` the Electron shell, `packages/cli/`
the `texra` terminal client, and `packages/trace-viewer/` the standalone trace-viewer web app.
`packages/agent/` is the embeddable SDK surface (`@texra-ai/agent`) — it builds and bundles locally but is
not published to npm, and there is no `@texra/core` workspace package (deleted by #7099). Hosts still reach
shared core through the repo-root path aliases; that surface is frozen rather than open. `eslint.config.mjs`
forbids production `src/**` and `packages/agent/src/**` from importing host layers, and four checked-in
ratchets under `config/ratchets/` freeze the remaining edges: `host-agent-import-baseline.json` (a host may
not add a NEW distinct `@agent/*` deep-import specifier, type-only included), plus the
`shared-schemas-deep-import`, `host-agent-mock`, and `architecture-edges` baselines. Never widen a baseline;
a decrease is always welcome. Kernel architecture tests under
`src/test-kernel/architecture/` (for example
`approvalPolicyAuthorityRatchet.vitest.ts`) pin single-authority invariants with
hardcoded allowlists rather than baseline JSON. The remaining boundary work is the Tier-1 public manifest and shrinking the
frozen deep-import lists, not another lint rule.

- `packages/extension/src/frontend/` contains extension-host utilities that power shared UI flows (agent directories, file listers, instruction banners, tool workflows). Prefer these helpers over duplicating logic in commands or webviews.
  - `frontend/system/` - VS Code command utilities (`safeExecuteCommand`)
  - `frontend/ui/` - Dialog helpers, diff views, message utilities
  - `frontend/editor/` - Active file guards and editor utilities
  - `frontend/agents/` - Agent directory management (`AgentDirectoryManager`)
  - `frontend/files/` - File lister and discovery utilities
  - `frontend/latex/` - LaTeX build integration, linting
  - `frontend/media/` - Image and audio handling
- `src/common/` holds host-neutral, cross-cutting logic with domain meaning (errors, files, parsing, storage, constants), not a backend-only zone. Some browser-adjacent shared code imports dependency-light modules such as `@common/parsing/safeParseJson`; import through the `@common/*` alias and check the target's dependencies before using it from browser code.
- `packages/extension/src/common/` holds extension-only helpers (state managers, webview base classes):
  - `packages/extension/src/common/state/` - State managers including `pendingStateManager`
  - `packages/extension/src/common/webview/` - Base classes (`BaseViewContentProvider`, `BaseViewMessageHandler`), webview HTML builder (`buildWebviewHtml`), command constants
- `src/utils/` holds host-agnostic utilities. A subset of it must additionally stay **browser-safe**, because the webview frontends import it: as of this writing exactly six modules are reachable from `webview/frontend/`, `progressView/frontend/` and `settingsView/frontend/` — `@utils/core`, `@utils/core/boundedIdSet`, `@utils/core/keyedMutex`, `@utils/errors/errorMessage`, `@utils/files/pastedImageName`, `@utils/text/stringUtils`. Those six, and anything they import, must not reach for Node built-ins. There are 65 TypeScript modules under `src/utils/` in the current tree; the other 59 are not browser-reachable today and must not be assumed browser-safe. `scripts/check-browser-safe-utils.mjs` enforces the count and reachable set.

  Do not read this as "everything in `utils/` is shared with the webviews" — it is not, and an earlier version of this line said so incorrectly. What it does mean: if a helper is specific to one side, prefer `frontend/` or `common/`, and if you add an import to one of the six browser-reachable modules, check that it stays browser-safe.
  - `utils/core/` - Async, type-guard, math, comparator, URL, and path-basics primitives (`debounce`, `delay`, `filterNotNull`, `clamp`, `byName`, `tryParseUrl`, `normalizeFilePath`, `getBasename`, `getFileStem`); re-exports string primitives from `utils/text/stringUtils` for browser-safe barrel access
    - `utils/core/boundedIdSet.ts` - `createBoundedIdSet` (LRU-capped `Set<Id>` for "seen id" guards)
    - `utils/core/idHash.ts` - Node-only deterministic execution-ID derivation
    - `utils/core/keyedMutex.ts` - `KeyedMutex` for independently serialized asynchronous work by key
    - `utils/core/pathCore.ts` - sibling Node-only path module
  - `utils/files/` - Filesystem utilities, rules, and vars
  - `utils/config/` - Settings helpers (`getConfig`, `updateConfig`, `watchConfig`)
  - `utils/system/` - Shell command execution (`execUtils`)
  - `utils/text/` - Text, string, and XML processing utilities — the single home for generic string helpers (validation, truncation, duration/token/percent formatting)
  - `src/utils/prompt.ts` - Prompt builder utilities

- `packages/extension/src/commands/` - VS Code commands grouped by domain
- `packages/extension/src/settingsView/` - Unified settings webview combining Memory, History, Models, Agents, Multi-Agent, Tools, AI Agents, Git, LaTeX, and Goal tabs
- `packages/extension/src/progressView/` - Task tracking board webview
- `packages/extension/src/webview/` - Main agent interaction webview
- `packages/extension/resources/` - Packaged agents, tool-use agents, docs, templates, examples, and extension assets
- `src/platform/` - Platform abstraction layer (composition root). Hosts call `initPlatform()` once at startup; agnostic code uses `platform()` from `@platform/platform`.
- `src/hosts/` - Host capability interfaces for clipboard, prompts, terminals, diff views, and openers.
- `src/test-kernel/` - Centralized Vitest suites for shared and host-specific behavior, including extension, desktop, and CLI code.

### Pragmatic implementations

- **Start simple**: Choose the most direct solution that solves the problem. A new abstraction earns its place only when it clearly reduces complexity.
- **Use native constructs**: Rely on JavaScript/TypeScript built-ins (objects, Maps, Sets, arrays), VS Code APIs, and JSON for state. These are well-understood and require no extra code.
- **Trust your inputs**: When data flows from code you control, pass it through directly. Transform or validate only at true system boundaries (user input, external APIs).
- **One error path**: Surface errors once, and let exceptions propagate naturally to that single handler rather than being caught and re-reported at every level. Two modules serve different halves of this and both are correct:
  - `@common/errors` — classification and surfacing: `classifyAgentError`, the SDK-error inspection under `sdkError/`, `errorPredicates`, `errorFormatUtils`. Reach for this when the _kind_ of failure changes what happens next.
  - `@utils/errors/errorMessage` — the three `unknown`-narrowing primitives `toErrorMessage`, `ensureError`, `extractErrorMessage`. This is the most-imported leaf module in the repo (~203 sites) and is browser-safe, which `@common/errors` is not required to be.

  An earlier version of this line named `@common/errors` as the only error path, which is why the distinction is spelled out here.

- **Evolve incrementally**: Improve existing structures in small steps. Rewrite only when there's a documented, concrete benefit.

### Testing discipline

Tests are production maintenance work, and this project breaks internal
interfaces often and on purpose. A test pinned to a seam that is about to churn
is not safety — it is merge friction the next refactor has to pay down. The
default for a PR is **zero new tests**; a test must earn its place — protecting
a consequential current contract, a difficult invariant, or a reproduced
defect — and is never proof of work or PR padding. Concretely:

- A behavior-preserving refactor adds no new tests; the existing suite passing
  is the evidence.
- A bug fix gets at most one regression test that reproduces the defect, at the
  narrowest boundary that exhibits it.
- A new feature gets a small number of behavioral tests at its durable
  boundary — the wire contract, the schema, the user-visible output — not a
  unit test for each internal layer the data passes through.
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

**Type definitions**

- `.int()` instead of `.number().int()` - native integer type
- `.uuid()` instead of `.string().uuid()` - native UUID type
- `.iso.datetime()` instead of `.string().datetime()` - ISO datetime validator
- `.enum(MyEnum)` instead of `.nativeEnum(MyEnum)` - works with TS enums
- `.looseObject({...})` instead of `.object({...}).passthrough()` - allows extra keys
- `.strictObject({...})` - disallows extra keys (use for tool input schemas)

**Validation and refinement**

- `.describe('...')` - add field documentation for tool schemas and types
- `.refine()` / `.superRefine()` - custom validation logic
- `.nullable()` - accept null (distinct from `.nullish()` which accepts null OR undefined)
- `.nonnegative()` / `.positive()` - numeric constraints
- `.regex()` - pattern matching for strings
- `.url()` - URL validation
- `.transform()` - value transformation after validation
- `.custom<T>()` - use sparingly for external SDK types with explanatory comments

**Default values**

- `.prefault(val)` - Substitutes for `undefined` BEFORE validation and transforms; use for documented absent-input defaults, including legacy omissions
- `.default(val)` - Returns a valid output default for `undefined` without parsing that default
- `.catch(val)` - Substitutes after a validation error; use only where malformed present data may be discarded by policy

Preserve the distinction between absent and invalid present data. In security,
accounting, lifecycle, and durable-state schemas, use `.prefault(...)` only for
documented absent fields with explicit product or compatibility meaning, and let
malformed present values fail validation. Do not use `.catch(...)` to turn
corruption or contract drift into an ordinary default.
An absent required field is also a validation error, so `.catch(...)` replaces
missing required data as well as invalid present data.

**When to use each default pattern:**

```typescript
// Deserialization (loading saved state) - use .prefault()
const SnapshotSchema = z.object({
  count: z.int().prefault(0), // normalize missing fields
  items: z.array(z.string()).prefault([]),
});

// Non-authoritative view-state recovery - use .catch() only by policy
const PanelStateSchema = z.object({
  density: z.enum(['compact', 'comfortable']).catch('comfortable'),
});

// Non-authoritative schema-level fallback (all-or-nothing)
const panelState = PanelStateSchema.catch(DEFAULT_PANEL_STATE).parse(data);
```

**Safe parsing with fallback**

```typescript
// Old verbose pattern
const result = PanelStateSchema.safeParse(data);
const legacyPanelState = result.success ? result.data : DEFAULT_PANEL_STATE;

// Zod v4 native
const panelState = PanelStateSchema.catch(DEFAULT_PANEL_STATE).parse(data);
```

**Null handling from databases**

```typescript
// Accept null from DB, normalize to undefined
description: z.string().nullish(),  // null | undefined → undefined
```

**Tool input schemas (IMPORTANT)**

Use `.nullish()` instead of `.optional()` for optional fields in tool input schemas. OpenAI-compatible APIs (DeepSeek, Kimi, etc.) require optional fields to also be nullable for structured output compatibility.

```typescript
// Tool schemas - use .nullish() for API compatibility
const ToolInputSchema = z.strictObject({
  required: z.string(),
  optional: z.string().nullish(), // NOT .optional()
});
```

When checking for missing optional values, use `== null` (not `=== undefined`) to handle both null and undefined:

```typescript
if (input.optional == null) {
  // handles both null and undefined
}
```

When passing nullish tool values to functions expecting `T | undefined` (not `T | null | undefined`), coalesce to undefined:

```typescript
// Function expects string | undefined, but .nullish() gives string | null | undefined
const result = processPath(input.path ?? undefined);
```

See: https://platform.openai.com/docs/guides/structured-outputs

**Design for the model's first call**

Any parameter with an obvious default should be optional with that default applied at dispatch time (`.nullish()` plus a default when the tool runs), not required. A required parameter that models routinely omit is a tool bug, not a model error. When a description string enumerates dispatch behavior (for example, "every command except X"), verify it against the actual dispatch table whenever either changes; the two can drift independently. Evidence: the memory tool once required `path` for `view`, so every fresh session rendered an error card until the model retried; the fix's own description string then misdescribed `rename` until review caught it.

**Compatibility and format retirement**

TeXRA has a short compatibility window. Do not preserve an old internal format
indefinitely merely because a parser or migration already exists.

TeXRA is an early-stage product. Prefer one small, current design over preserving
historical behavior that materially increases maintenance cost. Breaking an old
internal format is acceptable when no current public contract or demonstrated
user need justifies the additional system.

- Compatibility code may be removed three months after the replacement ships.
  Record the introduction date and intended retirement condition beside every
  temporary reader, alias, migration, or compatibility writer.
- The desktop application has not had a public release. Desktop state always
  adopts the current format directly; do not add desktop migration machinery.
- CLI and TUI workflow-agent rosters and workflow-script checkpoints use only
  their current schemas. Do not infer current state from old agent arrays,
  rewrite old agent identifiers, write compatibility mirrors, or translate old
  workflow journal versions.
- New native settings begin with the current defaults. Do not import retired VS
  Code settings or accept parallel prefixed and unprefixed on-disk spellings.
  API helpers may canonicalize a caller-supplied key, but persisted JSON has one
  spelling.
- When a compatibility path is retired, delete its schemas, transforms,
  branches, comments, fixtures, and compatibility-specific tests together. Do
  not add new tests whose only purpose is to preserve a retired format.
- Exceptions require a current public protocol or an explicit retention rule
  for released user data. State the protected surface and retirement condition
  in the code; “backward compatibility” alone is not a justification.

For a format still inside its supported window, normalize it once at the
storage or wire boundary:

- Use `z.union()` with `.transform()` to handle the supported formats.
- Put the current format first in the union.
- Transform older input into one canonical structure.
- Handle compatibility at the entry point using `safeParse`, not scattered
  fallbacks in consumers.
- Downstream code must never branch on the old format version.

```typescript
// Canonical format (new)
const NewFormatSchema = z.object({ revised: OutputFileInfoSchema, ... });

// Legacy format transforms to canonical
const LegacyFormatSchema = z.object({ baseLabel: z.string(), ... })
  .transform((e): NewFormat => ({ /* map to canonical */ }));

// Single entry point handles both
const EntrySchema = z.union([NewFormatSchema, LegacyFormatSchema]);

// Usage: always returns canonical format
const result = EntrySchema.safeParse(raw);
```

### ES2023+ Patterns

Use modern JavaScript features available with ES2022+ target:

```typescript
// Use .at() for negative array indexing
const lastItem = items.at(-1);

// Use Object.hasOwn() instead of hasOwnProperty
if (Object.hasOwn(obj, 'key')) { ... }

// Use .flatMap() for map+flatten
const allItems = groups.flatMap((g) => g.items);

// Use .replaceAll() for global string replacement
const cleaned = text.replaceAll('\r\n', '\n');

// Use optional chaining consistently
abortController?.abort();
if (!runStage?.id) return;

// Use ?? false for boolean coercion (not || false)
const isEnabled = config.enabled ?? false;

// Iterate Sets directly without Array.from()
for (const item of mySet) { ... }

// Import Node builtins with the node: protocol
import * as path from 'node:path';

// Use .toSorted() instead of spread-then-mutate (copies from a Set/Map
// still need the spread first)
const sorted = items.toSorted((a, b) => a.localeCompare(b));

// Use for...of — with .entries() when the index is needed — instead of
// index-based loops; iterator values are non-undefined, so guards and
// non-null assertions on arr[i] disappear
for (const [i, step] of plan.steps.entries()) { ... }

// Use .findLast()/.findLastIndex() or .toReversed() instead of
// backwards index loops
const round = segments.map(parseRound).findLast((r) => r !== null);

// Use .every() for pairwise array comparison instead of manual loops
const equal = a.length === b.length && a.every((x, i) => x === b[i]);

// Use .slice() instead of .substring()
const preview = text.slice(0, 100);

// Use Number.parseInt with an explicit radix instead of bare parseInt
const line = Number.parseInt(value, 10);

// In Node-only code, sleep via node:timers/promises instead of a
// hand-rolled Promise around setTimeout
import { setTimeout as sleep } from 'node:timers/promises';
await sleep(25);
```

Index-based loops are still right when the index itself is the point: token
consumers that advance `i` by a variable stride, queue/BFS loops that append
to the array mid-iteration, and `charCodeAt(i)` hash loops (`for...of` walks
code points, not UTF-16 units, which changes persisted hash output).

### Refactoring for simplicity

Aim for code that looks like it was designed correctly from the start:

- **Use built-in methods**: `Array.isArray()`, optional chaining, and standard library functions handle most cases cleanly.
- **Normalize at the edge**: Convert legacy formats once at load time (Zod schemas work well), then use only the current format everywhere else.
- **Extract only when repeated**: Create a helper when the same logic appears in multiple places—not before.

### Platform decoupling rules

For good separation of concerns and platform independence, core business logic should stay free of host-specific imports. This improves testability and keeps the door open for future reuse outside VS Code.

1. **Never import `vscode` in VS Code-free zones.** See CLAUDE.md "Separation of concerns: VS Code coupling" for the full list. The key ones: `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/controllers/`, `src/shared/`. Do not add new `@agent/*` imports under `src/shared/`; host-neutral orchestration belongs under `src/controllers/`.

2. **Use platform-agnostic helpers instead of VS Code types:**
   - `isFile(type)` / `isDirectory(type)` from `@utils/files/fsEntryType` — not `vscode.FileType.File` / `vscode.FileType.Directory`
   - `isFileNotFoundError(err)` from `@common/errors` — not `instanceof vscode.FileSystemError`
   - Use `number` for file type annotations instead of `vscode.FileType` — the numeric values are compatible

3. **Push UI side-effects to the caller.** Business logic functions should return error information (result objects, thrown errors) instead of calling `vscode.window.show*Message()` directly. The command/frontend layer handles user-facing notifications.

4. **Use `Platform` ports for platform capabilities.** When agnostic code needs something only the host provides (e.g., checking if a VS Code extension is installed), add a typed port to `Platform` (e.g., `toolAvailability.isVscodeExtensionInstalled`) and wire it from the host composition root.

5. **Prefer `WorkspaceFS.getPath()` over `vscode.workspace.workspaceFolders`.** The former is already available and returns the same value.

### Patterns across the codebase

**Configuration, storage, and workspace files**

- Use `getConfig`, `updateConfig`, and `watchConfig` from `@utils/config/configUtils` to read and react to settings changes.
- Interact with the filesystem through `@utils/files` helpers (`WorkspaceFS`, `RelativeFS`, `StorageFS`, `GlobalStorageFS`, `AbsoluteFS`). They resolve workspace paths, manage global storage, and expose cleanup helpers like `RelativeFS.cleanupOldFiles`.
- Generate and identify pasted-image filenames with
  `@utils/files/pastedImageName`. Resolve, validate, and persist their paths
  with `@utils/files/pastedImageUtils` so temporary assets map correctly back
  to storage without pulling Node filesystem code into browser bundles.
- Surface files and agent directories through the shared frontend utilities (`fileLister` in `packages/extension/src/frontend/files/fileLister.ts`, `agentDirectories` in `packages/extension/src/frontend/agents/AgentDirectoryManager.ts`) instead of duplicating discovery logic.

**Logging and telemetry**

- Route logging through `@logger/logUtils`. Agent flows should use `AgentTrace` (`@agent/trace`) to get grouped output and tool-use aware channels.
- Always pass structured payloads via the `data` argument (file lists, missing outputs, latexdiff results, usage statistics) so the progress view can render rich entries without custom parsing.
- Publish runtime progress through session events and `SessionHandle.interactions.emit`; keep non-agent logs on the shared `TeXRA` output channel.

**Agent execution and tool-use**

- Define agents using `AgentDataclass` and `AgentConfig` (`src/agent/core/`) and compose them via the factories in `src/agent/runtime`.
- Launch executions from host code (commands, frontend services, desktop IPC) via `runAgent` (`src/agent/runtime/runAgent.ts`) — it assigns an `executionId`, registers the run in storage, and opens workflow output. Only use the lower-level `executeAgent` when you already own the `executionId` (e.g. subagent dispatch in `src/tools/delegation/DelegationTools.ts` or a resume path). Attach presentation and approval behavior to the run's `SessionHandle.interactions`.
- Resume a persisted tool-use session via `resumeToolUseFromResumeData` (`src/agent/runtime/executeAgent.ts`), not `runAgent`.
- Add new model handlers under `src/agent/modelHandlers/<provider>/` (no barrel — import via the `@agent/modelHandlers/<provider>/<File>` alias, per that directory's `README.md`), and register capabilities/pricing in `src/model/computeModelOptions.ts`.

**PocketFlow architecture**

Agent flows follow the PocketFlow pattern in `src/agent/implementations/flows/`:

- **Flow types**: `runReflectionFlow` for multi-round reflection agents, `runToolUseFlow` for tool-use agents
- **Services** are immutable dependencies injected via `flow.setServices()`. Nodes access them via `this.services`. Define service interfaces in flow-specific files (e.g., `ReflectionServices`, `ToolUseServices`) extending `BaseFlowContextInit` with convenience accessors (`logger`, `context`) defined inline.
- **Shared store** contains only mutable state (memories). Nodes read/write via `prep()` and `post()` methods.
- **Flow transitions** - use named constants instead of magic values:
  - `FlowTransition.DEFAULT` - follow next() successor
  - `FlowTransition.CONTINUE` - loop back to flow entry
  - `FlowTransition.FINALIZE` - exit flow after finalization
  - `FlowTransition.COMPLETE` - return control to caller
- **Node lifecycle**: `prep(shared) → exec(prepRes) → post(shared, prepRes, execRes)`. A failing `exec()` goes to `execFallback(prepRes, error)`, which by default rethrows; override it to convert the failure into something `post()` can route on. Retries are **not** a `BaseNode` feature: the manual-retry loop and its `shouldAutoRetry(error)` / `retryPrompt(prepRes, error)` / `signal` hooks live on `ModelInvocationNode` (`src/agent/core/flows/ModelInvocationNode.ts`), the only node that invokes a model. Do not re-add retry machinery to the kernel for a node that does not call a provider.
- **Agent owns lifecycle**: Agents handle init/finalize; flows handle only execution logic. Nodes should throw errors directly (agent.run() catches).

The engine is local to this repo: `src/agent/node/index.ts` defines `BaseNode`
and `Flow` — read it for the authoritative semantics. It is a trimmed
descendant of upstream PocketFlow and does **not** implement the upstream
`BatchNode`/`BatchFlow`, `ParallelBatchNode`/`ParallelBatchFlow`, or the
`params`/`setParams` channel; do not write code against them. State slices that
travel through the flows are described in `docs/architecture/pocketflow-state.md`.

**Webviews and UI**

- Generate HTML through `BaseViewContentProvider` (`packages/extension/src/common/webview/BaseViewContentProvider.ts`) and its `buildWebviewHtml` helper. Extend `BaseViewMessageHandler` for consistent lifecycle management across views.
- Use Web Awesome (`<wa-icon>` via `waIcon()` from `@shared/wa/webAwesomeIcons`) and shared utilities from `@utils/text/stringUtils` and `@utils/core` (path basics: `normalizeFilePath`, `getBasename`, `getFileStem`) for consistent interactions.
- For webview dependencies, prefer CDN builds (jsdelivr for static assets, esm.sh for ES modules) for complex packages like markdown-it, KaTeX, or highlight.js, while keeping lightweight bundles (split.js) local to reduce extension size.
- Keep CSS modular (per-component styles as TypeScript in each view's `frontend/` directory, shared tokens in `packages/extension/src/common/styles/common.css`) and use Web Awesome icons (e.g., `${waIcon('chevron-down')}`) for toggle affordances.

**Progress view**

- Extend the existing Lit components in `packages/extension/src/progressView/frontend/components/` (`StreamTabs`, `LogList`, `UsagePanel`, `TaskGroupList`, etc.) and the frontend state slices in `packages/extension/src/progressView/frontend/slices/` (`logSlice`, `taskSlice`, `streamLifecycleSlice`, etc., mirroring the `settingsView/frontend/slices/` pattern) — augment them rather than manipulating the DOM directly.
- Tool-use and workflow sessions surface in separate filters; continue emitting usage, status, and log events through the established progress event commands so filters, counts, and badges update automatically.

**Error handling and types**

- Format and surface errors through `logErrorMessage`, `showLoggedErrorMessage`, and `showLoggedMessageWithDocs` in `packages/extension/src/frontend/ui/errorHandlingUtils.ts` for consistent telemetry and documentation links.
- Keep shared type definitions colocated with their domains (e.g., `src/agent/types`) and derive runtime-safe interfaces with `zod` plus `z.infer`.

**Miscellaneous**

- Maintain text cleanup rules in the `src/replacement` modules.
- Execute VS Code commands with `safeExecuteCommand` from `packages/extension/src/frontend/system/commandUtils.ts` and shell commands with `executeCommand` from `src/utils/system/execUtils.ts` so logging and error handling stay uniform.
- Retrieve included file extensions via `getIncludedExtensions` in `src/common/files/fileTypeUtils.ts`.
- Initialize new agent YAML files from the templates in `packages/extension/resources/agents/` and `packages/extension/resources/tool_use_agents/`.
- Dispose event listeners and watchers when webviews close to prevent leaks.
- Prefer enums or discriminated unions over bare booleans in configuration objects.
- Favor debug logs for routine events and reserve info/error levels for notable outcomes.
- Use the helpers in `packages/extension/src/frontend/ui/dialogs.ts` and `packages/extension/src/frontend/ui/instruction.ts` for consistent notification primitives shared across the extension.

### Webview Consistency Patterns

- **Base Classes**: All webviews (webview, progressView, settingsView) extend `BaseViewContentProvider` and `BaseViewMessageHandler` from `packages/extension/src/common/webview/` for consistent error handling, logging, and cleanup.
- **Naming Convention**: Follow `[Domain]View[Component]` pattern (e.g., `MainViewContentProvider`, `SettingsViewMessageHandler`, `ProgressViewContentProvider`)
- **Command Constants**: Define commands in `src/shared/ipc.ts` — `COMMON_COMMANDS` plus the per-view groups (`MAIN_VIEW_COMMANDS`, etc.) in that same file — use constants, not string literals
- **Message Handlers**: Delegate to domain-specific manager classes (FileManager, SettingsManager, etc.) for separation of concerns
- **Client-Side State**: Add empty handlers with `/* State saved client-side */` comment for checkbox/toggle operations
- **Resource Access**: Include all common module paths in `localResourceRoots` to prevent 401 errors
- **Module Structure**: Keep UI managers focused on a single responsibility
- **Trust Dependencies**: Use APIs as documented. When behavior is unclear, check the source in `node_modules/` first. Add a workaround only for a documented quirk, with a comment explaining it
- **Dropdown Menus**: Should close when clicking outside, not just on toggle
- **CSS Organization**: Keep per-component styles as TypeScript in each view's `frontend/` directory, shared tokens in `packages/extension/src/common/styles/common.css`

### UI anti-patterns

**Render-time workarounds.** Never compensate for data model problems at render time; renderers only transform and display. Signs of a broken data model: `Date.now()` or synthetic IDs generated during rendering, DOM queries to check whether data exists before rendering, deduplication logic comparing rendered content. Fix: store data once at the source with all metadata (timestamps, IDs). If a renderer needs to generate or deduplicate, the upstream code path is missing data.

**Duplicate UI controls.** One home per user action. Do not surface the same action (a dispatched event, a config/state write, or a command) from two controls; competing controls confuse users and drift out of sync. Secondary surfaces show read-only status, never a second control. Legitimate exceptions: a global default versus a per-item override, or one action as a command plus a single UI button. Grep procedure and details: code-review checklist § 5.

## Design and refactoring

Draw on principles from John Ousterhout's _A Philosophy of Software Design_ when
adding new code or refactoring existing modules:

- Seek out sources of complexity, especially change amplification, cognitive
  load and unknown unknowns. Simplify these areas before adding features.
- Identify shallow modules that merely pass data through. Deepen them by hiding
  implementation details behind well‑defined interfaces.
- Watch for information leakage between modules and other signs of poor
  abstraction. Refactor to combine related functionality and make interfaces
  simpler and more obvious.
- When submitting a PR, describe any design issues found and how the refactoring
  addresses them. Favor deep modules with minimal, clear APIs.
- Most importantly, ideally, when you have finished with each change, the system will have the structure it would have had if you had designed it from the start with that change in mind.
- When your refactoring include a large number of renames, use search tools to make sure you are not missing any files or paths where changes need to be made.
- **Share instances via constructors**: When managers share state, pass the shared dependency through the constructor. This keeps state consistent and dependencies explicit.

### Flattening abstraction layers

When refactoring, eliminate unnecessary wrapper functions and indirection layers:

**Anti-pattern (too many layers):**

```
Node.exec()
  → wrapperFunction()
    → coreFunction()
      → createFlow()
      → flow.run()
```

**Preferred (direct execution):**

```
Node.exec()
  → createFlow()
  → flow.run()
```

**Guidelines:**

- Nodes should create and run flows directly in `exec()`, not delegate to wrapper functions
- If a wrapper only creates state + runs flow + interprets results, inline it
- Delete wrapper files entirely when they become unused (don't leave empty re-exports)
- Update tests to use the underlying flow directly rather than through wrappers
- Update imports to point to the source of truth (e.g., `CycleServices` not re-exporting files)

### Discouraged factory patterns

Avoid these patterns that add indirection without value:

**Two-layer factories (called once):**

```typescript
// ❌ Anti-pattern: buildX only called from createX
export function createContext(init) {
  const services = buildServices(init);  // ← Extra layer
  return { services, ... };
}
function buildServices(init) { ... }

// ✅ Preferred: Inline if only called once
export function createContext(init) {
  const services = { ... };  // ← Direct
  return { services, ... };
}
```

**Trivial identity factories:**

```typescript
// ❌ Anti-pattern: Just spreads into new object
function createOptions(options: Options): Options {
  return { ...options };
}

// ✅ Preferred: Use object literal directly
const options: Options = { ... };
```

**When factories ARE justified:**

- Called from multiple locations (DRY)
- Contain meaningful logic (validation, defaults, transforms)
- Create class instances or complex objects
- Need to capture closures with initialization context

At review time this extends into the abstraction-cost guardrails (code-review checklist § 13): grep the caller count before approving any new shared helper (single-caller extractions are banned), and hold new ports/facades/template-methods to build-implies-delete-in-the-same-PR with net-LOC accounting.

## Code quality rules

These rules were earned from a 2026-07 whole-repo simplification campaign, not derived top-down. Each one carries the evidence that motivated it, so a future reader can tell it was learned rather than theorized. They complement, and don't restate, the guardrails documented in this file: "Flattening abstraction layers" and "Discouraged factory patterns" above, "UI anti-patterns", the abstraction-cost guardrails (code-review checklist § 13), and the Zod-as-SSOT guidance above.

- **Exports are contracts; default to file-local.** A new export needs a consumer in the same PR. Across the 2026-07 campaign, five separate areas' main cleanup yield was deleting exports with zero outside consumers (20 in `src/tools` alone). Mechanical enforcement lives in the dead-export ratchet (`npm run check:dead-code-ratchet`, per-symbol baseline in `config/ratchets/knip-baseline.json`; any unused export not in the baseline fails the check); this is the principle behind it.

- **No convenience barrels.** A barrel/index re-export file exists only for a documented public surface (for example, the trace events SDK contract, which declares its surface in its own docstring). Everything else imports the file that defines the symbol directly — this includes model handlers (`src/agent/modelHandlers/`; see that directory's `README.md`), which have no barrel and no re-export shims. The campaign deleted dead barrels in `workflowScript/`, `storage/`, and `index/` that no caller actually used.

- **Never hand out a shared mutable literal.** A module-level object that a function returns, or that crosses a module boundary, must be frozen (`as const` plus `Object.freeze`) or produced fresh by a factory that returns a new object each call; see "Discouraged factory patterns" above for when a factory is and isn't warranted. `Object.freeze` is shallow — for a literal with nested objects/arrays, or for a `Map`/`Set`, either deep-freeze it or use a factory, since a shallow freeze doesn't stop mutation of nested values or calls like `.set()`/`.add()`. A campaign consolidation once replaced fresh no-retry result literals with a single shared constant; the resulting aliasing behavior change was caught only by a follow-up factory rewrite and a `notStrictEqual` regression test.

- **Global registration requires a global consumer.** Register something globally (components, commands, providers) only when an external surface actually references it; consumers that are internal-only import locally instead. The docs theme once globally registered two components that no markdown page used.

- **No bare module-level mutable singletons in tested code.** State that tests need to isolate belongs behind an injectable, resettable handle, not a bare module-level variable. The only test flake hit during the 2026-07 campaign was a module-level session singleton colliding across suites.

- **Serialize async work with `p-queue`, not hand-rolled promise chains.** When operations must run one at a time (per-file write ordering, approval prompts, follow-up dispatch), use the root-dependency `p-queue`: `new PQueue({ concurrency: 1 })`, or a `Map` of queues for per-key ordering, as `src/agent/runtime/streamApprovalQueue.ts` and the CLI's `chatSessionController.followUpQueue` already do. Don't hand-roll the `chain = chain.then(...)` idiom — every copy re-solves error isolation (a swallowed rejection poisons or silently skips later work) and map-entry cleanup by hand, and the 2026-07-18 coupling audit found each existing copy did so differently (the 2026-07-25 sweep migrated all of them, including `writeChains` in `src/platform/defaults/jsonStore.ts` and `todoPersistChain` in `ToolUseCycleNode.ts`, onto this pattern).

### Test fixtures and fakes

- **Fixture rule of three.** When the same literal setup block appears three or more times in one test file, extract it to a file-local helper. Setup shared across multiple suites gets promoted to `src/test-kernel/support/`. Five test lanes in the campaign removed about 860 lines that were almost entirely repeated literal setup; one file constructed the same handle inline 33 times.

- **One fake per port.** Tests use the shared fakes in `src/test-kernel/support/` for platform ports. A local fake for a port that already has a shared fake requires a one-line comment naming the capability the shared fake deliberately lacks.

- **`expect` and `node:assert` are both supported.** New `src/test-kernel/` suites should use Vitest `expect`. Existing suites may stay on `node:assert` (strict); do not convert them as drive-by work in a feature, polish, or refactor PR. Convert only in a dedicated mechanical PR (one file or one directory, no behavior changes riding along) using the strict mapping: `assert.equal` becomes `toBe`, `assert.deepEqual` becomes `toStrictEqual` (never `toEqual`, which drops the `{a: undefined}` versus `{}` distinction), `assert.ok` becomes `toBeTruthy()`, or `toBe(true)` when the argument is already a boolean expression. One file keeps `node:assert` even then: `shared/stateSettings.vitest.ts` uses its per-key message argument to name the failing settings key inside a catalog loop. `agent/modelHandlers/ModelHandlerAnthropic.vitest.ts` and `agent/modelHandlers/ModelHandlerOpenAIResponse.vitest.ts` (about 300 sites between them) are barred from batch conversion inside a polish or refactor pass, where the mechanical diff would bury the change under review.

## Documentation

- Documentation lives in `docs/` and uses Markdown. Follow existing heading levels and style.
- Keep line length reasonable (< 120 characters) for readability.

## Branching

- Changes land on `main` through pull requests; use a feature branch per change.
- Ensure the working tree is clean before creating a pull request.
- `.github/PULL_REQUEST_TEMPLATE.md` requires `## Net elements (R6)` and
  `## Consumer counts (R8)` sections on any `refactor:` / `simplify:` /
  `consolidate` / `dedupe` / `extract` PR — see the review checklist § 14.
