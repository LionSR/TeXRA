# PRD: UI Regression Audit - MainView + ProgressView

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior doc:** [ui-regressions-lit-migration.md](./ui-regressions-lit-migration.md)

## Overview

This PRD captures a **UI regression audit** between the current branch and the main branch
baseline. The focus is on **missing UI elements, CSS regressions, and logic regressions** in
MainView and ProgressView.

> **Status: 🟢 Critical Issues Resolved (2026-01-29)** - L1, L2, L4 all fixed

### Baseline for comparison

Compared branch `claude/review-lit-native-phases-skw5W` against `main` branch.
PR contains 685 files changed (+44829/-38366 lines) - major Lit migration effort.

---

## Critical Logic Regressions (Queued Messages)

> **Severity: 🔴 CRITICAL** - Data loss when switching tabs

### L1) Queued follow-ups not cleared on stream switch (CRITICAL) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Critical
- **Status:** ✅ **FIXED** - The `'clear'` action in `updateLogContent` clears all frontend
  `streamStates` (including `queuedFollowUps`) via `ctx.setState((prev) => ({ ...prev, streamStates: new Map() }))`.
- **Location:**
  - `src/progressView/events/ProgressEventHandler.ts:342-348` (`clearStreamSurface()`)
  - `src/progressView/frontend/messageDispatcher.ts:205-208` (frontend handler)

### L2) Queued follow-ups not sent on stream activation (CRITICAL) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Critical
- **Status:** ✅ **FIXED in this PR** (lines 323-326 of ProgressEventHandler.ts)
- **Fix applied:** `refreshStreamSurface()` now calls:
  ```typescript
  this.webviewUpdater.updateQueuedFollowUps(
    stream,
    ToolUseFollowUpQueue.getAll(stream),
  );
  ```
- **Note:** The docstring in `FollowUpEventHandlers.ts:12` is now stale and should be updated.
  It says "refreshStreamSurface doesn't refresh follow-ups" which is no longer true.

### L3) Schema defaults hide data loss (HIGH)

- **Area:** Shared
- **Type:** Logic regression
- **Impact:** High
- **Current behavior:** `queuedFollowUps: z.array(z.string()).prefault([])` means missing data
  silently becomes empty array instead of erroring. Combined with L1 and L2, the frontend shows
  empty queued messages even when they exist on the backend.
- **Location:**
  - `src/shared/schemas/streamState.ts:46`
- **Impact:** Silent data loss - messages exist on backend but don't appear in frontend

### L4) No cleanup of queued messages on stream deletion (MEDIUM) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** ~~When a stream is deleted, `clearStream()` removes all data but queued
  messages for that stream are never explicitly cleared in the UI.~~ Fixed: `ToolUseFollowUpQueue.release(streamId)` now called in both `handleDeleteStream()` and `handleDeleteAll()`.
- **Location:**
  - `src/progressView/ProgressViewMessageHandler.ts:262-280` (`handleDeleteStream()`)

---

## UI Regressions (New Findings 2026-01-29)

### U1) Inverted aria-hidden logic in QueuedFollowUps (MEDIUM)

- **Area:** ProgressView
- **Type:** Accessibility regression
- **Impact:** Medium
- **Current behavior:** Line 100 has `aria-hidden=${visible ? 'false' : 'true'}` which is
  correct, but needs verification that the `visible` computed property works as expected.
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:100`

### U2) Missing null check in BannerGroup provider rendering (MEDIUM)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Line 225 uses `providerLabel` from `charAt(0).toUpperCase()`. If
  provider is null/undefined, this will throw an error.
- **Location:** `src/webview/frontend/components/BannerGroup.ts:225`
- **Fix:** Add null check before rendering API key banner

### U3) FollowUpInput visibility pattern may break event listeners (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Lines 181-182 return `nothing` when not visible. This removes the
  component from DOM entirely, which could break parent event listener attachment if the parent
  expects the component to always be present.
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts:181-182`

### U4) CSS selector timing with data-mode attribute (LOW)

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** FollowupSection CSS selectors depend on `data-mode` attribute (lines
  132-175). If `mode` property change isn't synchronized properly, buttons/sections won't
  appear/disappear correctly.
- **Location:** `src/progressView/frontend/components/FollowupSection.ts:132-175, 229`

