# PRD: Duplicated Logic Path Consolidation

## Overview

This PRD proposes consolidating four high-impact duplicated logic paths that currently implement the
same capabilities in parallel across views/managers. The goal is to reduce divergence, simplify
maintenance, and make future changes safer by moving shared behavior into focused, reusable modules.

## Goals

- Eliminate duplicated logic for the four highest-impact paths listed below.
- Centralize shared logic behind clear APIs so views/managers stay thin and consistent.
- Keep behavior unchanged for users and preserve workspace state storage formats.

## Non-goals

- Rewriting entire view stacks or changing the webview UX.
- Introducing new persistence formats or migrations for workspace state.
- Consolidating code that shares an API but serves different responsibilities (e.g., MainView auth
  banner checks vs. ProfileView profile data assembly).

## Current Duplicated Logic Paths

### 1. Recent commit discovery duplicated within DiffManager

`handleRequestRecentCommits` and `handleRefreshCommits` in `DiffManager` (`src/webview/managers/DiffManager.ts`) run nearly identical logic for repository detection and commit fetch. `handleRefreshCommits` is a strict subset of `handleRequestRecentCommits`. These should be collapsed into a single helper with an optional "notify" flag.

**Priority: Highest** — identical code in the same file, simplest to consolidate.

### 2. Latexdiff command assembly duplicated in DiffManager + ProgressView

MainView dispatches latexdiff via `DiffManager` (`src/webview/managers/DiffManager.ts`), while `ProgressViewMessageHandler` (`src/progressView/ProgressViewMessageHandler.ts`) assembles separate latexdiff execution for file comparisons. This is the same command surface with different argument assembly logic that should be unified into a shared dispatcher.

### 3. Model/agent options computation duplicated between MainView and ProgressView

Both `MainViewMessageHandler` (`src/webview/MainViewMessageHandler.ts`) and `ProgressViewMessageHandler` (`src/progressView/ProgressViewMessageHandler.ts`) fetch model/agent options via the same helpers, but each view owns its own orchestration and error handling. A shared options-loading helper would keep the view surfaces in sync.

### 4. State restore command duplicated in HistoryView + ProgressView

`HistoryViewMessageHandler` (`src/historyView/HistoryViewMessageHandler.ts`) restores state from history items, while `ProgressViewMessageHandler` restores state from live stream data. Both build task state and call the same command.

**Note:** Each restore path is ~5 lines that call `vscode.commands.executeCommand`. A shared helper here should only be pursued if it encapsulates meaningful logic beyond a trivial wrapper. If the only shared code is the command invocation itself, this path may not warrant extraction per the project's anti-abstraction guidance.

## Dropped: Auth status split (MainView / ProfileView)

Originally listed as a duplicated path, but on review MainView and ProfileView handle **different responsibilities**: MainView checks `getAuthStatus()` to toggle a sign-in banner (~20 lines), while ProfileView assembles comprehensive profile data (user details, tier, permissions, remote agents, server-side keys, model access). Both calling `AUTH_COMMANDS.SIGN_IN` is normal delegation to a shared command, not duplication. Consolidating these would conflate distinct concerns.

## Proposed Approach

### Milestone 1: Commit Discovery Utility (Quick Win)

- Extract shared commit-fetch logic from `DiffManager` into `@frontend/git/recentCommits.ts` returning `{ commits, isGitRepo }` with optional `notifyWhenEmpty` behavior.
- Replace both `handleRequestRecentCommits` and `handleRefreshCommits` with the shared function.

### Milestone 2: Unified Latexdiff Dispatcher

- Add `@frontend/latex/latexdiffDispatcher.ts` that accepts a structured payload (`inputFile`, `baseFile`, `editedFile`, `commitHash`, `mode`) and triggers the command.
- Use it in both `DiffManager` and ProgressView file comparison handlers.

### Milestone 3: Shared Options Loader

- Introduce `@frontend/agents/optionsLoader.ts` that returns model + agent options together, with consistent error handling and default merge model lookup.
- Use it in MainView and ProgressView.

### Milestone 4: Evaluate State Restore Helper

- Assess whether the shared logic justifies a helper or is too trivial to extract.
- If justified, create `@frontend/history/restoreTaskState.ts` that accepts either a history item or stream task state and executes the restore command.

## Success Metrics

- All consolidated paths are replaced with shared helpers.
- No changes to workspace state schemas or user-visible behavior.
- Lint and build pass (`npm run lint`, `npm run compile:fast`).
- Manual verification: each view's behavior remains consistent after each milestone.

## Validation Strategy

Since `npm test` is not viable in this project (it attempts to download a VS Code test environment), validation relies on:
- `npm run typecheck` to verify no type regressions.
- `npm run lint` for zero errors.
- `npm run compile:fast` for successful builds.
- Manual smoke testing of affected views after each milestone.

## Risks & Mitigations

- **Risk:** Behavior drift between views during refactor.
  - **Mitigation:** Ship one milestone at a time. Run typecheck + lint + build after each. Manually verify affected views.
- **Risk:** Shared helpers become too broad.
  - **Mitigation:** Keep helpers thin and view-focused (git, options, latex, restore). Follow the project's guidance against premature abstraction.
