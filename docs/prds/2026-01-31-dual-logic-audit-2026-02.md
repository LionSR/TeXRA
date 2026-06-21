---
created: 2026-01-31
updated: 2026-02-10
---

# PRD: Dual-Logic Consolidation (2026-02)

## Implementation Status

| Item                          | Severity | Status   | Notes                                        |
| ----------------------------- | -------- | -------- | -------------------------------------------- |
| File watcher extensions       | HIGH     | Proposed | Active bug — .bib/.bbl/.sty not watched      |
| useMultipleOutputs divergence | HIGH     | Proposed | Different algorithms in 3 code paths         |
| MainView options refresh      | MEDIUM   | Proposed | loadOptions() exists but unused in providers |
| Workflow proposal file lists  | MEDIUM   | Proposed | ~50 lines identical code in 2 components     |

## Overview

This PRD consolidates three prior dual-logic audit documents into validated, actionable items.
Items were verified against the codebase — only issues confirmed as real problems with
concrete fixes are included. Items that would add abstraction without meaningful benefit
have been removed per CLAUDE.md guidelines.

## Goals

- Fix actual bugs caused by logic drift (file watcher, useMultipleOutputs)
- Wire existing helpers into unused code paths (loadOptions)
- Avoid introducing new abstraction layers

## Non-Goals

- Creating wrapper classes or coordinator patterns
- Abstracting ~10-line patterns that work correctly (showXView, getModuleUris, dispatch)
- Changing workspace state schemas

---

## 1. File Watcher Extensions — Fix Hardcoded List

**Severity:** HIGH — Active bug causing user-visible problems
**Complexity:** LOW — ~10 lines

**Problem:**
`MainViewProvider.setupFileWatcher` (line 176) hardcodes file extensions:

```
**/*.{tex,txt,md,cls,png,pdf,jpeg,jpg,svg,gif,heic,heif,webp,wav,mp3,m4a,aiff,aac,ogg,flac}
```

**Missing from watcher but in VS Code config:**

- `.sty` (auxiliary — style files)
- `.bib`, `.bbl` (reference — bibliography files)

**Impact:** Users adding/modifying bibliography or style files won't see real-time file
list updates. They must manually trigger refresh.

**Root cause:** The canonical extension registry (`getIncludedExtensions` in
`@common/files/fileTypeUtils.ts`) is not used here.

**Fix:**

