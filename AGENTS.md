# Repository Guidelines: TeXRA

This document sets the common conventions for contributions. Follow these norms when working anywhere in this repository.

## Changelog Guidelines

When updating CHANGELOG.md:

- Focus on user-visible features and bug fixes
- Use clear, concise language that end users can understand
- Group changes into Features, Bug Fixes, and (rarely) Breaking Changes

## Development workflow

1. **Install dependencies**: run `corepack pnpm install` if needed.
2. **Run checks before committing**:
   - Format code using `npm run format`.
   - Build the extension bundle with `npm run compile:fast`.
   - Lint TypeScript sources with `npm run lint`.
   - Run the Vitest suite with `npm test`.
3. Commit only when `npm run lint` completes without errors.

### Build system: esbuild + Vite

The extension host is bundled with esbuild and the webviews with Vite (`compile:fast`, `package:fast`, `build:fast`; `compile`, `watch`, and `package` are aliases of the fast variants).

**Why the build doesn't catch type errors**: Vite and esbuild only strip TypeScript types without checking them. They treat TypeScript as "JavaScript with type annotations to remove."

**Safe build scripts** run `tsc --noEmit` before building to catch type errors:

| Script                 | Description              |
| ---------------------- | ------------------------ |
| `npm run typecheck`    | Standalone type checking |
| `npm run compile:safe` | typecheck + compile:fast |
| `npm run package:safe` | typecheck + package:fast |
| `npm run build:safe`   | typecheck + build:fast   |

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
- Use the provided ESLint configuration (`eslint.config.mjs`) and Prettier settings (`.prettierrc`). Run `npm run format` before committing.
- Prefer `const` and `let` over `var`.
- Group imports by source and prefix each block with a descriptive comment (e.g., `// Third-party imports`, `// Local imports - component`).
- Use the path aliases defined in `tsconfig.json` (for example `@frontend/*`, `@common/*`, `@utils/*`) instead of long relative import chains.
- Document functions with concise comments. Use JSDoc style for public APIs.
- Keep functions small and focused; extract helpers or modules when logic becomes complex.
- Keep the directory structure aligned among different webviews (webview, progressView, settingsView). Use the same folder names for modules of the same type and functionality but in different webviews.
- Place view-specific manager classes under each view's `managers` folder. For example, `WebviewUpdater.ts` lives in `packages/extension/src/progressView/managers/`.

### Naming conventions

- **Const object naming**:
  - Use **PascalCase** for service singletons that encapsulate state and behavior (e.g., `StreamStatusService`, `ModelRegistry`)
  - Use **camelCase** for simple command/function namespaces (e.g., `agentCommands`, `latexCommands`)
- **Constants**: Use `UPPER_SNAKE_CASE` for true constants (e.g., `MAX_ERROR_LENGTH`, `STREAM_STATUS`)

### Directory organization

This repository is a pnpm workspace. Repo-root `src/` contains shared core logic and host-neutral tests,
`packages/extension/` contains the VS Code extension, and `packages/desktop/` contains the Electron shell.
There is currently no `@texra/core` workspace package. Hosts import shared core through the repo-root path
aliases until a future SDK surface is enforced with a build and import-boundary lint gate.

- `packages/extension/src/frontend/` contains extension-host utilities that power shared UI flows (agent directories, file listers, instruction banners, tool workflows). Prefer these helpers over duplicating logic in commands or webviews.
  - `frontend/system/` - VS Code command utilities (`safeExecuteCommand`)
  - `frontend/ui/` - Dialog helpers, diff views, message utilities
  - `frontend/editor/` - Active file guards and editor utilities
  - `frontend/agents/` - Agent directory management (`AgentDirectoryManager`)
  - `frontend/files/` - File lister and discovery utilities
  - `frontend/latex/` - LaTeX build integration, linting
  - `frontend/media/` - Image and audio handling
- `src/common/` holds backend-only helpers (errors, files, parsing, storage, constants). Import them through the `@common/*` alias for clarity.
- `packages/extension/src/common/` holds extension-only helpers (state managers, webview base classes):
  - `packages/extension/src/common/state/` - State managers including `pendingStateManager`
  - `packages/extension/src/common/webview/` - Base classes (`BaseViewContentProvider`, `BaseViewMessageHandler`), webview HTML builder (`buildWebviewHtml`), command constants
- `src/utils/` is reserved for utilities used by both the extension host and webviews. If a helper is specific to one side, place it under `frontend/` or `common/` instead of `utils/`.
  - `utils/core/` - Async, type-guard, math, comparator, URL, and path-basics primitives (`debounce`, `delay`, `filterNotNull`, `clamp`, `byName`, `tryParseUrl`, `normalizeFilePath`, `getBasename`, `getFileStem`); re-exports string primitives from `utils/text/stringUtils` for browser-safe barrel access
    - `utils/core/boundedIdSet.ts` - `createBoundedIdSet` (LRU-capped `Set<Id>` for "seen id" guards); `utils/core/pathCore.ts` is the sibling Node-only path module
  - `utils/files/` - Filesystem utilities, rules, and vars
  - `utils/config/` - Settings helpers (`getConfig`, `updateConfig`, `watchConfig`)
  - `utils/system/` - Shell command execution (`execUtils`)
  - `utils/text/` - Text, string, and XML processing utilities — the single home for generic string helpers (validation, truncation, duration/token/percent formatting)
  - `utils/prompt/` - Prompt builder utilities
