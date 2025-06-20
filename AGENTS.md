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

- All code in `src/` is written in TypeScript targeting ES2022.
- Use the provided ESLint configuration (`eslint.config.mjs`) and Prettier settings (`.prettierrc`). Run `npm run format` before committing.
- Prefer `const` and `let` over `var`.
- Group imports by source and prefix each block with a descriptive comment (e.g., `// Third-party imports`, `// Local imports - component`).
- Document functions with concise comments. Use JSDoc style for public APIs.
- Keep functions small and focused; extract helpers when logic becomes complex.

### Patterns across the codebase

- Use `getConfig` from `src/utils/configUtils` to read extension settings rather than calling `vscode.workspace.getConfiguration` directly.
- For any filesystem access tied to the workspace, use helpers in `src/utils/workspaceFileUtils.ts`. These utilities automatically handle workspace-relative paths and use the VS Code `fs` APIs.
- For extension storage operations (temporary assets like pasted images), use the utilities in `src/utils/files/workspaceStorageUtils.ts`.
- These helpers also provide cleanup methods to remove old files (pasted images are deleted after three days).
- Generate names and resolve paths for pasted images through `src/utils/files/pastedImageUtils.ts`.
- Interact with the logging system via `src/logger/logUtils`. Create a channel-specific logger with `logger.initialize(CHANNEL)` and log messages with `logger.info`, `logger.debug`, etc. Use `startGroup` and `endGroup` for nested log blocks.
- When executing external commands, prefer `executeCommand` from `src/utils/execUtils.ts` so that output is captured and routed through the logger.
- Convert serialized objects into `TaskState` using `objectToTaskState` from `src/utils/configConversion.ts`. This applies default values such as the `sonnet4T` model.
- Model handlers for each provider live under `src/agent/modelHandlers`. Add new handlers there and export them via `src/agent/modelHandlers/index.ts`.
- When targeting the OpenAI Responses API, use `ModelHandlerOpenAIResponse`. This API does not support stop sequences, so handle any end-tag logic in post-processing.
- Maintain text cleanup rules in the `src/replacement` modules.
- UI components rely on VS Code codicons for icons (see `src/progressView/index.html`). Stick to these built-in icons to maintain a native look and feel.
- CSS for views is organized per component under `src/progressView/styles` with shared variables in `src/common/styles/common.css`. Follow this structure when adding new styles.
- Execute VS Code commands with `safeExecuteCommand` from `src/utils/commandUtils.ts` to handle errors gracefully.
- Register webview handlers using a command map and `registerMessageHandlers` from `src/common/modules/webviewContext.js`.
- Use `setupPasteListener` from `src/webview/modules/pasteHandler.js` to enable clipboard image pasting in text areas.
- Implement agents using the `IAgent` interface (`src/agent/IAgent.ts`) for a consistent lifecycle.
- Track log groups with numeric timestamps using `addLogMessage` in `src/logger/logUtils.ts`.
- Update cumulative usage stats with `updateUsageSummary` in `src/progressView/modules/domHandlers.js`.
- Prefer enums or union types over plain booleans in configuration objects.
- Build webview URIs through helpers in `src/webview/WebviewContentProvider.ts`.
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
- When your refactoring include a large number of renames, use search tools to make sure you are not missing any files or paths where changes need to be made.

## Documentation

- Documentation lives in `docs/` and uses Markdown. Follow existing heading levels and style.
- Keep line length reasonable (< 120 characters) for readability.

## Branching

- Work directly on the main branch in this environment; avoid creating extra branches.
- Ensure the working tree is clean before creating a pull request.
