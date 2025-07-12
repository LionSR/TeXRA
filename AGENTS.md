# Repository Guidelines: TeXRA

This document sets the common conventions for contributions. Follow these norms when working anywhere in this repository.

## Development workflow

1. **Install dependencies**: run `npm install` if needed.
2. **Run checks before committing**:
   - Format code using `npm run format`.
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
- Document functions with concise comments. Use JSDoc style for public APIs.
- Keep functions small and focused; extract helpers or modules when logic becomes complex.
- Keep the directory structure aligned among different webviews (webview, historyView, progressView). Use the same folder names for modules of the same type and functionality but in different webviews.
- Place view-specific manager classes under each view's `managers` folder. For example, `WebviewUpdater.ts` lives in `src/progressView/managers/`.

### Patterns across the codebase

- Use `getConfig` from `src/utils/configUtils` to read extension settings rather than calling `vscode.workspace.getConfiguration` directly.
- For any filesystem access tied to the workspace, use helpers in `src/utils/workspaceFileUtils.ts`. These utilities automatically handle workspace-relative paths and use the VS Code `fs` APIs.
- For extension storage operations (temporary assets like pasted images), use the utilities in `src/utils/files/workspaceStorageUtils.ts`.
- These helpers also provide cleanup methods to remove old files (pasted images are deleted after three days).
- Generate names and resolve paths for pasted images through `src/utils/files/pastedImageUtils.ts`.
- Interact with the logging system via `src/logger/logUtils`. Create a channel-specific logger with `logger.initialize(CHANNEL)` and log messages with `logger.info`, `logger.debug`, etc. Use `startGroup` and `endGroup` for nested log blocks.
- Always supply structured data via the `data` argument for specialized messages (file lists, missing outputs, latexdiff, statistics). Avoid JSON parsing fallbacks in the ProgressView.
- When executing external commands, prefer `executeCommand` from `src/utils/execUtils.ts` so that output is captured and routed through the logger.
- Convert serialized objects into `TaskState` using `objectToTaskState` from `src/utils/configConversion.ts`. This applies default values such as the `sonnet4T` model.
- Model handlers for each provider live under `src/agent/modelHandlers`. Add new handlers there and export them via `src/agent/modelHandlers/index.ts`.
- When targeting the OpenAI Responses API, use `ModelHandlerOpenAIResponse`. This API does not support stop sequences, so handle any end-tag logic in post-processing.
- Maintain text cleanup rules in the `src/replacement` modules.
- UI components rely on VS Code codicons for icons (see `src/progressView/index.html`). Stick to these built-in icons to maintain a native look and feel.
- When toggling sections in webviews, use codicons for the chevron instead of plain characters. For a collapsed state,
  render `<i class="codicon codicon-chevron-down"></i>`.
- CSS for views is organized per component under `src/progressView/styles` with shared variables in `src/common/styles/common.css`. Follow this structure when adding new styles.
- Execute VS Code commands with `safeExecuteCommand` from `src/utils/commandUtils.ts` to handle errors gracefully.
- Register webview handlers using a command map and `registerMessageHandlers` from `src/common/modules/webviewContext.js`.
- Use `setupPasteListener` from `src/webview/modules/pasteHandler.js` to enable clipboard image pasting in text areas.
- Implement agents using the `IAgent` interface (`src/agent/IAgent.ts`) for a consistent lifecycle.
- Track log groups with numeric timestamps using `addLogMessage` in `src/logger/logUtils.ts`.
- Use the event bus (`emitProgress`/`onProgress` from `src/eventBus/ProgressEventBus.ts`) to publish and subscribe to progress updates instead of calling `ProgressViewProvider` methods directly.
- Only agent streams appear in the ProgressView and get their own output channels. Other logs share the
  consolidated `TeXRA` channel and are not persisted across sessions.
