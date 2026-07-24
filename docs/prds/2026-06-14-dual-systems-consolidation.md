---
created: 2026-06-14
updated: 2026-06-14
---

# PRD: Largest Dual-Systems Consolidation Audit (2026-06)

## Overview

This PRD audits the **largest** "dual systems" in TeXRA — parallel/duplicated
implementations of the same concern — ranks the top 5 of 10 screened candidates
by the size of their duplicated surface, and applies an **adversarial review** to
each (the strongest case _against_ consolidating).

It deliberately extends, rather than repeats, the earlier dual-logic work
(`docs/prds/2026-01-30-dual-logic-features.md`, `docs/prds/2026-01-30-dual-logic-infrastructure.md`,
`docs/prds/2026-01-31-dual-logic-audit.md`), which already shipped the small shared
helpers (`streamSort`, `optionsLoader`, `sessionDefaults`, `recentCommits`,
`fileSelectionRegistry`) and deliberately rejected ~10 smaller candidates as
premature abstraction. The findings here are filtered through the same
anti-abstraction lens mandated by `CLAUDE.md`: structural similarity is not
duplication, and intentionally distinct typed contracts must stay distinct.

## Method

Candidates were measured directly (`wc -l`, Glob, Grep) and ranked by the size of
the **duplicated surface** (recurring logic), not raw package size. "Genuine
overlap" estimates the fraction that is true copy-paste / re-expressed logic
versus irreducible platform glue or intentionally distinct semantics.

---

## Ranking (top 5 of 10)

| #   | Dual system                                                                         | Dual surface                                         | Genuine overlap   | Verdict                |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------- | ---------------------- |
| 1   | Provider model handlers (Anthropic / OpenAI / OpenAIResponse / Google / OpenRouter) | ~8.3k LOC of handlers over 1.24k base + 1.3k support | 60–70% of concern | Real, partly tractable |
| 2   | Host orchestration (extension 56k / CLI 38k / desktop 10k)                          | ~13k command/view glue                               | 20–40%            | Mostly intentional     |
| 3   | Webview frontends (progressView 20k / settingsView 13k / main 7.8k)                 | ~41k Lit UI                                          | 10–15%            | Mostly intentional     |
| 4   | View message handlers + content providers (Main/Progress/Settings)                  | ~2.5k handlers + 1.3k providers over 368 base        | 15–20%            | Thin, already based    |
| 5   | Reflection flow vs ToolUse flow                                                     | 1.28k / 1.36k over 2.5k shared core                  | 10–15%            | Intentional            |

Screened and parked (ranked 6–10), lower tractable overlap: per-view message
schemas (~6.9k); CLI-TUI vs webview rendering (21k / 3.2k); ToolUse- vs
Workflow-StreamContent (93 / 81 over a shared base); state-restore / TaskState
builders; FileLister vs `findFilesFromPatterns` (110 / 47).

---

## 1. Provider model handlers — the only clear win

**Duplicated surface:** `modelHandlerAnthropic.ts` (1,672), `modelHandlerOpenAI.ts`
(1,586), `modelHandlerOpenAIResponse.ts` (2,610), `modelHandlerGoogleGenAI.ts`
(1,369), `modelHandlerOpenRouterNative.ts` (1,018) — over shared
`ModelHandler.ts` (1,239) + `support/` (1,307). Recurring ~400–600 LOC of
context-window sizing, token-limit validation, usage normalization,
media-attachment processing, and SDK error tagging is re-expressed per provider.

**Files:**

- `src/agent/modelHandlers/ModelHandler.ts`, `src/agent/modelHandlers/support/`
- `src/agent/modelHandlers/{anthropic,openai,google,openrouter}/`

**Adversarial review:** The 60–70% is overlap of _concern_, not copy-paste. Each
SDK has genuinely different streaming events, tool-call shapes, and usage fields
— which is why the base class already exists and recent commits keep pushing
logic _into_ it (client-side compaction moved to the base; OpenAI Responses
`createResponseImpl` decomposed). The OpenAI vendor variants
(DeepSeek/Kimi/GLM/MiniMax/DashScope/X-AI, 38–128 LOC each) are already cleanly
factored by inheritance; touching them is churn. A grand "provider adapter"
abstraction risks the leaky-abstraction trap — provider quirks leak through into
`if (provider === ...)` branches inside the shared layer, which is worse than
honest duplication.

**Defensible scope:** continue extracting _specific_ helpers (token validation,
usage normalization, media-attachment) into `support/` as already happening. Do
**not** attempt a grand handler unification.

## 2. Host orchestration (extension / CLI / desktop)

**Duplicated surface:** all three converge on `runAgent()` from `@agent/runtime`,
but command/view glue diverges: extension `/commands/` (~8.1k), CLI chat/runners
(~5k), and desktop's monolithic `desktopAgentExecution.ts` (1,283) which inlines
~300–400 LOC of approval/file-action logic that already exists as extension
commands.

