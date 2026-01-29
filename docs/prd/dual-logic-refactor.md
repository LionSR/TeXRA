# PRD: Dual Logic Path Refactor (Phase 1)

## Overview

Reduce the most impactful duplicated logic paths by consolidating five pairs of parallel implementations
that currently split responsibility across multiple files. The goal is to simplify maintenance,
reduce change amplification, and make future feature work less error-prone.

## Problem Statement

The codebase contains several high-impact areas where the same responsibilities are implemented in
multiple places. These “dual logic paths” cause:

- **Change amplification**: Updates must be made in multiple files to keep behavior in sync.
- **Inconsistent behavior**: Slight differences lead to hard-to-debug edge cases.
- **Hidden coupling**: The same domain concept is split across multiple layers without a shared API.

The five most impactful dual logic paths are listed below with current evidence and proposed
refactoring targets.

## Goals

- Consolidate the five highest-impact dual logic paths into single, shared abstractions.
- Reduce duplication while keeping current behavior stable.
- Make future changes to these areas require edits in one place.

## Non-Goals

- Rewriting UI or agent flows beyond the five identified refactors.
- Large-scale structural changes that require migrating persisted workspace state.
- Changing user-facing behaviors unless strictly necessary for consolidation.

## Dual Logic Paths & Refactor Plans

### 1) Webview bundle URI construction duplicated across content providers

**Current dual paths**

Each view content provider manually builds `dist/<view>/bundle.js` URIs (and sometimes CSS) with
near-identical logic. This is repeated in every view-specific content provider.

- `MainViewContentProvider` builds `dist/webview/bundle.js`.【F:src/webview/MainViewContentProvider.ts†L1-L25】
- `HistoryViewContentProvider` builds `dist/historyView/bundle.js`.【F:src/historyView/HistoryViewContentProvider.ts†L1-L27】
- `MemoryViewContentProvider` builds `dist/memoryView/bundle.js`.【F:src/memoryView/MemoryViewContentProvider.ts†L1-L27】
- `ProfileViewContentProvider` builds `dist/profileView/bundle.js`.【F:src/profileView/ProfileViewContentProvider.ts†L1-L27】
- `ProgressViewContentProvider` builds `dist/progressView/bundle.js` and CSS.【F:src/progressView/ProgressViewContentProvider.ts†L1-L31】

**Refactor plan**

Introduce a shared helper in `BaseViewContentProvider` to build standard bundle and style URIs from a
single `viewKey` + optional CSS flag. Migrate view providers to declaratively define their bundle
entries instead of duplicating logic.

**Expected impact**

- One location to update if bundle paths change.
- Fewer errors when adding new views.

### 2) Webview message dispatch & active-view tracking repeated per view

**Current dual paths**

Multiple message handlers repeat the same steps: attach/track the active view, dispatch a schema-based
handler registry, and log unhandled commands. This appears across views.

- `MainViewMessageHandler` sets active view, dispatches schema handlers, and falls back to base logic.【F:src/webview/MainViewMessageHandler.ts†L35-L86】
- `HistoryViewMessageHandler` sets active view, dispatches schema handlers, and logs unhandled commands.【F:src/historyView/HistoryViewMessageHandler.ts†L37-L77】

**Refactor plan**

Add a shared `dispatchInbound` helper in `BaseViewMessageHandler` that takes a schema dispatch function
and registry. Message handlers would only supply registry definitions, not the orchestration logic.

**Expected impact**

- Message handlers become smaller and more consistent.
- One place to adjust dispatch semantics (validation, logging).

### 3) Agent directory watching duplicated across view + explorer layers

**Current dual paths**

Agent directory changes are observed in multiple places with separate file watchers:

- `MainViewProvider` creates a watcher for agent YAMLs to refresh agent options.【F:src/MainViewProvider.ts†L120-L199】
- `WatcherManager` also watches built-in and custom agent directories for explorer refresh and YAML
  validation.【F:src/explorer/WatcherManager.ts†L35-L145】

**Refactor plan**

Move agent directory watch orchestration into `AgentDirectoryManager` as a shared observable. Both
MainView and Explorer would subscribe to a single source of events, with specialized callbacks
(refresh UI vs validate YAML).

**Expected impact**

- One watcher graph for agent directories.
- Reduced file watcher overhead and duplication.

### 4) File selection command registry duplicated in UI and command layers

**Current dual paths**

Command names and response mappings are declared separately in UI logic and command registration:

- `FileManager` maintains local command maps for selection and responses.【F:src/webview/managers/FileManager.ts†L42-L107】
- `fileSelectionCommands` registers the actual VS Code commands for those same operations.【F:src/commands/files/fileSelectionCommands.ts†L59-L126】

**Refactor plan**

Create a shared command map (exported from a single module) used by both the command registration and
FileManager. This makes command names a single source of truth and prevents drift.

**Expected impact**

- One authoritative registry for file selection commands.
- Fewer mismatches between UI events and command handlers.

### 5) Configuration access split between helpers and raw VS Code API

**Current dual paths**

Configuration access is split between the helper utilities and direct `vscode.workspace.getConfiguration`
usage, leading to inconsistent defaults and inspection behavior.

- `authCommands` reads settings directly via `vscode.workspace.getConfiguration('texra.auth')`.
  【F:src/auth/authCommands.ts†L24-L47】
- `frontend/setup` uses direct config inspection for defaults checks.【F:src/frontend/setup.ts†L96-L115】
- `configUtils` already wraps configuration access and updates centrally.【F:src/utils/config/configUtils.ts†L1-L90】

**Refactor plan**

Expand `@utils/config` to include standardized helpers for scoped configs and explicit-value checks.
Update callers to use the shared helpers, ensuring consistent behavior for defaults, inspection, and
future telemetry hooks.

**Expected impact**

- Consistent config handling across features.
- Simplified debugging when settings change.

## Milestones

1. **Design & mapping**
   - Document new helper APIs for content providers, message dispatch, directory watchers, command
     registry, and config helpers.
2. **Refactor implementation**
   - Land incremental changes per area with existing behavior preserved.
3. **Verification**
   - Ensure compile:fast and lint pass, validate UI flows in relevant webviews.

## Risks & Mitigations

- **Risk**: Consolidation might hide view-specific behavior.
  - **Mitigation**: Keep view-specific overrides as explicit options on shared helpers.
- **Risk**: Watcher consolidation could miss edge cases.
  - **Mitigation**: Add unit coverage for watcher event routing and agent directory inclusion.
- **Risk**: Command registry changes might break UI integration.
  - **Mitigation**: Add tests for command maps and validate in a smoke run.

## Open Questions

- Should the consolidated message dispatch helper live in `BaseViewMessageHandler` or a shared
  `@common/webview` utility module?
- Are there view-specific bundle assets beyond CSS that should be declared in a formal manifest map?
- Do we need a lightweight event bus for agent directory watcher subscriptions, or is a simple
  callback registry sufficient?
