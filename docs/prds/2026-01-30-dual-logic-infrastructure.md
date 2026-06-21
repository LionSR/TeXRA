---
created: 2026-01-30
updated: 2026-05-04
---

# PRD: Infrastructure & Base Class Consolidation

## Verification Status

Implementation complete (2026-01-30):

| Item                    | Status         | Implementation                                                                                      |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| File selection commands | ✅ Implemented | `@frontend/files/fileSelectionRegistry.ts` - extension command registry used by extension consumers |
| Configuration access    | ✅ Implemented | `@utils/config` expanded with `isConfigExplicitlySet`; `authCommands.ts` migrated                   |
| URI construction        | ✅ Implemented | `buildUri`/`buildUriRecord` changed to `protected`; all content providers use base class methods    |
| File watchers           | ✅ Implemented | `AgentDirectoryManager.watchAgentDirectories` with subscription pattern, deferred promise for race  |
| Active-view tracking    | ✅ Implemented | `withActiveView`/`clearActiveView` in `BaseViewMessageHandler`; cleanup on dispose                  |

## Overview

Consolidate infrastructure-level duplication: command registries, configuration access patterns,
base class visibility issues, file watcher overhead, and message handler boilerplate.

This PRD focuses on **accidental duplication** (same logic copy-pasted) rather than **structural
similarity** (similar patterns with intentionally distinct typed contracts).

## Goals

- Establish single sources of truth for command names, config access, and URI construction.
- Reduce file watcher overhead by sharing watchers across subscribers.
- Extract repeated boilerplate into base classes.
- Keep changes internal (no user-visible behavior changes).

## Non-Goals

- UI redesigns or layout changes.
- Changing saved workspace state schemas.
- Over-abstracting intentionally distinct typed contracts into generic helpers.

## Existing Infrastructure

Leverage these existing base classes rather than duplicating:

- **`BaseViewContentProvider`** (`src/common/webview/BaseViewContentProvider.ts`): Provides private
  `buildUri` and `buildUriRecord` methods for webview URIs, plus `getHtmlContent` for HTML assembly.
- **`BaseViewMessageHandler`** (`src/common/webview/BaseViewMessageHandler.ts`): Provides
  `handleMessage` dispatch, `getActiveView()` for tracked active webview references, and shared error logging.
- **`configUtils`** (`src/utils/config/configUtils.ts`): Wraps `vscode.workspace.getConfiguration`.

---

## Consolidation Items

### 1. File Selection Command Registry

**Priority:** Low risk, high clarity

**Current State:**

- `FileManager` maintains local command maps (`src/webview/managers/FileManager.ts:46-111`)
- `fileSelectionCommands` registers VS Code commands separately (`src/commands/files/fileSelectionCommands.ts:59-89`)

**Refactor:**
Create a shared command map (single module) used by both command registration and FileManager.

**Acceptance Criteria:**

- All file selection commands resolve correctly in webview and command palette.
- No magic string command names remain outside the shared registry.

---

### 2. Configuration Access Consolidation

**Priority:** Low risk, high clarity

**Current State:**

- `authCommands` reads settings directly via `vscode.workspace.getConfiguration('texra.auth')`
- `frontend/setup` uses direct `inspect()` for defaults checks
- `configUtils` already wraps config access centrally but is bypassed

**Refactor:**
Expand `@utils/config` to include:

- Scoped config access: `getConfig('texra.auth', 'apiKey')`
- Explicit-value inspection (checking if value is explicitly set vs. default)
- Migrate all direct `vscode.workspace.getConfiguration` calls

**Acceptance Criteria:**

- All direct `getConfiguration` calls outside `@utils/config` are migrated.
- Inspection semantics work correctly in `setup.ts` flows.

---

### 3. Webview URI Construction Visibility

**Priority:** Medium risk

**Current State:**
`BaseViewContentProvider.buildUri` and `buildUriRecord` are **private**, forcing subclasses to
inline identical URI construction:

- `MainViewContentProvider` builds `dist/webview/bundle.js`
- `HistoryViewContentProvider` builds `dist/historyView/bundle.js`
- `MemoryViewContentProvider` builds `dist/memoryView/bundle.js`
- `ProfileViewContentProvider` builds `dist/profileView/bundle.js`
- `ProgressViewContentProvider` builds `dist/progressView/bundle.js` and CSS

