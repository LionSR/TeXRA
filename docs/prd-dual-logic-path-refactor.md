# PRD: Dual Logic Path Consolidation

## Overview

This PRD proposes consolidating five **gross dual logic paths** that currently implement the same
capabilities in parallel across views/managers. The goal is to reduce divergence, simplify
maintenance, and make future changes safer by moving shared behavior into focused, reusable
modules.

## Goals

- Eliminate duplicated logic for the five highest-impact dual paths listed below.
- Centralize shared logic behind clear APIs so views/managers stay thin and consistent.
- Keep behavior unchanged for users and preserve workspace state storage formats.

## Non-goals

- Rewriting entire view stacks or changing the webview UX.
- Introducing new persistence formats or migrations for workspace state.

## Current Dual Logic Paths (Top 5)

1. **Auth status + sign-in flow split between MainView and ProfileView**
   - MainView handles sign-in banner state and post-sign-in checks, while ProfileView separately
     handles authentication checks and user data assembly. The same auth lifecycle is split across
     two places, making it easy for the views to drift. Consolidate into a shared auth/status
     provider used by both view handlers. 【F:src/webview/MainViewMessageHandler.ts†L308-L441】【F:src/profileView/ProfileViewMessageHandler.ts†L87-L168】【F:src/profileView/ProfileViewMessageHandler.ts†L192-L198】

2. **State restore command duplicated in HistoryView + ProgressView**
   - HistoryView restores state from history items, while ProgressView restores state from live
     stream data. Both build task state and call the same command, but the logic diverges across
     two handlers. A shared "restore task state" utility should be used by both. 【F:src/historyView/HistoryViewMessageHandler.ts†L114-L123】【F:src/progressView/ProgressViewMessageHandler.ts†L427-L433】

3. **Latexdiff command assembly duplicated in DiffManager + ProgressView**
   - MainView dispatches `texra.latexdiff`/`texra.latexdiffvc` via `DiffManager`, while ProgressView
     assembles separate latexdiff execution for file comparisons. This is the same command surface
     with different argument assembly logic that should be unified into a shared helper. 【F:src/webview/managers/DiffManager.ts†L15-L63】【F:src/progressView/ProgressViewMessageHandler.ts†L701-L713】【F:src/progressView/ProgressViewMessageHandler.ts†L790-L803】

4. **Recent commit discovery duplicated in DiffManager**
   - `handleRequestRecentCommits` and `handleRefreshCommits` run nearly identical logic for
     repository detection and commit fetch. These should be collapsed into a single helper with an
     optional "notify" flag to keep behavior consistent. 【F:src/webview/managers/DiffManager.ts†L65-L112】

5. **Model/agent options computation duplicated between MainView and ProgressView**
   - Both views fetch model/agent options via the same helpers, but each view owns its own
     orchestration and error handling. A shared options-loading helper would keep the view surfaces
     in sync and reduce maintenance when option formats change. 【F:src/webview/MainViewMessageHandler.ts†L410-L441】【F:src/progressView/ProgressViewMessageHandler.ts†L817-L838】

## Proposed Approach

### Milestone 1: Shared Auth + Profile Data Provider

- Add a `@frontend/auth/authViewData.ts` helper that returns:
  - `authenticated`, `user`, `tier`, `permissions`, `enabledProviders`, `allowedModels`, and
    `bannerVisibility` decisions.
- Update MainView and ProfileView message handlers to call this helper instead of duplicating
  auth lookups and banner decisions.

### Milestone 2: Shared Task State Restore Helper

- Create `@frontend/history/restoreTaskState.ts` that accepts either a history item or a stream
  task state and executes `texra.restoreState`.
- Replace direct restore calls in HistoryView and ProgressView with the helper.

### Milestone 3: Unified Latexdiff Dispatcher

- Add a `@frontend/latex/latexdiffDispatcher.ts` helper that accepts a structured payload
  (`inputFile`, `baseFile`, `editedFile`, `commitHash`, `mode`) and triggers the command.
- Use it in both `DiffManager` and ProgressView file comparison handlers.

### Milestone 4: Commit Discovery Utility

- Extract `getRecentCommits` into `@frontend/git/recentCommits.ts` that returns `{ commits, isGitRepo }`
  plus optional `notifyWhenEmpty` behavior.
- Replace both DiffManager commit handlers with the shared function.

### Milestone 5: Shared Options Loader

- Introduce `@frontend/agents/optionsLoader.ts` that returns model + agent options together, with
  consistent error handling and default merge model lookup.
- Use it in MainView and ProgressView.

## Success Metrics

- All five dual paths are removed and replaced with shared helpers.
- No changes to workspace state schemas or user-visible behavior.
- Lint/build passes and view behavior remains consistent.

## Risks & Mitigations

- **Risk:** Behavior drift between views during refactor.
  - **Mitigation:** Add focused unit tests for new helpers (where possible) and keep existing
    command payload shapes unchanged.
- **Risk:** Shared helpers become too broad.
  - **Mitigation:** Keep helpers thin and view-focused (auth, git, options, latex, restore).