- `packages/extension/src/commands/` - VS Code commands grouped by domain
- `packages/extension/src/settingsView/` - Unified settings webview combining History, Memory, Models, Agents, Multi-Agent, LaTeX, and Tools tabs
- `packages/extension/src/progressView/` - Task tracking board webview
- `packages/extension/src/webview/` - Main agent interaction webview
- `packages/extension/resources/` - Packaged agents, tool-use agents, docs, templates, examples, and extension assets
- `src/platform/` - Platform abstraction layer (composition root). Hosts call `initPlatform()` once at startup; agnostic code uses `platform()` from `@platform/platform`.
- `src/hosts/` - Host capability interfaces for clipboard, prompts, terminals, diff views, and openers.
- `src/test-kernel/` - Vitest suites for host-neutral and Electron-facing behavior.

### Pragmatic implementations

- **Start simple**: Choose the most direct solution that solves the problem. A new abstraction earns its place only when it clearly reduces complexity.
- **Use native constructs**: Rely on JavaScript/TypeScript built-ins (objects, Maps, Sets, arrays), VS Code APIs, and JSON for state. These are well-understood and require no extra code.
- **Trust your inputs**: When data flows from code you control, pass it through directly. Transform or validate only at true system boundaries (user input, external APIs).
- **One error path**: Surface errors once through the shared error utilities in `@common/errors`. Let exceptions propagate naturally to that single handler.
- **Evolve incrementally**: Improve existing structures in small steps. Rewrite only when there's a documented, concrete benefit.

### Zod v4 Schema Patterns

This project uses Zod v4. Follow these idiomatic patterns:

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

- `.prefault(val)` - Substitutes for `undefined` BEFORE validation and transforms; use for documented legacy omissions
- `.default(val)` - Returns a valid output default for `undefined` without parsing that default
- `.catch(val)` - Substitutes after a validation error; use only where malformed present data may be discarded by policy

Preserve the distinction between absent and invalid present data. In security,
accounting, lifecycle, and durable-state schemas, use `.prefault(...)` only for
documented omissions and let malformed present values fail validation. Do not
use `.catch(...)` to turn corruption or contract drift into an ordinary default.

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

1. **Never import `vscode` in VS Code-free zones.** See CLAUDE.md "Separation of Concerns: VS Code Coupling" for the full list. The key ones: `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/controllers/`, `src/shared/`. Do not add new `@agent/*` imports under `src/shared/`; host-neutral orchestration belongs under `src/controllers/`.

2. **Use platform-agnostic helpers instead of VS Code types:**
   - `isFile(type)` / `isDirectory(type)` from `@utils/files/fsEntryType` — not `vscode.FileType.File` / `vscode.FileType.Directory`
   - `isFileNotFoundError(err)` from `@common/errors` — not `instanceof vscode.FileSystemError`
   - Use `number` for file type annotations instead of `vscode.FileType` — the numeric values are compatible

3. **Push UI side-effects to the caller.** Business logic functions should return error information (result objects, thrown errors) instead of calling `vscode.window.show*Message()` directly. The command/frontend layer handles user-facing notifications.

4. **Use `Platform` ports for platform capabilities.** When agnostic code needs something only the host provides (e.g., checking if a VS Code extension is installed), add a typed port to `Platform` (e.g., `toolAvailability.isVscodeExtensionInstalled`) and wire it from the host composition root.

5. **Prefer `WorkspaceFS.getPath()` over `vscode.workspace.workspaceFolders`.** The former is already available and returns the same value.

### Patterns across the codebase

**Configuration, storage, and workspace files**

- Use `getConfig`, `updateConfig`, and `watchConfig` from `@utils/config` to read and react to settings changes.
- Interact with the filesystem through `@utils/files` helpers (`WorkspaceFS`, `RelativeFS`, `StorageFS`, `GlobalStorageFS`, `AbsoluteFS`). They resolve workspace paths, manage global storage, and expose cleanup helpers like `RelativeFS.cleanupOldFiles`.
- Generate and resolve pasted-image paths with `@utils/files/pastedImageUtils` so temporary assets map correctly back to storage.
- Surface files and agent directories through the shared frontend utilities (`fileLister` in `packages/extension/src/frontend/files/fileLister.ts`, `agentDirectories` in `packages/extension/src/frontend/agents/AgentDirectoryManager.ts`) instead of duplicating discovery logic.

**Logging and telemetry**

