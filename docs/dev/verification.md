# Manual Verification Matrix

Use this checklist after touching shared frontend code (`src/shared/`,
`packages/extension/src/common/webview/`,
`packages/extension/src/{webview,progressView,settingsView}/frontend/`,
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

# CLI TUI frame validator — drives the Ink TUI through a PTY and checks the
# visible terminal frame for chat, slash commands, approvals, subagents, and
# compact layouts. If the optional native node-pty dependency is unavailable,
# the validator prints a skip notice instead of failing the install.
corepack pnpm --filter @texra-ai/cli validate:tui

# CLI TUI snapshot report — use this when a PR or issue needs terminal
# screenshots for product review. It writes numbered .txt/.svg frames and an
# index.html report under the requested directory.
corepack pnpm --filter @texra-ai/cli validate:tui --snapshot-dir /tmp/texra-tui-frames \
  transcript slash-palette bash-approval subagents
```

## PR review automation

Every pull request should keep the required checks green, including the Claude
review jobs. One special case needs an explicit rule: a pull request may edit
the review workflow or its review prompts. In that case the
review job must not run untrusted automation from the pull request itself.

The repository handles this by running the pull request through trusted
automation. The provider wrapper is external to this repository
(`LionSR/agent-ci-actions@v1`), so a pull request cannot alter its
implementation in this tree. The in-repo prompts can still be edited by a pull
request, so the `Claude Code Review` workflow checks out the base branch into
`.trusted-actions` and runs with the prompt files from that directory. This
means changes to
`.github/workflows/claude-code-review.yml` or `.github/prompts/` are still
reviewed, but the changed prompts only take effect after the PR is merged.

If GitHub refuses to run a self-editing workflow, or if the provider-side review
service is unavailable, do not treat the missing review as silently acceptable.
Use the `status:blocked-external` label and leave a PR comment that records:

- the blocked check or run URL,
- why the failure is external to the proposed code,
- which human-reviewed files replace the missing automated review, and
- which local and CI checks are green.

Only merge such a PR when that comment is present and a maintainer has reviewed
the changed automation or prompt files directly.

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
- Persisted state: `src/shared/state/PersistedState.ts`
- Host bridge: `src/shared/hostBridge.ts`
- Settings tabs: `src/shared/schemas/settingsViewMessages.ts` (`SETTINGS_TAB_ORDER`)
