# PRD: Dual Logic Path Refactor (Phase 1)

## Overview

Reduce the most impactful duplicated logic paths by consolidating parallel implementations
that currently split responsibility across multiple files. The goal is to simplify maintenance,
reduce change amplification, and make future feature work less error-prone.

This PRD distinguishes between *accidental duplication* (same logic copy-pasted, should be
consolidated) and *structural similarity* (similar patterns with intentionally distinct typed
contracts, which may be fine as-is). Only accidental duplication is targeted for consolidation.

## Problem Statement

The codebase contains several high-impact areas where the same responsibilities are implemented in
multiple places. These "dual logic paths" cause:

- **Change amplification**: Updates must be made in multiple files to keep behavior in sync.
- **Inconsistent behavior**: Slight differences lead to hard-to-debug edge cases.
- **Hidden coupling**: The same domain concept is split across multiple layers without a shared API.

## Goals

- Consolidate the highest-impact dual logic paths into single, shared abstractions.
- Reduce duplication while keeping current behavior stable.
- Make future changes to these areas require edits in one place.

## Non-Goals

- Rewriting UI or agent flows beyond the identified refactors.
- Large-scale structural changes that require migrating persisted workspace state.
- Changing user-facing behaviors unless strictly necessary for consolidation.
- Over-abstracting intentionally distinct typed contracts into generic helpers.

## Existing Infrastructure

The following shared base classes already exist and should be leveraged rather than duplicated:

- **`BaseViewContentProvider`** (`src/common/webview/BaseViewContentProvider.ts`): Provides private
  `buildUri` and `buildUriRecord` methods for converting extension-relative paths to webview URIs,
  plus `getHtmlContent` for full HTML assembly with template substitution.
- **`BaseViewMessageHandler`** (`src/common/webview/BaseViewMessageHandler.ts`): Provides
  `handleMessage` dispatch with error handling, `getActiveView()` for tracked active webview access,
  and `withValidatedMessage` for Zod schema validation with consistent error logging.
- **`configUtils`** (`src/utils/config/configUtils.ts`): Wraps `vscode.workspace.getConfiguration`
  for centralized read/write access.

Refactors below describe the *delta* from what these base classes already provide.

## Dual Logic Paths & Refactor Plans

Items are ordered by risk/reward ratio — low-risk, high-clarity wins first.

### 1) File selection command registry duplicated in UI and command layers

**Priority**: Low risk, high clarity

**Current dual paths**

Command names and response mappings are declared separately in UI logic and command registration:

- `FileManager` maintains local command maps for selection and responses
  (`src/webview/managers/FileManager.ts`)
- `fileSelectionCommands` registers the actual VS Code commands for those same operations
  (`src/commands/files/fileSelectionCommands.ts`)

**Refactor plan**

Create a shared command map (exported from a single module) used by both the command registration and
FileManager. This makes command names a single source of truth and prevents drift.

**Acceptance criteria**

- All file selection commands resolve correctly in both webview and command palette contexts.
- No magic string command names remain outside the shared registry module.

**Expected impact**

- One authoritative registry for file selection commands.
- Fewer mismatches between UI events and command handlers.

### 2) Configuration access split between helpers and raw VS Code API

**Priority**: Low risk, high clarity

**Current dual paths**

Configuration access is split between the helper utilities and direct `vscode.workspace.getConfiguration`
usage, leading to inconsistent defaults and inspection behavior.

- `authCommands` reads settings directly via `vscode.workspace.getConfiguration('texra.auth')`
  (`src/auth/authCommands.ts`)
- `frontend/setup` uses direct config inspection via `inspect()` for defaults checks
  (`src/frontend/setup.ts`)
- `configUtils` already wraps configuration access and updates centrally
  (`src/utils/config/configUtils.ts`)

**Refactor plan**

Expand `@utils/config` to include standardized helpers for:
- Scoped config access (e.g., `getConfig('texra.auth', 'apiKey')`)
- Explicit-value inspection (checking if a value is explicitly set vs. using the default),
  covering the `inspect()` semantics currently used in `setup.ts`
- Future telemetry hooks

Update callers to use the shared helpers, ensuring consistent behavior for defaults and inspection.

**Acceptance criteria**

- All direct `vscode.workspace.getConfiguration` calls outside `@utils/config` are migrated.
- Inspection semantics (explicit vs. default value detection) work correctly in `setup.ts` flows.

**Expected impact**

- Consistent config handling across features.
- Simplified debugging when settings change.

### 3) Webview bundle URI construction duplicated across content providers

**Priority**: Medium risk

**Current dual paths**

Each view content provider manually builds `dist/<view>/bundle.js` URIs (and sometimes CSS) with
near-identical logic, despite `BaseViewContentProvider` already providing private `buildUri` and
`buildUriRecord` methods.

- `MainViewContentProvider` builds `dist/webview/bundle.js`
  (`src/webview/MainViewContentProvider.ts`)
- `HistoryViewContentProvider` builds `dist/historyView/bundle.js`
  (`src/historyView/HistoryViewContentProvider.ts`)
- `MemoryViewContentProvider` builds `dist/memoryView/bundle.js`
  (`src/memoryView/MemoryViewContentProvider.ts`)
- `ProfileViewContentProvider` builds `dist/profileView/bundle.js`
  (`src/profileView/ProfileViewContentProvider.ts`)
