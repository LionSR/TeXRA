# PRD: UI & Logic Regression Addendum (20 New Findings)

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Related audit:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)

## Overview

This addendum captures **20 additional UI and logic regressions** identified after comparing the
current branch with the `main` baseline. These items are **not listed in the existing regression
PRDs** and should be triaged alongside the Phase 9 Lit migration work.

**Scope:** MainView, ProgressView, HistoryView, ProfileView, and shared webview state utilities.

---

## Logic Regressions (State, Ordering, or Data Loss)

### L10) Webview storage cache overwrites other keys (HIGH)

- **Area:** Shared state
- **Type:** Logic regression
- **Impact:** High (silent UI state loss)
- **Current behavior:** Each `createWebviewStorage()` instance caches `getState()` once and writes
  updates by spreading its **own** cache. When multiple adapters are used, the last writer can
  overwrite keys from other adapters with stale cache data.
- **Location:** `src/shared/state/PersistedState.ts:33-51`
- **Why it regressed:** Webview state writes were previously centralized; caching now happens per
  adapter instance.

### L11) Webview storage cache never refreshes after external updates (MEDIUM)

- **Area:** Shared state
- **Type:** Logic regression
- **Impact:** Medium (stale UI state)
- **Current behavior:** `createWebviewStorage()` never re-reads `vscode.getState()` after the initial
  call, so updates made by other code paths (or legacy `vscode.setState` calls) are invisible.
- **Location:** `src/shared/state/PersistedState.ts:40-51`

### L12) LogList always scrolls to bottom on any update (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (breaks user scroll position)
- **Current behavior:** `updated()` calls `scrollToBottom()` unconditionally. Any reactive change
  (toggle, filter, search highlight) snaps the log view to the bottom, which is jarring during
  review.
- **Location:** `src/progressView/frontend/components/LogList.ts:114-118`

### L13) LogList toggle state shared across streams/runs (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (collapse/expand state leaks between sessions)
- **Current behavior:** Toggle state is stored under a single `logListState` key without stream/run
  scoping, so collapsing a group in one stream affects all other streams.
- **Location:** `src/progressView/frontend/components/LogList.ts:69-84`

### L14) TaskGroup sorting assumes numeric timestamps (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (incorrect ordering)
- **Current behavior:** `buildGroupTree()` sorts by `startTime` and `timestamp` using numeric
  subtraction. If values arrive as strings or `undefined`, sort results become `NaN` and ordering
  becomes unstable.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:96-155`

### L15) TaskGroupHeader can throw on invalid startTime (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (render crash)
- **Current behavior:** `Intl.DateTimeFormat.format()` throws on invalid dates. If `startTime` is
  missing or malformed, the entire component render can fail.
- **Location:** `src/progressView/frontend/components/TaskGroupHeader.ts:49-74`

### L16) TaskGroupHeader duration uses unchecked numeric subtraction (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (NaN duration display)
- **Current behavior:** `group.endTime - group.startTime` assumes both values are numbers. If
  either is a string, duration becomes `NaN`, producing a bad UI string.
- **Location:** `src/progressView/frontend/components/TaskGroupHeader.ts:55-61`

### L17) Completion sound tied to `r\d+` name format (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (feature silently stops working)
- **Current behavior:** Completion sound only plays when `group.name` matches `/^r\d+$/`. If run
  names become human-readable (e.g., `Run 1`), sound never plays.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:76-93`

### L18) Run selector sorted oldest-first (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (run discovery friction)
- **Current behavior:** Runs are sorted ascending by start time, so the newest session is at the
  bottom. Previous behavior in main listed newest-first, which aligns with recent activity.
- **Location:** `src/progressView/frontend/components/RunSelector.ts:36-57`

