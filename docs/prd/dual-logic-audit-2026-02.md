# PRD: Dual-Logic Consolidation Audit (2026-02)

## Implementation Status

Proposal drafted (2026-02-XX). No implementation yet.

| Area                  | Item                                       | Status   |
| --------------------- | ------------------------------------------ | -------- |
| **MainView**          | Options refresh pathways                   | Proposed |
| **Files**             | File watcher extension lists               | Proposed |
| **Panels**            | History/Profile/Memory panel orchestration | Proposed |
| **Content Providers** | Single-bundle URI mapping                  | Proposed |
| **Message Handling**  | Schema dispatch boilerplate                | Proposed |

## Overview

This PRD documents the **five most impactful dual-logic paths** that should be consolidated.
These are cases where the same feature logic is implemented in multiple places, increasing
maintenance cost and the chance of drift.

The goal is to reduce duplication without changing user-visible behavior or saved workspace
state schemas.

## Goals

- Remove duplicate logic that already has a clear single source of truth.
- Make future changes require edits in one place instead of many.
- Keep refactors internal (no UI redesigns or state schema changes).

## Non-Goals

- Changing workspace state schemas or stored data.
- Re-architecting webview types or message schemas.
- Introducing new abstraction layers unless they reduce duplication meaningfully.

---

## 1. MainView Options Refresh (Provider vs Commands)

**Priority:** High

**Current State:**

- `MainViewProvider` refreshes agent/model options and posts messages directly.
- `mainViewCommands` repeats the same refresh logic for command-palette entry points.
- `@frontend/agents/optionsLoader.ts` already exists but is not used here.

This creates two separate refresh paths that must stay in sync (error handling, refresh timing,
message payload structure).

**Refactor:**

- Introduce a shared `MainViewOptionsRefresher` (or reuse `loadOptions`) that encapsulates:
  - `refresh()` for agent index
  - `computeAgentOptionsData` / `computeModelOptionsData`
  - webview message posting
- Use the shared path from both `MainViewProvider` and `mainViewCommands`.

**Acceptance Criteria:**

- `MainViewProvider` and `mainViewCommands` both use the shared options refresher.
- Only one place constructs and posts the agent/model options payloads.

**Evidence:**

- `MainViewProvider.refreshAgentOptions` / `refreshModelOptions` / `refreshOptionsAndView` duplicate
  the same flow of refresh + compute + post message.
- `mainViewCommands.refresh*` repeats the same logic with the same payloads.

---

## 2. File Watcher Extensions vs File Type Registry

**Priority:** High

**Current State:**

- `MainViewProvider.setupFileWatcher` hardcodes a long list of extensions in a glob pattern.
- `getIncludedExtensions` in `@common/files/fileTypeUtils` is already the canonical registry for
  file-type inclusion logic used elsewhere (file listing, filtering, etc.).

This is a dual-logic path: the file watcher can drift from the centralized extension registry,
creating inconsistent file refresh behavior.

**Refactor:**

- Build the file watcher pattern dynamically from `getIncludedExtensions(...)` for each category
  (input/reference/auxiliary/media/audio/edited).
- Consolidate file extension inclusion into the shared file-type registry.

**Acceptance Criteria:**

- `MainViewProvider` derives its file watcher extension list from `getIncludedExtensions`.
- Adding/removing extensions in config or code affects both file listing and file watching
  consistently.

**Evidence:**

- Hardcoded file extension list exists in `MainViewProvider.setupFileWatcher`.
- `getIncludedExtensions` already centralizes allowed extensions.

---

## 3. Secondary Panel Orchestration (History/Profile/Memory)

**Priority:** Medium

**Current State:**

- `HistoryViewProvider.showHistoryView`, `ProfileViewProvider.showProfileView`, and
  `MemoryViewProvider.showMemoryView` all do the same pattern:
  1. `createOrShowPanel(...)`
  2. if existing, send data to webview

The logic is duplicated across three providers.

**Refactor:**

- Add a helper to `BaseWebviewProvider` that accepts:
  - panel metadata (view type, title, view path)
  - a callback to refresh data if already open
- Replace the three view-specific `showXView` methods with the shared helper.

**Acceptance Criteria:**

- The History/Profile/Memory panels use a shared panel-open helper.
- View-specific data refresh remains in dedicated callbacks.

**Evidence:**

- Identical panel open + data refresh pattern exists across three providers.

---

## 4. Single-Bundle Content Providers (URI Map Duplication)

**Priority:** Medium

**Current State:**

- `MainViewContentProvider`, `HistoryViewContentProvider`, `MemoryViewContentProvider`, and
  `ProfileViewContentProvider` all implement identical `getModuleUris` logic, differing only
  in the bundle folder name and key.

This is a duplicate logic path for a standardized pattern.

**Refactor:**

- Add a helper in `BaseViewContentProvider` to build single-bundle URI maps based on a
  `viewKey` and `bundleKey` configuration.
- Replace explicit `getModuleUris` overrides with configuration-driven defaults.

**Acceptance Criteria:**

- Single-bundle content providers no longer repeat manual `buildUri` calls.
- Updating bundle paths or file names is done in one shared helper.

**Evidence:**

- The four single-bundle content providers build identical `dist/<view>/bundle.js` URIs.

---

## 5. Schema Dispatch Boilerplate in Message Handlers

**Priority:** Medium

**Current State:**

- `HistoryViewMessageHandler`, `MemoryViewMessageHandler`, and `ProfileViewMessageHandler`
  share identical message-handling boilerplate:
  - `withActiveView(...)`
  - `dispatch*Inbound(...)`
  - identical validation error logging
  - identical "Unhandled command" warning

This increases maintenance cost for any change in dispatch mechanics.

**Refactor:**

- Add a reusable dispatch helper in `BaseViewMessageHandler` that accepts:
  - `dispatchFn`
  - `handlerRegistry`
  - `view`
- Keep per-view schemas and handler registries unchanged.

**Acceptance Criteria:**

- History/Memory/Profile handlers delegate to a shared dispatch helper.
- Logging and unhandled-command behavior remains consistent across views.

**Evidence:**

- The three message handlers have identical `handleMessage` bodies except for the
  dispatch function used.

---

## Risks & Mitigations

| Risk                                            | Mitigation                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Abstraction becomes too generic                 | Keep helpers narrowly scoped to the repeated patterns only.       |
| Behavior drift in webview updates               | Add targeted tests or manual checks for each view before release. |
| Over-consolidation breaks view-specific nuances | Allow opt-out per view (e.g., custom overrides).                  |

## Open Questions

- Should the shared MainView options refresher live in `@frontend/agents/` or `@common/webview`?
- Is it worth standardizing `showXView` naming if we move logic into `BaseWebviewProvider`?