- Update cumulative usage stats with `updateUsageSummary` in `src/progressView/modules/domHandlers.js`.
- Prefer enums or union types over plain booleans in configuration objects.
- Build webview URIs through helpers in `src/webview/MainViewContentProvider.ts`.
- When adding new webview modules (e.g., under `src/webview/modules/uiManagers`),
  map them in `src/webview/index.html` and expose their URIs via
  `MainViewContentProvider`.
- Use `watchConfig` from `src/utils/configUtils.ts` to refresh features when configuration settings change.
- Build DOM elements with `<template>` blocks and helpers in `src/common/modules/templateUtils.js`.
- Manipulate webview DOM safely using `addEventListenerSafely` from `src/common/modules/domUtils.js`.
- Format and log errors via `logErrorMessage` in `src/utils/errorHandlingUtils.ts`.
- Categorize log entries with the `LogMessageType` enum (`src/types/LogTypes.ts`).
- Share common webview helpers like `webviewContext` under `src/common/modules`.
- Keep result and log group interfaces under `src/types` for reuse.
- Retrieve included file extensions through `getIncludedExtensions` in `src/utils/fileTypeUtils.ts`.
- Initialize new agent YAML files from the provided template for a consistent structure.
- Dispose event listeners and watchers when webviews close to prevent leaks.
- Maintain provider capabilities and pricing info in `ModelRegistry`.
- Prefer debug logging for routine events; reserve info and error levels for important messages.
- When refactoring classes for separation of concerns, avoid backward compatibility pass-through methods. Instead:
  - Organize functionality into focused manager classes (e.g., `TaskGroups`, `StreamTabs`, `FileList`)
  - Use direct access patterns: `state.taskGroups.get()` instead of `state.getTaskGroup()`
  - Keep method names simple - context comes from the class name (`set()`, `get()`, `clear()`)
  - Follow the pattern seen in `src/progressView/modules/progressViewState.js` and `domHandlers.js`
- When modularizing webview code, ALL module dependencies must be explicitly mapped in the import map:
  - Each module imported by ANY module in the dependency tree needs its own URI and import map entry
  - This includes transitive dependencies (modules imported by imported modules)
  - Generate URIs using appropriate helpers (`getHistoryViewUri`, `getCommonUri`, etc.)
  - Pass all URIs to the HTML template and map them in the importmap script tag
  - Without complete import mapping, ES modules will fail to resolve in the webview's sandboxed environment

### Webview Consistency Patterns

- **Base Classes**: All webviews extend `BaseViewContentProvider` and `BaseViewMessageHandler` for consistent error handling, logging, and URI generation
- **Naming Convention**: Follow `[Domain]View[Component]` pattern (e.g., `MainViewContentProvider`, `HistoryViewMessageHandler`)
- **Command Constants**: Define all commands in `src/common/webview/commands.js` and `.ts` - use constants, not string literals
- **Message Handlers**: Delegate to domain-specific manager classes (FileManager, SettingsManager, etc.) for separation of concerns
- **Client-Side State**: Add empty handlers with `/* State saved client-side */` comment for checkbox/toggle operations
- **Resource Access**: Include all common module paths in `localResourceRoots` to prevent 401 errors
- **Module Structure**: Keep UI managers modular and focused on single responsibilities - avoid large consolidated classes

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
- When creating manager classes that share state, avoid creating separate instances:
  - Pass shared dependencies through constructors (e.g., `new UsageGroup(this.usageSummary)`)
  - This prevents inconsistent state across different parts of the UI
- Avoid circular dependencies and forward references:
  - Don't use global window references for accessing parent singletons from child components
  - Instead, pass required dependencies through constructors
  - This prevents ReferenceError from const declarations and maintains clean architecture
  - Example: UsageGroup should use the same UsageSummary instance as the main handler

## Documentation

- Documentation lives in `docs/` and uses Markdown. Follow existing heading levels and style.
- Keep line length reasonable (< 120 characters) for readability.

## Branching

- Work directly on the main branch in this environment; avoid creating extra branches.
- Ensure the working tree is clean before creating a pull request.