**Refactor:**
Change `buildUri`/`buildUriRecord` from `private` to `protected`. Optionally add declarative
configuration where subclasses specify `viewKey` and optional CSS flag.

**Acceptance Criteria:**

- All webviews load correctly in development and production.
- Subclasses declare bundle entries declaratively; no manual URI construction.

---

### 4. Agent Directory File Watchers

**Priority:** Medium risk, needs design detail

**Current State:**
Two separate watchers monitor overlapping directories:

- `MainViewProvider` (`src/MainViewProvider.ts:42-43, 62-63`): Pattern `**/*.yaml`, debounce 500ms
- `WatcherManager` (`src/explorer/WatcherManager.ts:17-80`): Pattern `**/*`, debounce 200ms

Valid separation of concerns (UI vs explorer) but duplicated mechanism.

**Refactor:**
Introduce `AgentDirectoryManager` that owns `FileSystemWatcher` lifecycle with callback registry.
Subscribers configure:

- Glob pattern filtering
- Debounce interval
- Handler callback

**Acceptance Criteria:**

- Agent option refresh in MainView works identically.
- Explorer refresh and YAML validation work identically.
- Only one set of `FileSystemWatcher` instances for agent directories.

---

### 5. Active-View Tracking Boilerplate

**Priority:** Low risk, narrow scope

**Current State:**
Each message handler repeats boilerplate for active-view tracking:

- `MainViewMessageHandler` sets active view, dispatches via `dispatchMainViewInbound`
- `HistoryViewMessageHandler` sets active view, dispatches via `dispatchHistoryViewInbound`

Typed dispatch is intentionally per-view (distinct discriminated unions).

**Refactor:**
Extract only active-view tracking (set on message, clear on dispose) into `BaseViewMessageHandler`.
Do **not** consolidate typed dispatch functions.

**Acceptance Criteria:**

- Active-view tracking works identically for all views.
- Typed dispatch remains per-view with no generic wrapper.

**Expected Impact:** Removes ~3 lines of boilerplate per handler.

---

## Milestones

### Phase 1a: Low-Risk Consolidations (Items 1, 2, 5) ✅ COMPLETE

- [x] Extension file selection command registry - `@frontend/files/fileSelectionRegistry.ts`
- [x] Expanded `@utils/config` with `isConfigExplicitlySet` inspection semantics
- [x] Active-view tracking via `withActiveView`/`clearActiveView` in `BaseViewMessageHandler`

### Phase 1b: Medium-Risk Consolidations (Items 3, 4) ✅ COMPLETE

- [x] Expose `BaseViewContentProvider.buildUri`/`buildUriRecord` as `protected`
- [x] `AgentDirectoryManager.watchAgentDirectories` with subscription-based callback registry
- [x] Fixed race condition: deferred promise pattern prevents concurrent rebuilds
- [x] Fixed config watcher lifecycle: separated file watcher disposal from config watcher disposal

### Verification ✅ COMPLETE

- [x] `npm run typecheck` passes
- [x] All webview content providers use `buildUri` helper
- [x] Agent watcher used by both `MainViewProvider` and `WatcherManager`
- [x] Race condition fixed: `ensureAgentWatchers` sets promise before `getAllLocal()`
- [x] `buildAgentWatchers` simplified to synchronous (no async needed)

---

## Risks & Mitigations

| Risk                                       | Mitigation                                               |
| ------------------------------------------ | -------------------------------------------------------- |
| Consolidation hides view-specific behavior | Keep view-specific overrides as explicit options         |
| Watcher consolidation misses edge cases    | Add unit coverage; document behavioral differences first |
| Command registry breaks UI integration     | Add tests for command maps; smoke run validation         |
| Over-abstracting typed dispatch            | Item 5 scoped to tracking only; dispatch stays per-view  |

## Open Questions (Resolved)

- ~~Are there view-specific bundle assets beyond CSS that should be in a formal manifest?~~ → Current declarative approach with `getModuleUris()` is sufficient
- ~~For `AgentDirectoryManager`: simple callback registry (recommended) or lightweight event bus?~~ → Implemented as simple callback registry with subscription pattern via `watchAgentDirectories()`
