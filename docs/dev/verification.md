# Manual Verification Matrix

Use this checklist after touching shared frontend code (`packages/harness/src/shared/`,
`packages/extension/src/common/webview/`,
`packages/extension/src/{progressView,settingsView}/frontend/`,
`packages/desktop/src/renderer/`) to confirm each major surface still mounts
in both hosts.

The Playwright suite under `packages/desktop/tests/e2e/` covers the desktop
shell automatically. There is no equivalent for the VS Code webview: Vitest
runs VS Code-coupled modules against the `vscode` stub
(`src/test-kernel/support/vscode-mock.ts`), which exercises the logic but
never mounts a webview in a real extension host. The matrix below describes
what to check by hand for the extension.

## Quick automated pass

```bash
# Type checking: must be clean.
npm run typecheck

# Vitest suite — host-neutral logic + Electron-facing helpers.
npx vitest run

# Desktop renderer build — must succeed (Vite).
cd packages/desktop && npx vite build --mode development

# Playwright Electron smoke — launches the desktop app, swaps routes,
# captures screenshots, exercises the command palette.
cd packages/desktop && pnpm exec playwright test

# CLI TUI frame validator — drives the Ink TUI through a PTY and checks the
# visible terminal frame for chat, slash commands, approvals, subagents, and
# compact layouts. It fails when the native node-pty dependency is unavailable,
# so a green run always means frames were exercised.
corepack pnpm --filter @texra-ai/cli validate:tui

# CLI TUI snapshot report — use this when a PR or issue needs terminal
# screenshots for product review. It writes numbered .txt/.svg frames and an
# index.html report under the requested directory.
corepack pnpm --filter @texra-ai/cli validate:tui --snapshot-dir /tmp/texra-tui-frames \
  transcript slash-palette bash-approval subagents
```

## PR review automation

The `TeXRA Code Review` workflow runs the external `texra-ai/texra-action`
action and checks out the in-repo review prompts from the base commit, so a
pull request that edits `.github/workflows/texra-code-review.yml` or
`.github/prompts/` never executes untrusted automation from the PR branch
itself.

If GitHub refuses to run a self-editing workflow, or if the provider-side review
service is unavailable, apply the `status:blocked-external` label and leave a
PR comment recording:

- the blocked check or run URL,
- why the failure is external to the proposed code,
- which human-reviewed files replace the missing automated review, and
- which local and CI checks are green.

Only merge such a PR when that comment is present and a maintainer has reviewed
the changed automation or prompt files directly.

## Surfaces to confirm by hand

| Surface                  | Extension (VS Code)                                                                        | Desktop (Electron)                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Launcher (main view)     | Open the TeXRA sidebar; the launcher renders with agent + model pickers.                   | `pnpm --filter @texra/desktop dev` and confirm the launcher mounts on the `main` route.                     |
| Progress board           | Run a tiny agent; the Progress view shows the stream as it ticks.                          | Run a tiny agent; switch to Progress (chrome icon button) and confirm the same stream appears.              |
| Settings tabs            | Open `TeXRA: Open Settings`; cycle tabs (General, Models, Agents, Memory, Plugins, LaTeX). | Click the Settings chrome icon; cycle the same tabs.                                                        |
| Onboarding / walkthrough | First install: VS Code's native walkthrough opens.                                         | First launch: the in-renderer first-run dialog opens; "Got it" persists dismissal.                          |
| Command palette          | VS Code's native palette (`Cmd/Ctrl+Shift+P`) lists `TeXRA: …` commands.                   | The renderer's palette (`Cmd/Ctrl+K` or chrome "Commands" button) lists the same actions.                   |
| Theme switching          | Toggle VS Code light/dark/HC; the webviews follow within ~200ms.                           | Toggle the OS theme; the renderer follows within ~200ms (`nativeTheme` 'updated' → `applyHostBodyTheme()`). |
| Workspace explorer       | n/a — VS Code's native explorer drives selection.                                          | Confirm the desktop explorer lists files and supports double-click → "Use as input/reference/...".          |

## Files that should never diverge between hosts

These have been consolidated and must stay shared. If you find yourself
re-implementing one of these per host, push the new code into
`packages/texra/src/ui/wa/` instead.

- Theme body classes + WA color scheme: `packages/texra/src/ui/wa/hostTheme.ts`
- WA color scheme observer: `packages/texra/src/ui/wa/waColorScheme.ts`
- Action button helper: `packages/texra/src/ui/wa/actionButtons.ts`
- Empty state helper: `packages/texra/src/ui/wa/emptyState.ts`
- Persisted state: `packages/texra/src/shared/state/PersistedState.ts`
- Host bridge: `packages/texra/src/shared/hostBridge.ts`
- Settings tabs: `packages/texra/src/shared/settingsView/settingsTarget.ts` (`SETTINGS_TAB_ORDER`)
