# PRD: Dual-Logic Consolidation Audit (2026-02)

## Implementation Status

Proposal drafted (2026-02-01). No implementation yet.

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

**Priority:** High — this is the most frequently exercised refresh path (every agent/model
change triggers it), so drift here causes the most user-visible inconsistency.

**Current State:**

- `MainViewProvider` refreshes agent/model options and posts messages directly.
- `mainViewCommands` repeats the same refresh logic for command-palette entry points.
- `@frontend/agents/optionsLoader.ts` already provides `loadOptions()`, which calls
  `computeModelOptionsData()` and `computeAgentOptionsData()` in parallel and returns an
  `OptionsPayload`. This is not currently wired into either refresh path.

This creates two separate refresh paths that must stay in sync (error handling, refresh timing,
message payload structure).

**Refactor:**

- **Primary recommendation:** Reuse `loadOptions()` from `@frontend/agents/optionsLoader.ts` as the
  single source of truth for options computation. Both `MainViewProvider` and `mainViewCommands`
  should call `loadOptions()` and post the resulting payload.
- Do **not** introduce a new `MainViewOptionsRefresher` class — per project guidelines on flattening
  abstraction layers and avoiding discouraged factory patterns, adding a new wrapper around an
  existing function is unnecessary indirection. A new class is only justified if `loadOptions`
  genuinely cannot serve the purpose (e.g., requires lifecycle state that a pure function cannot
  capture).

**Acceptance Criteria:**

- `MainViewProvider` and `mainViewCommands` both call `loadOptions()` for options data.
- Only one place constructs and posts the agent/model options payloads.

**Evidence:**

- `MainViewProvider.refreshAgentOptions` / `refreshModelOptions` / `refreshOptionsAndView` duplicate
  the same flow of refresh + compute + post message.
- `mainViewCommands.refresh*` repeats the same logic with the same payloads.
- `loadOptions()` already performs the identical computation but is unused here.

---

## 2. File Watcher Extensions vs File Type Registry

**Priority:** High — hardcoded extension lists silently drift from the canonical registry,
causing files to be watched but not listed (or vice versa). This is a frequent source of
subtle bugs when new file types are added.

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

**Priority:** Medium — reduces three near-identical methods to one, but the savings are modest
(~5 lines each). Prioritized below Targets 1–2 because the duplication is less likely to drift.

**Current State:**

- `HistoryViewProvider.showHistoryView`, `ProfileViewProvider.showProfileView`, and
  `MemoryViewProvider.showMemoryView` all do the same pattern:
  1. `createOrShowPanel(...)`
  2. if existing, send data to webview
- Note: `MemoryViewProvider` sends two messages (`sendMemoryData` + `sendMemoryEnabled`) in its
  refresh callback, making it slightly different from the other two.

The logic is duplicated across three providers.

**Trade-off with project guidelines:** CLAUDE.md states *"three similar lines of code is better
than a premature abstraction"* and discourages helpers for one-time operations. This target is
at exactly that boundary — three providers with a 5-line pattern. The justification for
consolidation is:

1. The pattern is mechanical (create-or-show + conditional refresh) with no view-specific logic
   beyond the refresh callback.
2. If additional secondary panels are added (e.g., a future Glossary or Citations panel), the
   pattern would need to be copied again.
3. `createOrShowPanel` already lives in `BaseWebviewProvider`, so the helper is a natural
   extension of existing base-class responsibility.

If the team judges that three instances do not warrant the abstraction, this target can be
deferred or dropped without affecting the other four.

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

**Priority:** Medium — four identical implementations differing only in a string key make this
the clearest mechanical deduplication target with near-zero risk of behavioral change.
(Note: `ProgressViewContentProvider` also adds a CSS URI, so the helper must support optional
style bundles.)

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

**Priority:** Medium — the three handlers are currently in perfect lockstep with zero
divergence, making consolidation safe today. However, if handlers are *intentionally* decoupled
to allow independent evolution, consolidation would reduce that flexibility.

**Current State:**

- `HistoryViewMessageHandler`, `MemoryViewMessageHandler`, and `ProfileViewMessageHandler`
  share identical message-handling boilerplate:
  - `withActiveView(...)`
  - `dispatch*Inbound(...)`
  - identical validation error logging
  - identical "Unhandled command" warning

This increases maintenance cost for any change in dispatch mechanics.

**Divergence analysis:** As of this writing, the three `handleMessage` implementations are
character-for-character identical (aside from the specific `dispatch*Inbound` function name).
There is no historical evidence of intentional divergence — all three were introduced together
and have been updated in lockstep. If a future handler needs custom pre/post-dispatch logic,
the shared helper should accept optional hooks rather than requiring a full override.

**Refactor:**

- Add a reusable dispatch helper in `BaseViewMessageHandler` that accepts:
  - `dispatchFn`
  - `handlerRegistry`
  - `view`
- Keep per-view schemas and handler registries unchanged.
- If a handler later needs custom behavior, it can override `handleMessage` directly (the
  shared helper is a convenience, not a constraint).

**Acceptance Criteria:**

- History/Memory/Profile handlers delegate to a shared dispatch helper.
- Logging and unhandled-command behavior remains consistent across views.

**Evidence:**

- The three message handlers have identical `handleMessage` bodies except for the
  dispatch function used.

---

## Risks & Mitigations

| Risk                                            | Mitigation                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Abstraction becomes too generic                 | Keep helpers narrowly scoped to the repeated patterns only.                  |
| Behavior drift in webview updates               | Add targeted tests or manual checks for each view before release.            |
| Over-consolidation breaks view-specific nuances | Shared helpers accept callbacks/hooks for view-specific logic; any provider  |
|                                                 | can override the base method directly to opt out without recreating the full |
|                                                 | duplication (only the divergent provider departs from the shared path).      |

## Open Questions

- Should the shared MainView options refresher live in `@frontend/agents/` or `@common/webview`?
- Is it worth standardizing `showXView` naming if we move logic into `BaseWebviewProvider`?