**Files:**

- `packages/desktop/src/main/desktopAgentExecution.ts`
- `packages/extension/src/commands/agent/`
- `packages/cli/src/runtime/`

**Adversarial review:** Largest by raw scale but thinnest by real duplication —
~60–70% is irreducible host glue (ANSI/TTY vs VS Code panels vs Electron IPC).
`CLAUDE.md` mandates "headless parity is sacred" and that platform-specific
wiring lives in host packages; the `platform()` ports already factor the agnostic
core out. Forcing a shared orchestration layer fights that design. Counting
host-specific rendering as "duplication" creates a mirage.

**Defensible scope:** the one concrete, bounded item is **desktop's inlined
approval/file-action logic** — a real ~300–400 LOC duplicate of extension command
logic, extractable into a shared host-neutral controller (under `src/controllers/`
behind existing ports). Everything else stays host-specific.

## 3. Webview frontends (progressView / settingsView / main)

**Duplicated surface:** ~41k LOC of Lit components; progressView and settingsView
share the component framework and similar tab/panel scaffolding.

**Adversarial review:** Structural similarity is not duplication. ProgressView is
a real-time streaming/approval surface, SettingsView is config persistence,
MainView is execution control — three domains with different state models. The
prior `2026-01-30-dual-logic-features.md` already shipped the genuinely shared bits
(`streamSort`, `optionsLoader`, `sessionDefaults`) and **deliberately deferred**
stream-rendering normalization because follow-up sections are intentionally
different. `ApprovalRequestHandler` already de-dupes the recurring approval
state-tracking. Further consolidation means a god-component with per-view
conditionals — the render-time-workaround / premature-abstraction anti-pattern
`CLAUDE.md` prohibits.

**Defensible scope:** none beyond what is already shipped.

## 4. View message handlers + content providers

**Duplicated surface:** `MainViewMessageHandler` (413), `ProgressViewMessageHandler`
(858), `SettingsViewMessageHandler` (1,257) over `BaseViewMessageHandler` (220);
content providers (MainView 418, Progress 758, Settings 77) over
`BaseViewContentProvider` (148).

**Adversarial review:** The base classes already absorb dispatch, theme/ready/debug
handling, active-view tracking, and URI building — `2026-01-30-dual-logic-infrastructure.md`
did this and marked it complete. What remains is _typed, per-view message routing
over distinct discriminated unions_, which that PRD explicitly ruled must stay
per-view ("do not consolidate typed dispatch"). Merging re-introduces stringly
dispatch and loses compile-time message validation. Net extractable surface is
~15–20 lines of theme/ready boilerplate — below the abstraction threshold.

**Defensible scope:** none. Not worth a change.

## 5. Reflection flow vs ToolUse flow

**Duplicated surface:** `src/agent/implementations/flows/reflection/` (1,283) vs
`.../tooluse/` (1,364), both over `src/agent/core/flows/` (2,497:
`BaseFlowServices`, `ResponseCycleFlow`, `ToolUseRoundFlow`).

**Adversarial review:** Both already share the generic PocketFlow framework; what
differs is _semantics_, not code — reflection is stateless cycles tracking
`roundOutputs`/compile results, tooluse is stateful rounds tracking session
snapshots and model-switch context. The 5–6 domain-specific nodes per flow do not
correspond 1:1. Unifying means a meta-flow parameterizing two execution models —
high risk, near-zero LOC saved, and it obscures two currently-readable flows. The
recent `Rename ToolUseCycleFlow to ToolUseRoundFlow` shows the investment is in
_clarity of the distinction_, not erasing it.

**Defensible scope:** none. Leave as-is.

---

## Recommendation

Of the top 5 by size, only two items survive an adversarial pass:

| Item                                                            | Severity | Status   | Effort       |
| --------------------------------------------------------------- | -------- | -------- | ------------ |
| 1. Incremental helper extraction in model-handler `support/`    | LOW      | Ongoing  | Continuous   |
| 2. Extract desktop inlined approval/file-action logic to shared | MEDIUM   | Proposed | ~300–400 LOC |

The other three are large-by-scale but their overlap is either already
consolidated or intentionally distinct typed contracts that `CLAUDE.md`'s
anti-abstraction rules tell us not to merge — consistent with the prior PRDs that
rejected ~10 similar candidates.

## Non-Goals

- A unified "provider adapter" replacing per-provider model handlers.
- A shared host orchestration layer spanning extension/CLI/desktop UI.
- A god webview component or generic message-dispatch wrapper.
- A unified meta-flow over reflection and tool-use semantics.

## Related

- `docs/prds/2026-01-31-dual-logic-audit.md`
- `docs/prds/2026-01-30-dual-logic-features.md`
- `docs/prds/2026-01-30-dual-logic-infrastructure.md`