- `ProgressViewContentProvider` builds `dist/progressView/bundle.js` and CSS
  (`src/progressView/ProgressViewContentProvider.ts`)

**Refactor plan**

Expose or extend the existing `BaseViewContentProvider.buildUri`/`buildUriRecord` methods (currently
private) so subclasses can declaratively specify a `viewKey` and optional CSS flag rather than
reimplementing URI construction. The delta is small — primarily changing method visibility and adding
a declarative configuration interface.

**Acceptance criteria**

- All webviews load correctly in both development and production builds.
- Subclasses declare bundle entries declaratively; no manual URI construction in view providers.

**Expected impact**

- One location to update if bundle paths change.
- Fewer errors when adding new views.

### 4) Agent directory watching duplicated across view + explorer layers

**Priority**: Medium risk, needs design detail

**Current dual paths**

Agent directory changes are observed in multiple places with separate file watchers that serve
different purposes:

- `MainViewProvider` creates a watcher for agent YAMLs to refresh agent options in the UI
  (`src/MainViewProvider.ts`)
- `WatcherManager` watches built-in and custom agent directories for explorer refresh and YAML
  validation with different glob patterns and debounce constants
  (`src/explorer/WatcherManager.ts`)

Note: The current split (MainViewProvider owns UI-relevant watching, WatcherManager owns
explorer-relevant watching) represents a valid separation of *concerns*. The issue is the
duplicated *mechanism* — two separate `FileSystemWatcher` instances monitoring overlapping
directories.

**Refactor plan**

Introduce a shared `AgentDirectoryManager` that owns the `FileSystemWatcher` lifecycle and exposes
a callback registry for subscribers. Each subscriber configures its own:
- Glob pattern filtering (UI may watch fewer patterns than explorer)
- Debounce interval
- Handler callback (refresh UI vs. validate YAML vs. refresh explorer)

The manager aggregates raw file system events; subscribers apply their own filtering and timing.

**Acceptance criteria**

- Agent option refresh in MainView works identically to current behavior.
- Explorer refresh and YAML validation in WatcherManager work identically.
- Only one set of `FileSystemWatcher` instances exists for agent directories.

**Expected impact**

- One watcher graph for agent directories.
- Reduced file watcher overhead.

### 5) Active-view tracking boilerplate repeated per message handler

**Priority**: Low risk, narrow scope (scoped down from original item 2)

**Current state**

Each view's message handler repeats a small amount of boilerplate for active-view tracking and
unhandled-command logging. However, the dispatch logic itself is intentionally distinct per view:
each view uses a typed, schema-specific dispatcher (`dispatchMainViewInbound` vs.
`dispatchHistoryViewInbound`) backed by `createDispatcher()` from `src/shared/utils/dispatcher.ts`,
with its own discriminated union and handler registry.

This structural similarity is by design — consolidating the typed dispatch into a generic helper
would obscure type safety without meaningful reduction in code.

- `MainViewMessageHandler` sets active view, dispatches via `dispatchMainViewInbound`
  (`src/webview/MainViewMessageHandler.ts`)
- `HistoryViewMessageHandler` sets active view, dispatches via `dispatchHistoryViewInbound`
  (`src/historyView/HistoryViewMessageHandler.ts`)

**Refactor plan**

Extract only the active-view tracking boilerplate (set active view on message, clear on dispose)
into `BaseViewMessageHandler` — which already supports `trackActiveView` and `getActiveView()`.
Do **not** consolidate the typed dispatch functions, as they are intentionally distinct.

Scope is narrow: a small utility extraction, not a dispatch abstraction.

**Acceptance criteria**

- Active-view tracking works identically for all views.
- Typed dispatch remains per-view with no generic wrapper.

**Expected impact**

- Removes ~3 lines of boilerplate per message handler.
- No risk to type safety of dispatch.

## Milestones

Ordered by risk/reward — land low-risk items first to build confidence.

1. **Phase 1a: Low-risk consolidations** (items 1, 2, 5)
   - Shared file selection command registry.
   - Expanded `@utils/config` with inspection semantics.
   - Active-view tracking extraction into base class.
2. **Phase 1b: Medium-risk consolidations** (items 3, 4)
   - Expose `BaseViewContentProvider` URI helpers to subclasses.
   - `AgentDirectoryManager` with callback registry.
3. **Verification**
   - Ensure `compile:fast` and `lint` pass.
   - Validate UI flows in all webviews (main, history, memory, profile, progress).
   - Verify agent option refresh and explorer watcher behavior.

## Risks & Mitigations

- **Risk**: Consolidation might hide view-specific behavior.
  - **Mitigation**: Keep view-specific overrides as explicit options on shared helpers.
- **Risk**: Watcher consolidation could miss edge cases (different glob patterns, debounce timing).
  - **Mitigation**: Add unit coverage for watcher event routing and agent directory inclusion.
    Document behavioral differences between current watchers before consolidating.
- **Risk**: Command registry changes might break UI integration.
  - **Mitigation**: Add tests for command maps and validate in a smoke run.
- **Risk**: Over-abstracting typed dispatch into a generic helper.
  - **Mitigation**: Item 5 is scoped to active-view tracking only; typed dispatch stays per-view.

## Open Questions

- Are there view-specific bundle assets beyond CSS that should be declared in a formal manifest map?
- For the `AgentDirectoryManager`, should subscribers register via a simple callback registry
  (recommended — simpler for 2 subscribers) or a lightweight event bus?
