# PRD: UI Regression Audit - MainView + ProgressView

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior doc:** [ui-regressions-lit-migration.md](./ui-regressions-lit-migration.md)

## Overview

This PRD captures a **UI regression audit** between the current branch and the main branch
baseline. The focus is on **missing UI elements, CSS regressions, and logic regressions** in
MainView and ProgressView.

> **Status: ⬜ Not Started**

### Baseline for comparison

The main branch is not available locally in this environment. For this audit we use the last
shared commit available in the repository history (`73262434`) as the **main branch proxy**.
Any regressions listed below should be verified against the actual main branch once it is
available, but the items are grounded in current code paths and style modules.

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

1. Restore missing styling hooks and class-level layout styles.
2. Reintroduce UI logic guards for banners that should not silently disappear.
3. Align ProgressView spacing and highlighting with the main branch baseline.
4. Ship a regression-free UI without reintroducing deleted CSS files.

## Non-goals

- Reworking the overall visual design language or theme tokens.
- Reintroducing removed CSS files that were intentionally consolidated.

## Requirements

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

## UX notes

- Any UI change should be visually verified in VS Code’s dark and light themes.
- Changes should avoid reintroducing Light DOM CSS files; keep Lit-native styles.

## Open questions

1. Should banner guards live in MainView or be controlled entirely by backend messaging?
2. Are we comfortable standardizing tool-use accent widths to `--border-thick`, or do we want
   a fixed pixel value for consistency across themes?
3. Does the baseline for badge padding need to be strictly preserved, or can we standardize a
   smaller size and adjust adjacent spacing?
