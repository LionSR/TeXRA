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
- Interact with the logging system via `src/logger/logUtils`. Create a channel-specific logger with `logger.initialize(CHANNEL)` and log messages with `logger.info`, `logger.debug`, etc. Use `startGroup` and `endGroup` for nested log blocks.
- When executing external commands, prefer `executeCommand` from `src/utils/execUtils.ts` so that output is captured and routed through the logger.
- UI components rely on VS Code codicons for icons (see `src/progressView/index.html`). Stick to these built-in icons to maintain a native look and feel.
- CSS for views is organized per component under `src/progressView/styles` with shared variables in `src/common/styles/common.css`. Follow this structure when adding new styles.

## Documentation

- Documentation lives in `docs/` and uses Markdown. Follow existing heading levels and style.
- Keep line length reasonable (< 120 characters) for readability.

## Branching

- Work directly on the main branch in this environment; avoid creating extra branches.
- Ensure the working tree is clean before creating a pull request.