### U5) SortableController timing in OutputFilesSection (LOW)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Low
- **Current behavior:** Lines 46-57 initialize SortableController but `@query()` selector
  might not find element if render hasn't completed. Drag-and-drop might not initialize.
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts:46-57`

---

## Regression inventory (observed)

> **Legend:**
>
> - **Area:** MainView / ProgressView / Shared
> - **Type:** Missing UI element / CSS regression / Logic regression
> - **Impact:** High / Medium / Low

### 1) Output file action buttons lost fixed sizing

- **Area:** MainView
- **Type:** CSS regression
- **Impact:** Medium
- **Current behavior:** Output file toolbar buttons no longer use a sizing class and have no
  replacement styles, causing visual inconsistencies in button size and spacing.
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts`

### 2) Badge padding reduced globally

- **Area:** Shared
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Global badge padding is smaller, compressing category chips and
  history tags.
- **Location:** `src/common/styles/common.css`

### 3) Log entry detail rows lost base layout styles

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Medium
- **Current behavior:** `.detail-item` base styles were removed from log entry styles but
  the shared base styles are not included in `logStyles`, so detail rows lose the flex layout
  and spacing they previously relied on.
- **Location:**
  - `src/progressView/frontend/styles/logEntryStyles.ts`
  - `src/progressView/frontend/styles/logStyles.ts`

### 4) Log entry summary rows lost base layout styles

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Medium
- **Current behavior:** `.details-summary` base styles were removed with the same assumption
  of shared styles, but `logStyles` still omits the shared base styles, causing summary rows to
  lose consistent alignment and spacing.
- **Location:**
  - `src/progressView/frontend/styles/logEntryStyles.ts`
  - `src/progressView/frontend/styles/logStyles.ts`

### 5) Code block copy button padding changed

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Copy button padding is now driven by small spacing tokens, making the
  icon button look noticeably tighter than adjacent toolbar controls.
- **Location:** `src/progressView/frontend/styles/codeBlockStyles.ts`

### 6) Tool-use sublabel opacity shifted to design token

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Tool-use sublabels now use `--opacity-normal`, which may differ from
  the previous explicit opacity and can reduce readability depending on theme.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 7) Tool-use warning stripe width now tokenized

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Warning stripes use `--border-thick` instead of the prior 3px width,
  resulting in inconsistent emphasis depending on theme token definitions.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 8) Tool-use feedback border thickness changed

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Feedback panels now use `--border-thick` for the left border instead of
  3px, which can visually misalign with other alert banners.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 9) Inline diff highlight padding and radius changed

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Inline diff highlights use smaller padding and tokenized border radius,
  which reduces the prominence of additions/deletions compared to other inline tags.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 10) Agent banner now hides for any selection

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Selecting any agent now hides the agent config banner unconditionally.
  Previously, banner visibility depended on whether the selected option was disabled. This can
  mask missing agent configuration or a disabled agent selection.
- **Location:** `src/webview/frontend/MainApp.ts`

### 11) API key banner no longer has a forced-visible mode

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** The API key banner is set purely from the backend message and can be
  dismissed without a local guard. If the backend does not re-trigger the banner, users can
  lose the “API key required” prompt while still blocked.
- **Location:** `src/webview/frontend/MainApp.ts`

## Goals

1. **Fix critical queued message persistence** (L1, L2) - highest priority
2. Restore missing styling hooks and class-level layout styles.
3. Reintroduce UI logic guards for banners that should not silently disappear.
4. Align ProgressView spacing and highlighting with the main branch baseline.
5. Ship a regression-free UI without reintroducing deleted CSS files.

## Non-goals

- Reworking the overall visual design language or theme tokens.
- Reintroducing removed CSS files that were intentionally consolidated.

## Requirements

### R0: Fix queued message persistence (CRITICAL) ✅ ALL FIXED

> **Priority: P0** - ✅ All critical issues resolved

**R0.1: Clear queued follow-ups on stream switch-away** ✅ FIXED

- The `'clear'` action in `updateLogContent` clears all frontend `streamStates`
- Frontend handler at `messageDispatcher.ts:205-208` sets `streamStates: new Map()`
- This clears queuedFollowUps along with all other stream state