- Route logging through `@logger/logUtils`. Agent flows should use `AgentTrace` (`@agent/trace`) to get grouped output and tool-use aware channels.
- Always pass structured payloads via the `data` argument (file lists, missing outputs, latexdiff results, usage statistics) so the progress view can render rich entries without custom parsing.
- Publish runtime progress through session events and `AgentRuntimeHost.emit`; keep non-agent logs on the shared `TeXRA` output channel.

**Agent execution and tool-use**

- Define agents using `AgentDataclass` and `AgentConfig` (`src/agent/core/`) and compose them via the factories in `src/agent/runtime`.
- Launch executions from host code (commands, frontend services, desktop IPC) via `runAgent` (`src/agent/runtime/runAgent.ts`) — it assigns an `executionId`, registers the run in storage, and opens workflow output. Only use the lower-level `executeAgent` when you already own the `executionId` (e.g. subagent dispatch in `DelegationTools.ts` or a resume path). Both functions require an explicit `runtimeHost`.
- Resume a persisted tool-use session via `resumeToolUseFromSnapshot` (`src/agent/runtime/executeAgent.ts`), not `runAgent`.
- Add new model handlers under `src/agent/modelHandlers/`, export them through the index, and register capabilities/pricing in `src/model/computeModelOptions.ts`.

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
- **Node lifecycle**: `prep(shared) → exec(prepRes) → post(shared, prepRes, execRes)`. Override `maxRetries` and `retryDelay` getters for retry configuration.
- **Agent owns lifecycle**: Agents handle init/finalize; flows handle only execution logic. Nodes should throw errors directly (agent.run() catches).

See `docs/pocketflow/` for full framework documentation.

**Webviews and UI**

- Generate HTML through `BaseViewContentProvider` (`packages/extension/src/common/webview/BaseViewContentProvider.ts`) and `buildWebviewHtml` (`packages/extension/src/common/webview/html.ts`). Extend `BaseViewMessageHandler` for consistent lifecycle management across views.
- Use Web Awesome (`<wa-icon>` via `waIcon()` from `@shared/wa/webAwesomeIcons`) and shared utilities from `@utils/text/stringUtils` and `@utils/core` (path basics: `normalizeFilePath`, `getBasename`, `getFileStem`) for consistent interactions.
- For webview dependencies, prefer CDN builds (jsdelivr for static assets, esm.sh for ES modules) for complex packages like markdown-it, KaTeX, or highlight.js, while keeping lightweight bundles (split.js) local to reduce extension size.
- Keep CSS modular (per-component styles as TypeScript in each view's `frontend/` directory, shared tokens in `packages/extension/src/common/styles/common.css`) and use Web Awesome icons (e.g., `${waIcon('chevron-down')}`) for toggle affordances.

**Progress view**

- Extend the existing Lit components in `packages/extension/src/progressView/frontend/components/` (`StreamTabs`, `LogList`, `UsagePanel`, `TaskGroupList`, etc.) and managers in `packages/extension/src/progressView/managers/` (`OutputFilesManager`, `UsageStatsManager`, `WebviewUpdater`) — augment them rather than manipulating the DOM directly.
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

- **Base Classes**: All webviews (webview, progressView, settingsView) extend `BaseViewContentProvider` and `BaseViewMessageHandler` from `src/common/webview/` for consistent error handling, logging, and cleanup.
- **Naming Convention**: Follow `[Domain]View[Component]` pattern (e.g., `MainViewContentProvider`, `SettingsViewMessageHandler`, `ProgressViewContentProvider`)
- **Command Constants**: Define commands in `src/shared/ipc/commonCommands.ts` (plus per-view `*ViewCommands.ts` files under `src/shared/ipc/`) — use constants, not string literals
- **Message Handlers**: Delegate to domain-specific manager classes (FileManager, SettingsManager, etc.) for separation of concerns
- **Client-Side State**: Add empty handlers with `/* State saved client-side */` comment for checkbox/toggle operations
- **Resource Access**: Include all common module paths in `localResourceRoots` to prevent 401 errors
- **Module Structure**: Keep UI managers focused on a single responsibility
- **Trust Dependencies**: Use APIs as documented. When behavior is unclear, check the source in `node_modules/` first. Add a workaround only for a documented quirk, with a comment explaining it
- **Dropdown Menus**: Should close when clicking outside, not just on toggle
- **CSS Organization**: Keep per-component styles as TypeScript in each view's `frontend/` directory, shared tokens in `packages/extension/src/common/styles/common.css`

### Source Organization

VS Code commands live under `packages/extension/src/commands/` and are grouped by domain. Key folders include
`agent/` for agent lifecycle and merge commands, `housekeeping/` for cleanup and packaging, `latex/` for
LaTeX document tasks, `settings/` for settings view commands, and `system/` for editor helpers along with
XML/YAML utilities. This structure keeps each area focused and aligns with the design philosophy of deep modules.

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

## Documentation

- Documentation lives in `docs/` and uses Markdown. Follow existing heading levels and style.
- Keep line length reasonable (< 120 characters) for readability.

## Branching

- Work directly on the main branch in this environment; avoid creating extra branches.
- Ensure the working tree is clean before creating a pull request.
