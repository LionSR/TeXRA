# Manual Verification Matrix

Use this checklist after touching shared frontend code (`src/shared/`,
`src/common/webview/`, `packages/extension/src/{webview,progressView,settingsView}/frontend/`,
`packages/desktop/src/renderer/`) to confirm each major surface still mounts
in both hosts.

The Playwright suite under `packages/desktop/tests/e2e/` covers the desktop
shell automatically; there is no equivalent for the VS Code webview because
Mocha would need the VS Code test environment. The matrix below describes
what to check by hand for the extension.

## Quick automated pass

```bash
# Type checking — must be clean ON FILES YOU TOUCHED. Pre-existing errors
# (e.g. `@openrouter/sdk/models`) are unrelated.
npm run typecheck

# Vitest suite — host-neutral logic + Electron-facing helpers.
npx vitest run

# Desktop renderer build — must succeed (Vite).
cd packages/desktop && npx vite build --mode development

# Playwright Electron smoke — launches the desktop app, swaps routes,
# captures screenshots, exercises the command palette.
cd packages/desktop && pnpm exec playwright test
```

## Surfaces to confirm by hand

| Surface                  | Extension (VS Code)                                                                                   | Desktop (Electron)                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Launcher (main view)     | Open the TeXRA sidebar; the launcher renders with agent + model pickers.                              | `pnpm --filter @texra/desktop dev` and confirm the launcher mounts on the `main` route.                     |
| Progress board           | Run a tiny agent; the Progress view shows the stream as it ticks.                                     | Run a tiny agent; switch to Progress (chrome icon button) and confirm the same stream appears.              |
| Settings tabs            | Open `TeXRA: Open Settings`; cycle tabs (History, Memory, Models, Agents, Multi-Agent, LaTeX, Tools). | Click the Settings chrome icon; cycle the same tabs.                                                        |
| Onboarding / walkthrough | First install: VS Code's native walkthrough opens.                                                    | First launch: the in-renderer first-run dialog opens; "Got it" persists dismissal.                          |
| Command palette          | VS Code's native palette (`Cmd/Ctrl+Shift+P`) lists `TeXRA: …` commands.                              | The renderer's palette (`Cmd/Ctrl+K` or chrome "Commands" button) lists the same actions.                   |
| Theme switching          | Toggle VS Code light/dark/HC; the webviews follow within ~200ms.                                      | Toggle the OS theme; the renderer follows within ~200ms (`nativeTheme` 'updated' → `applyHostBodyTheme()`). |
| Workspace explorer       | n/a — VS Code's native explorer drives selection.                                                     | Confirm the desktop explorer lists files and supports double-click → "Use as input/reference/...".          |

## Files that should never diverge between hosts

These have been consolidated and must stay shared. If you find yourself
re-implementing one of these per host, push the new code into
`src/shared/wa/` instead.

- Theme body classes + WA color scheme: `src/shared/wa/hostTheme.ts`
- WA color scheme observer: `src/shared/wa/waColorScheme.ts`
- Action button helper: `src/shared/wa/actionButtons.ts`
- Empty state helper: `src/shared/wa/emptyState.ts`
- Walkthrough dialog: `src/shared/wa/walkthroughDialog.ts`
- Command palette shell: `src/shared/wa/commandPalette.ts`
- Persisted state: `src/shared/state/PersistedState.ts`
- Host bridge: `src/shared/hostBridge.ts`
- Settings tabs: `src/shared/schemas/settingsViewMessages.ts` (`SETTINGS_TAB`)