**R0.2: Send queued follow-ups on stream activation** ✅ FIXED

- Already implemented at lines 323-326 of `ProgressEventHandler.ts`
- Uses `ToolUseFollowUpQueue.getAll(stream)` to fetch messages

**R0.3: Update stale docstring** ⬜ NOT STARTED (low priority)

- `FollowUpEventHandlers.ts:12` says "refreshStreamSurface doesn't refresh follow-ups"
- This is no longer true after R0.2 fix - should be updated or removed

### R1: Output files toolbar sizing

- Reintroduce a consistent size for output file toolbar buttons.
- Keep sizing local to the component or a shared toolbar style.

### R2: Badge padding parity

- Restore badge padding to match baseline sizing, or introduce explicit size variants.

### R3: ProgressView log detail layout

- Ensure `.detail-item` and `.details-summary` have consistent base layout styles in all log
  contexts (either by reintroducing base styles or by including `commonViewStyles`).

### R4: ProgressView spacing and highlight parity

- Normalize padding/width differences in code block actions and tool-use panels so they match
  baseline affordances.

### R5: Banner guardrails

- Reintroduce a guard for the agent config banner so it remains visible when a disabled or
  misconfigured agent is selected.
- Add a forced-visible state (or equivalent backend-triggered lock) for the API key banner
  until resolution.

### R6: BannerGroup null safety

- Add null check for provider before rendering API key banner
- Location: `src/webview/frontend/components/BannerGroup.ts:225`

## UX notes

- Any UI change should be visually verified in VS Code’s dark and light themes.
- Changes should avoid reintroducing Light DOM CSS files; keep Lit-native styles.

## Open questions

1. Should banner guards live in MainView or be controlled entirely by backend messaging?
2. Are we comfortable standardizing tool-use accent widths to `--border-thick`, or do we want
   a fixed pixel value for consistency across themes?
3. Does the baseline for badge padding need to be strictly preserved, or can we standardize a
   smaller size and adjust adjacent spacing?

---

## Fix Priority Summary (2026-01-29)

| Priority | Issue                                            | Severity    | Effort | Status                  |
| -------- | ------------------------------------------------ | ----------- | ------ | ----------------------- |
| **P0**   | L1: clearStreamSurface missing queuedFollowUps   | 🔴 Critical | Low    | ✅ Fixed (clear action) |
| **P0**   | L2: refreshStreamSurface missing queuedFollowUps | 🔴 Critical | Low    | ✅ Fixed in PR          |
| **P1**   | L3: Schema defaults hide data loss               | 🟠 High     | Low    | ⚠️ By design (see note) |
| **P1**   | U2: BannerGroup null check                       | 🟠 High     | Low    | ⬜ Not Started          |
| **P2**   | L4: Stream deletion cleanup                      | 🟡 Medium   | Low    | ✅ Fixed                |
| **P2**   | U3: FollowUpInput visibility pattern             | 🟡 Medium   | Medium | ⬜ Not Started          |
| **P3**   | U1: aria-hidden verification                     | 🟢 Low      | Low    | ⬜ Not Started          |
| **P3**   | U4: CSS selector timing                          | 🟢 Low      | Low    | ⬜ Not Started          |
| **P3**   | U5: SortableController timing                    | 🟢 Low      | Low    | ⬜ Not Started          |
| **P3**   | Stale docstring in FollowUpEventHandlers.ts      | 🟢 Low      | Low    | ⬜ Not Started          |

### Recommended Fix Order

1. ~~**L1** - Fix `clearStreamSurface()` to clear queued follow-ups~~ ✅ Done (clear action handles it)
2. **U2** - Add null safety to BannerGroup
3. ~~**L4** - Clean up queued messages on stream deletion~~ ✅ Done
4. **Stale docstring** - Update `FollowUpEventHandlers.ts:12` (L2 is now fixed)
5. **L3** - Consider removing `.prefault([])` or adding explicit validation (by design - may keep)
6. **U3** - Evaluate FollowUpInput visibility pattern

### Remaining Files to Modify

```
src/progressView/events/FollowUpEventHandlers.ts      # Stale docstring (low priority)
src/webview/frontend/components/BannerGroup.ts        # U2
src/progressView/frontend/components/FollowUpInput.ts # U3 (evaluate)
```