### L19) History search can race on rapid input (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium (stale highlight/match counts)
- **Current behavior:** `applySearchToItems()` is async and is invoked on every keystroke without
  cancellation. Older promises can resolve after newer ones, overwriting match counts and
  highlighted indices with stale results.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:88-175`

### L20) Search term update occurs before items render (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (search highlights missing until next update)
- **Current behavior:** `performSearch()` runs in `willUpdate()` before the new item list has
  rendered, so `@queryAll('history-item')` can be stale. Highlights can fail until the next
  render cycle.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:60-129`

---

## UI Regressions (Visual or Interaction)

### U10) Queued follow-ups always reopen when messages change (MEDIUM)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (user cannot keep the list collapsed)
- **Current behavior:** The collapsible is bound to `?open=${visible}`, so any new message forces it
  back open, even if the user collapsed it.
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:70-93`

### U11) Queued follow-up list keys collide for repeated messages (LOW)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (DOM reuse issues, wrong truncation/title)
- **Current behavior:** Repeat keys are `${index}-${message.slice(0, 20)}`. Two messages with the
  same prefix can produce collisions, causing Lit to reuse nodes incorrectly.
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:82-89`

### U12) Follow-up send on Enter ignores IME composition (MEDIUM)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Medium (breaks non-Latin input)
- **Current behavior:** `handleKeydown()` sends on Enter without checking `event.isComposing`, which
  can prematurely send while using IME.
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts:132-138`

### U13) History search input is uncontrolled (MEDIUM)

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Medium (UI shows stale search term)
- **Current behavior:** The textfield never binds to a `value` prop. When parent clears search, the
  visible input still shows the old term.
- **Location:** `src/historyView/frontend/components/SearchBar.ts:57-101`

### U14) History search trims whitespace (LOW)

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Low (cannot search leading/trailing whitespace)
- **Current behavior:** `handleInput()` uses `.trim()`, so searching for intentional leading/trailing
  whitespace is impossible.
- **Location:** `src/historyView/frontend/components/SearchBar.ts:38-50`

### U15) Api access summary defaults to “none” before data loads (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (misleading placeholder state)
- **Current behavior:** `allowedModels` defaults to `[]`, which displays “none” even when the
  backend hasn’t responded. A loading/unknown state would avoid the flicker.
- **Location:** `src/profileView/frontend/components/ApiAccessSection.ts:20-72`

### U16) Agent category badge class can be empty (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (badge styling lost)
- **Current behavior:** `categoryClass` is derived from `agent.category` without a fallback. If the
  category is undefined or empty, the badge loses its styling class.
- **Location:** `src/profileView/frontend/components/AgentsTable.ts:44-75`

### U17) File option list order no longer matches workspace order (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (confusing ordering)
- **Current behavior:** File options are always alphabetized instead of preserving workspace or
  recency ordering, which can feel like a regression when users expect the current file to appear
  near the top.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:152-170`

### U18) Footer dropdowns always open upward (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (dropdowns can clip off-screen near top)
- **Current behavior:** The listbox is forced upward for all footer dropdowns regardless of viewport
  position, so when the footer is near the top of the view the listbox can render off-screen.
- **Location:** `src/webview/frontend/components/InstructionPanel.ts:132-139`

### U19) Search navigation mismatch when match counts update (LOW)

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Low (jumping highlighted match)
- **Current behavior:** `performNavigate()` updates `searchIndex` but relies on stale
  `matchCounts` if a search is still in-flight; highlighted matches can jump unexpectedly.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:104-155`

### U20) Run selector placeholder visible even with value (LOW)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (placeholder conflicts with selected value)
- **Current behavior:** The placeholder is always rendered via slot. When `activeRunId` is set to a
  string that isn’t in the list, the placeholder “No sessions” still appears, which looks like an
  empty state even though a session is active.
- **Location:** `src/progressView/frontend/components/RunSelector.ts:48-68`

---

## Next Steps

- Triage the items by impact and verify against the `main` UI baseline.
- Prioritize L10/L12/L19 first due to state loss, UX disruption, and search correctness.
- Resolve UI regressions with Lit-native patterns (no external CSS files).