```typescript
// In MainViewProvider.setupFileWatcher, replace hardcoded string with:
const allExtensions = [
  ...getFilterExtensions('input'),
  ...getFilterExtensions('reference'),
  ...getFilterExtensions('auxiliary'),
  ...getFilterExtensions('media'),
  ...getFilterExtensions('audio'),
  ...getFilterExtensions('edited'),
];
const filePattern = `**/*.{${[...new Set(allExtensions)].join(',')}}`;
```

**Files:**

- `src/MainViewProvider.ts:176` — hardcoded glob
- `src/common/files/fileTypeUtils.ts:32-40` — `getIncludedExtensions()` / `getFilterExtensions()`

**Acceptance Criteria:**

- File watcher pattern built dynamically from config
- Adding extensions to VS Code settings affects both file listing and watching

---

## 2. useMultipleOutputs Logic Divergence

**Severity:** HIGH — Different behavior between initial vs follow-up execution
**Complexity:** MEDIUM

**Problem:**
Three code paths derive `useMultipleOutputs` with different algorithms:

| Location                            | Algorithm                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `ExecutionManager.handleExecute:80` | `!isToolUse && (outputFilesActive \|\| outputFiles.length > 1)`                         |
| `buildFollowupTaskState:1180`       | `(attachAgentOutputs && outputFiles.length > 1) \|\| originalConfig.useMultipleOutputs` |
| `handleAgentProposalSetup`          | No output handling (relies on original)                                                 |

**Additional issue:** Only `ExecutionManager` validates against `AgentConfigSchema`.
ProposalSetup and BuildFollowup skip validation entirely.

**Impact:** Follow-up executions could behave differently than initial executions for
identical inputs, especially when output counts change.

**Fix approach:**

1. Extract `deriveUseMultipleOutputs(config, flags)` helper with single algorithm
2. Add schema validation to ProposalSetup and BuildFollowup paths
3. Document if any algorithm differences are intentional

**Files:**

- `src/webview/managers/ExecutionManager.ts:46-116`
- `src/progressView/ProgressViewMessageHandler.ts:524-597, 1120-1226`
- `src/utils/config/configConversion.ts:16-64` — existing `isFileTypeActive` helper

**Acceptance Criteria:**

- Single derivation algorithm (or documented intentional differences)
- All execution paths validate config before dispatch

---

## 3. MainView Options Refresh — Wire loadOptions()

**Severity:** MEDIUM — Maintenance burden, latent inconsistency bug
**Complexity:** LOW

**Problem:**
`loadOptions()` in `@frontend/agents/optionsLoader.ts` already does parallel computation
of agent/model options but is not used by:

- `MainViewProvider.refreshAgentOptions/refreshModelOptions` (lines 124-171)
- `mainViewCommands.refreshAgentOptions/refreshModelOptions` (lines 43-116)

Both paths duplicate the compute + postMessage pattern with different error handling.

**Latent bug:** `refreshAgentOptions` calls `refresh()` (agent index refresh) but
`refreshModelOptions` does not — inconsistent behavior.

**Fix approach:**

1. Have both `MainViewProvider` and `mainViewCommands` call `loadOptions()`
2. Add error handling callback parameter to `loadOptions()` for view-specific UX
3. Ensure both refresh agent index when either changes

**Files:**

- `src/MainViewProvider.ts:124-171`
- `src/commands/system/mainViewCommands.ts:43-116`
- `src/frontend/agents/optionsLoader.ts:16-32`

**Acceptance Criteria:**

- Both provider and commands use `loadOptions()`
- Consistent refresh behavior for agent and model options

---

## 4. Workflow Proposal File Lists — Identical Render Logic

**Severity:** MEDIUM — ~50 lines of byte-for-byte identical code
**Complexity:** LOW

**Problem:**
Two components have identical file list rendering:

- `PermissionCard.renderWorkflowFiles()` (lines 285-334)
- `RequestPanels.renderProposalFiles()` (lines 495-550)

Both include:

- Identical `combine()` helper function
- Same category order (Input, Reference, Auxiliary, Media, Output)
- Same template structure and click handlers

**Fix:**
Create shared helper in `src/progressView/frontend/components/helpers/workflowFilesList.ts`:

- `buildWorkflowFileLists(proposal)` — assembles file categories
- `renderWorkflowFilesList(fileLists, options)` — renders with configurable class names

**Files:**

- `src/progressView/frontend/components/PermissionCard.ts:285-334`
- `src/progressView/frontend/components/RequestPanels.ts:495-550`

**Acceptance Criteria:**

- Both components call shared helper
- No duplicate `combine()` function remains

---

## Issues Removed (Not Worth Abstracting)

The following items from prior audits were evaluated and removed:

| Item                                      | Reason                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Open-file behavior                        | 3 functions serve different purposes (command, tool reuse, linting). Not duplication — intentionally distinct APIs |
| Timestamp formatting                      | 1 line using toLocaleString vs utility. Inconsistency, not duplication. Not worth a shared helper                  |
| Permission rejection feedback flow        | Only 2 components (~15 lines each), different state shapes (boolean vs Set). Premature abstraction                 |
| Secondary panel orchestration (showXView) | 3 providers, ~10 lines each, slight differences. At "premature abstraction" boundary per CLAUDE.md                 |
| Content provider getModuleUris            | 5-line pattern × 4 files, never changes, zero drift risk                                                           |
| Schema dispatch boilerplate               | Handlers are identical but intentionally decoupled for independent evolution                                       |
| Text polishing flows                      | Core logic (polishTextWithAI) is already shared; differences are intentional UX                                    |
| Latexdiff assembly                        | Minor arg divergence, underlying command handles both patterns                                                     |
| State restore pipeline                    | Architectural difference, not direct code duplication                                                              |
| File context formatting                   | Different formatting is intentional for different audiences                                                        |

---

## Risks & Mitigations

| Risk                                            | Mitigation                                    |
| ----------------------------------------------- | --------------------------------------------- |
| File watcher change breaks extension loading    | Test with various file types after change     |
| useMultipleOutputs unification changes behavior | Document current behavior first, add tests    |
| loadOptions() error handling differs by context | Add callback parameter, not forced uniformity |

---

## Supersedes

This PRD supersedes and consolidates:

Historical paths are intentionally preserved here because these predecessor drafts had already been deleted before
the PRD tree was centralized under `docs/prds/`.

- `docs/prd/prd-dual-logic-audit-2026-02.md` (deleted)
- `docs/prd/dual-logic-impact-audit.md` (deleted)
- `docs/prd-dual-logic-audit-2026-02.md` (deleted)

Related completed PRDs (kept for reference):

- `docs/prds/2026-01-30-dual-logic-features.md` — ✅ Complete
- `docs/prds/2026-01-30-dual-logic-infrastructure.md` — ✅ Complete
