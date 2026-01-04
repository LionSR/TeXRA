# Repository Guidelines: TeXRA

This document sets the common conventions for contributions. Follow these norms when working anywhere in this repository.

## Changelog Guidelines

When updating CHANGELOG.md:

- Focus on user-visible features and bug fixes
- Use clear, concise language that end users can understand
- Group changes into Features, Bug Fixes, and (rarely) Breaking Changes

## Development workflow

1. **Install dependencies**: run `npm install` if needed.
2. **Run checks before committing**:
   - Format code using `npm run format`.
   - Build the extension bundle with `npm run compile` to ensure the webpack build succeeds.
   - Lint TypeScript sources with `npm run lint`.
   - Execute `npm test` to run the VS Code test suite when possible.
3. Commit only when `npm run lint` completes without errors. If tests fail due to environment issues, note this in the PR.

## Commit messages

- Use the [Conventional Commits](https://www.conventionalcommits.org) style such as `fix:`, `feat:`, or `docs:`.
- Keep the summary short (under 72 characters) and written in the present tense.
- Provide additional context in the body when needed.

## Coding style

- All code in `src/` is written in TypeScript targeting ES2022, except some javascript files in `src/(webview,progressView,historyView)/modules/`.
- Use the provided ESLint configuration (`eslint.config.mjs`) and Prettier settings (`.prettierrc`). Run `npm run format` before committing.
- Prefer `const` and `let` over `var`.
- Group imports by source and prefix each block with a descriptive comment (e.g., `// Third-party imports`, `// Local imports - component`).
- Use the path aliases defined in `tsconfig.json` (for example `@frontend/*`, `@common/*`, `@utils/*`) instead of long relative import chains.
- Document functions with concise comments. Use JSDoc style for public APIs.
- Keep functions small and focused; extract helpers or modules when logic becomes complex.
- Keep the directory structure aligned among different webviews (webview, historyView, progressView). Use the same folder names for modules of the same type and functionality but in different webviews.
- Place view-specific manager classes under each view's `managers` folder. For example, `WebviewUpdater.ts` lives in `src/progressView/managers/`.

### Naming conventions

- **Const object naming**:
  - Use **PascalCase** for service singletons that encapsulate state and behavior (e.g., `StreamStatusService`, `ModelRegistry`)
  - Use **camelCase** for simple command/function namespaces (e.g., `agentCommands`, `latexCommands`)
- **Constants**: Use `UPPER_SNAKE_CASE` for true constants (e.g., `MAX_ERROR_LENGTH`, `STREAM_STATUS`)

### Directory organization

- `src/frontend/` contains extension-host utilities that power shared UI flows (agent directories, file listers, instruction banners, tool workflows). Prefer these helpers over duplicating logic in commands or webviews.
  - `frontend/system/` - VS Code command utilities (`safeExecuteCommand`)
  - `frontend/ui/` - Dialog helpers, diff views, message utilities
  - `frontend/editor/` - Active file guards and editor utilities
  - `frontend/agents/` - Agent directory management (`AgentDirectoryManager`)
  - `frontend/files/` - File lister and discovery utilities
  - `frontend/webview/` - Webview HTML builder (`buildWebviewHtml`)
  - `frontend/latex/` - LaTeX build integration, linting
  - `frontend/media/` - Image and audio handling
- `src/common/` holds backend-only helpers (errors, state, files, base webview classes). Import them through the `@common/*` alias for clarity.
  - `common/state/` - State managers including `pendingStateManager`
  - `common/modules/` - Shared webview modules (`BaseDomHandler`, `domUtils`, `templateUtils`)
  - `common/webview/` - Base classes (`BaseViewContentProvider`, `BaseViewMessageHandler`), theme handlers
- `src/utils/` is reserved for utilities used by both the extension host and webviews. If a helper is specific to one side, place it under `frontend/` or `common/` instead of `utils/`.
  - `utils/core/` - Async utilities (`debounce`, `withTimeout`, `delay`)
  - `utils/files/` - Filesystem utilities, rules, and vars
  - `utils/config/` - Settings helpers (`getConfig`, `updateConfig`, `watchConfig`)
  - `utils/system/` - Shell command execution (`execUtils`)
  - `utils/text/` - Text and XML processing utilities
  - `utils/prompt/` - Prompt builder utilities
- `src/explorer/` - VS Code file explorer integration and watchers
- `src/profileView/` - Agent profile/settings webview (follows same pattern as progressView/historyView)

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

- `.prefault(val)` - Normalizes input BEFORE validation (for deserialization/loading)
- `.default(val)` - Provides fallback AFTER validation fails
- `.catch(val)` - Provides fallback when validation throws (field-level or schema-level)

**When to use each default pattern:**

```typescript
// Deserialization (loading saved state) - use .prefault()
const SnapshotSchema = z.object({
  count: z.int().prefault(0), // normalize missing fields
  items: z.array(z.string()).prefault([]),
});

// Field-level fallback (preserve valid fields) - use .catch()
const UserSchema = z.object({
  tier: TierSchema.catch('free'), // invalid tier → 'free', valid tier preserved
  perms: z.array(z.string()).catch([]),
});

// Schema-level fallback (all-or-nothing) - use .catch() on schema
const config = ConfigSchema.catch(DEFAULT_CONFIG).parse(data);
```

**Safe parsing with fallback**

```typescript
// Old verbose pattern
const result = Schema.safeParse(data);
const value = result.success ? result.data : defaultValue;

// Zod v4 native
const value = Schema.catch(defaultValue).parse(data);
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
```

### Refactoring for simplicity

Aim for code that looks like it was designed correctly from the start:

- **Use built-in methods**: `Array.isArray()`, optional chaining, and standard library functions handle most cases cleanly.
- **Normalize at the edge**: Convert legacy formats once at load time (Zod schemas work well), then use only the current format everywhere else.
- **Extract only when repeated**: Create a helper when the same logic appears in multiple places—not before.

### Patterns across the codebase

**Configuration, storage, and workspace files**

- Use `getConfig`, `updateConfig`, and `watchConfig` from `@utils/config` to read and react to settings changes.
- Interact with the filesystem through `@utils/files` helpers (`WorkspaceFS`, `RelativeFS`, `StorageFS`, `GlobalStorageFS`, `AbsoluteFS`). They resolve workspace paths, manage global storage, and expose cleanup helpers like `StorageFS.cleanupOldFiles`.
- Generate and resolve pasted-image paths with `@utils/files/pastedImageUtils` so temporary assets map correctly back to storage.
- Surface files and agent directories through the shared frontend utilities (`fileLister` in `src/frontend/files/fileLister.ts`, `agentDirectories` in `src/frontend/agents/AgentDirectoryManager.ts`) instead of duplicating discovery logic.

**Logging and telemetry**

- Route logging through `@logger/logUtils`. Agent flows should wrap the logger with `AgentLogger` (`src/logger/AgentLogger.ts`) to get grouped output and tool-use aware channels.
- Always pass structured payloads via the `data` argument (file lists, missing outputs, latexdiff results, usage statistics) so the progress view can render rich entries without custom parsing.
- Publish progress updates with the event bus (`bus.emit`/`bus.on` from `src/eventBus/ProgressEventBus.ts`) and keep non-agent logs on the shared `TeXRA` output channel.

**Agent execution and tool-use**

- Implement new agents against `IAgent` (`src/agent/core/IAgent.ts`) and compose them via the factories in `src/agent/runtime`.
- Persist interactive runs with `ToolUseSessionManager` (`src/agent/toolUse/ToolUseSessionManager.ts`) and launch/resume executions via `executeAgent` or `runPreparedAgent` (`src/agent/runtime/executeAgent.ts`) so session filters, run directories, and resume actions stay synchronized.
- Add new model handlers under `src/agent/modelHandlers/`, export them through the index, and register capabilities/pricing in `src/model/ModelRegistry.ts`.

**PocketFlow architecture**

Agent flows follow the PocketFlow pattern in `src/agent/implementations/flows/`:

- **Flow types**: `ReflectionFlow` for multi-round reflection agents, `ToolUseRunFlow` for tool-use agents
- **Services** are immutable dependencies injected via `flow.setServices()`. Nodes access them via `this.services`. Define service interfaces in flow-specific files (e.g., `ReflectionServices`, `ToolUseServices`) extending `BaseFlowContextInit` with convenience accessors (`logger`, `context`) defined inline.
- **Shared store** contains only mutable state (memories). Nodes read/write via `prep()` and `post()` methods.
- **Flow transitions** - use named constants instead of magic values:
  - `FlowTransition.DEFAULT` - follow next() successor
  - `FlowTransition.CONTINUE` - loop back to flow entry
  - `FlowTransition.FINALIZE` - exit flow after finalization
  - `FlowTransition.COMPLETE` - return control to caller
- **Node lifecycle**: `prep(shared) → exec(prepRes) → post(shared, prepRes, execRes)`. Use constants `NODE_NO_RETRY` and `NODE_NO_WAIT` for node configuration.
- **Agent owns lifecycle**: Agents handle init/finalize; flows handle only execution logic. Nodes should throw errors directly (agent.run() catches).

See `docs/pocketflow/` for full framework documentation.

**Webviews and UI**

- Generate HTML through `BaseViewContentProvider` (`src/common/webview/BaseViewContentProvider.ts`) and `buildWebviewHtml` (`src/frontend/webview/html.ts`). Extend `BaseViewMessageHandler` and `BaseDomHandler` for consistent lifecycle management across views.
- Register webview message handlers with `registerMessageHandlers` (`src/common/modules/webviewContext.js`). When adding UI managers (e.g., under `src/webview/modules/uiManagers/` or `src/progressView/modules/uiManagers/`), expose their URIs in the relevant content provider and import map.
- Use codicon-based controls and the shared helpers in `src/common/modules/` (`iconConstants`, `templateUtils`, `domUtils`, `stringUtils`, `pathUtils`, `webviewState`) and `src/common/webview/themeHandlers.js` alongside `src/webview/modules/pasteHandler.js` for consistent interactions.
- Map every module dependency in the import map, including transitives, and generate URIs via helper methods (`getHistoryViewUri`, `getCommonUri`, etc.). Missing entries will prevent modules from loading in the sandboxed webview.
- For webview dependencies, prefer CDN builds (jsdelivr for static assets, esm.sh for ES modules) for complex packages like markdown-it, KaTeX, or highlight.js, while keeping lightweight bundles (split.js, `@vscode/codicons`) local to reduce extension size.
- Keep CSS modular (per-component styles in `src/progressView/styles`, shared tokens in `src/common/styles/common.css`) and use codicon chevrons (e.g., `<i class="codicon codicon-chevron-down"></i>`) for toggle affordances.

**Progress view**

- Extend the existing managers coordinated by `ProgressViewDomHandler` (`src/progressView/modules/domHandlers.js`). `StreamTabs`, `Toolbar`, `UsageSummary`, `UsageGroup`, `TaskGroupManager`, and `LogEntryManager` own their respective UI surfaces—augment them rather than manipulating the DOM directly.
- Tool-use and workflow sessions surface in separate filters; continue emitting usage, status, and log events through the established progress event commands so filters, counts, and badges update automatically.

**Error handling and types**

- Format and surface errors through `logErrorMessage`, `showLoggedErrorMessage`, and `showLoggedMessageWithDocs` in `src/common/errors/errorHandlingUtils.ts` for consistent telemetry and documentation links.
- Keep shared type definitions colocated with their domains (`src/agent/types`, `src/logger/types`) and derive runtime-safe interfaces with `zod` plus `z.infer`.

**Miscellaneous**

- Maintain text cleanup rules in the `src/replacement` modules.
- Execute VS Code commands with `safeExecuteCommand` from `src/frontend/system/commandUtils.ts` and shell commands with `executeCommand` from `src/utils/system/execUtils.ts` so logging and error handling stay uniform.
- Retrieve included file extensions via `getIncludedExtensions` in `src/common/files/fileTypeUtils.ts`.
- Initialize new agent YAML files from the templates in `resources/agents/` and `resources/tool_use_agents/`.
- Dispose event listeners and watchers when webviews close to prevent leaks.
- Prefer enums or discriminated unions over bare booleans in configuration objects.
- Favor debug logs for routine events and reserve info/error levels for notable outcomes.
- Use the helpers in `src/frontend/ui/messageUtils.ts` for consistent casing and notification primitives shared across the extension.

### Webview Consistency Patterns

- **Base Classes**: All webviews (webview, progressView, historyView, profileView) extend `BaseViewContentProvider`, `BaseViewMessageHandler`, and use DOM managers built on `BaseDomHandler` from `src/common/modules/BaseDomHandler.js` for consistent error handling, logging, and cleanup.
- **Naming Convention**: Follow `[Domain]View[Component]` pattern (e.g., `MainViewContentProvider`, `HistoryViewMessageHandler`, `ProfileViewDomHandler`)
- **Command Constants**: Define all commands in `src/common/webview/commands.js` and `.ts` - use constants, not string literals
- **Message Handlers**: Delegate to domain-specific manager classes (FileManager, SettingsManager, etc.) for separation of concerns
- **Client-Side State**: Add empty handlers with `/* State saved client-side */` comment for checkbox/toggle operations
- **Resource Access**: Include all common module paths in `localResourceRoots` to prevent 401 errors
- **Module Structure**: Keep UI managers focused on a single responsibility
- **Trust Dependencies**: Use APIs as documented. When behavior is unclear, check the source in `node_modules/` first. Add a workaround only for a documented quirk, with a comment explaining it
- **Dropdown Menus**: Should close when clicking outside, not just on toggle
- **CSS Organization**: Keep per-component styles in view-specific `styles/` directories, shared tokens in `src/common/styles/common.css`

### Source Organization

Commands live under `src/commands/` and are grouped by domain. Key folders include `agent/` for agent lifecycle and merge commands, `housekeeping/` for cleanup and packaging, `latex/` for LaTeX document tasks, `wolfram/` for Wolfram Alpha and script utilities, and `system/` for editor helpers along with XML/YAML utilities. This structure keeps each area focused and aligns with the design philosophy of deep modules.

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
- **Share instances via constructors**: When managers share state, pass the shared dependency through the constructor (e.g., `new UsageGroup(this.usageSummary)`). This keeps state consistent and dependencies explicit.

## Documentation

- Documentation lives in `docs/` and uses Markdown. Follow existing heading levels and style.
- Keep line length reasonable (< 120 characters) for readability.

## Branching

- Work directly on the main branch in this environment; avoid creating extra branches.
- Ensure the working tree is clean before creating a pull request.
