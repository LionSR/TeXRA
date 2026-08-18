---
created: 2026-06-21
updated: 2026-08-17
---

# PRD Index

Central home for all TeXRA Product Requirement Documents, plans, and design audits. Top-level documents are filename-prefixed with their `created` date; every document also carries `created` / `updated` frontmatter derived from git history. The non-retired records below are sorted by last update.

The three retired runtime-boundary records dated 2026-06-27 and 2026-06-29
were restored for #8753 before a separate maintainer decision on deleting
`codex/decouple-ui-agent-core`. Their in-body implementation claims describe
that archived source branch, not `main`.

## Retired proposals

| Document                                                               | Created    | Retired    |
| ---------------------------------------------------------------------- | ---------- | ---------- |
| [Runtime/host decoupling](./2026-06-27-prd-runtime-host-decoupling.md) | 2026-06-27 | 2026-07-18 |
| [Agent SDK boundary](./2026-06-29-prd-agent-sdk-boundary.md)           | 2026-06-29 | 2026-07-18 |
| [Runtime gold standard](./2026-06-29-prd-runtime-gold-standard.md)     | 2026-06-29 | 2026-07-18 |

## Other records

| Document                                                                                                                                 | Created    | Updated    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| [PRD: The session event journal — single-authority transcript persistence](./2026-08-18-session-event-journal.md)                        | 2026-08-18 | 2026-08-18 |
| [PRD: One SQLite database per workspace for app-owned durable state](./2026-08-16-sqlite-workspace-state.md)                             | 2026-08-16 | 2026-08-17 |
| [PRD: Transcript, persistence, and projection architecture for long-lived sessions](./2026-08-11-transcript-memory-architecture.md)      | 2026-08-11 | 2026-08-11 |
| [PRD: xAI Responses API and `previous_response_id` for Grok](./2026-08-04-prd-xai-responses-previous-response-id.md)                     | 2026-08-04 | 2026-08-04 |
| [PRD: Unified approval policy across CLI, desktop, and extension](./2026-08-03-prd-approval-policy-unification.md)                       | 2026-08-03 | 2026-08-03 |
| [PRD: Non-blocking `inquiry` — Async Q&A with the User](./2026-05-15-prd-external-inquiry-async.md)                                      | 2026-05-15 | 2026-06-20 |
| [PRD: Largest Dual-Systems Consolidation Audit (2026-06)](./2026-06-14-dual-systems-consolidation.md)                                    | 2026-06-14 | 2026-06-14 |
| [PRD: Team-First Launcher and Onboarding](./2026-04-30-launcher-and-onboarding.md)                                                       | 2026-04-30 | 2026-06-13 |
| [00 · Overview](./cli-tui-ink/2026-05-14-00-overview.md)                                                                                 | 2026-05-14 | 2026-06-13 |
| [10 · Architecture](./cli-tui-ink/2026-05-14-10-architecture.md)                                                                         | 2026-05-14 | 2026-06-13 |
| [20 · Implementation](./cli-tui-ink/2026-05-14-20-implementation.md)                                                                     | 2026-05-14 | 2026-06-13 |
| [PRD: TeXRA Electron App](./2026-05-02-prd-electron-app.md)                                                                              | 2026-05-02 | 2026-06-11 |
| [PRD: Agent-Native Onboarding — One Funnel, Three Surfaces](./2026-06-11-agent-native-onboarding.md)                                     | 2026-06-11 | 2026-06-11 |
| [PRD: Goal — Autonomous Continuation Mode](./2026-05-14-prd-goal.md)                                                                     | 2026-05-14 | 2026-06-09 |
| [PRD: Skills for TeXRA](./2026-05-14-skills.md)                                                                                          | 2026-05-14 | 2026-06-08 |
| [PRD: Automatic LaTeX Compilation, Fragment Handling, and latexFixer Agent](./2026-04-30-auto-compile-pdf.md)                            | 2026-04-30 | 2026-06-07 |
| [PRD: TeXRA CLI](./2026-05-04-prd-cli-app.md)                                                                                            | 2026-05-04 | 2026-06-07 |
| [PRD: RunContext + ambient-state retirement](./2026-05-06-prd-runcontext-refactor.md)                                                    | 2026-05-06 | 2026-06-07 |
| [PRD: TeXRA CLI Distribution (Homebrew + native binary)](./2026-06-07-prd-cli-distribution.md)                                           | 2026-06-07 | 2026-06-07 |
| [25 · Attachments And File Mentions](./cli-tui-ink/2026-05-21-25-attachments-and-mentions.md)                                            | 2026-05-21 | 2026-05-21 |
| [PRD: TeXRA CLI Ink-based TUI](./cli-tui-ink/README.md)                                                                                  | 2026-05-14 | 2026-05-21 |
| [30 · Reference](./cli-tui-ink/2026-05-14-30-reference.md)                                                                               | 2026-05-14 | 2026-05-20 |
| [PRD: Logger Surface Cleanup](./2026-05-17-logger-surface-cleanup.md)                                                                    | 2026-05-17 | 2026-05-17 |
| [Mockups](./cli-tui-ink/mockups/README.md)                                                                                               | 2026-05-14 | 2026-05-15 |
| [00 · Idle](./cli-tui-ink/mockups/2026-05-14-00-idle.md)                                                                                 | 2026-05-14 | 2026-05-15 |
| [01 · Streaming with tool use](./cli-tui-ink/mockups/2026-05-14-01-streaming.md)                                                         | 2026-05-14 | 2026-05-15 |
| [02 · Multi-agent](./cli-tui-ink/mockups/2026-05-14-02-multi-agent.md)                                                                   | 2026-05-14 | 2026-05-15 |
| [03 · Bash approval modal](./cli-tui-ink/mockups/2026-05-14-03-approval-bash.md)                                                         | 2026-05-14 | 2026-05-15 |
| [04 · Edit approval with diff](./cli-tui-ink/mockups/2026-05-14-04-approval-edit.md)                                                     | 2026-05-14 | 2026-05-15 |
| [05 · Transcript search overlay](./cli-tui-ink/mockups/2026-05-14-05-transcript-search.md)                                               | 2026-05-14 | 2026-05-15 |
| [06 · Command palette](./cli-tui-ink/mockups/2026-05-14-06-command-palette.md)                                                           | 2026-05-14 | 2026-05-15 |
| [07 · Streaming-text mode (stdout piped)](./cli-tui-ink/mockups/2026-05-14-07-streaming-text.md)                                         | 2026-05-14 | 2026-05-15 |
| [08 · Tool-card variants](./cli-tui-ink/mockups/2026-05-14-08-tool-variants.md)                                                          | 2026-05-14 | 2026-05-15 |
| [09 · Slash command as structured form](./cli-tui-ink/mockups/2026-05-15-09-slash-form.md)                                               | 2026-05-15 | 2026-05-15 |
| [10 · Session resume](./cli-tui-ink/mockups/2026-05-15-10-session-resume.md)                                                             | 2026-05-15 | 2026-05-15 |
| [2026-05-10-prd-cli-runcontext-logger-orchestration.manifest.json](./2026-05-10-prd-cli-runcontext-logger-orchestration.manifest.json)   | 2026-05-10 | 2026-05-12 |
| [PRD: CLI, RunContext, and Logger v2 orchestration](./2026-05-10-prd-cli-runcontext-logger-orchestration.md)                             | 2026-05-10 | 2026-05-11 |
| [PRD: Logger v2 — structured records, host sinks, decoupled progress schema](./2026-05-06-prd-logger-v2.md)                              | 2026-05-06 | 2026-05-10 |
| [PRD: AgentHistoryManager → Thin Index over KV Store](./2026-02-12-agent-history-kv-migration.md)                                        | 2026-02-12 | 2026-05-08 |
| [PRD: Electron desktop layout adaptation](./2026-05-08-electron-shell-layout.md)                                                         | 2026-05-08 | 2026-05-08 |
| [PRD: ProgressView Modernization - Phase 1](./2026-01-24-prd-progressview-phase1.md)                                                     | 2026-01-24 | 2026-05-04 |
| [PRD: ProgressView Modernization - Phase 2](./2026-01-24-prd-progressview-phase2.md)                                                     | 2026-01-24 | 2026-05-04 |
| [PRD: Infrastructure & Base Class Consolidation](./2026-01-30-dual-logic-infrastructure.md)                                              | 2026-01-30 | 2026-05-04 |
| [PRD: ProgressView Modernization](./2026-01-24-prd-progressview-modernization.md)                                                        | 2026-01-24 | 2026-04-30 |
| [PRD: Orchestrator-First UI Redesign](./2026-04-13-orchestrator-ui-redesign.md)                                                          | 2026-04-13 | 2026-04-15 |
| [Plan: Client-Side Compaction for Anthropic (and All Non-OpenAI-Responses Providers)](./2026-02-05-plan-claude-client-compactization.md) | 2026-02-05 | 2026-03-26 |
| [Progress View Performance & Architecture Analysis](./2026-02-20-progress-view-performance-architecture.md)                              | 2026-02-20 | 2026-02-21 |
| [PRD: Logging Pipeline Refactor — Store-and-Notify Architecture](./2026-02-21-logging-pipeline-refactor.md)                              | 2026-02-21 | 2026-02-21 |
| [PRD: Progress View Streaming Cleanup](./2026-02-21-prd-progressview-streaming-cleanup.md)                                               | 2026-02-21 | 2026-02-21 |
| [PRD: Progress View Placement — Co-located Sidebar with Editor Pop-Out](./2026-02-21-progress-view-placement.md)                         | 2026-02-21 | 2026-02-21 |
| [Progress View Scroll Performance](./2026-02-21-progress-view-scroll-performance.md)                                                     | 2026-02-21 | 2026-02-21 |
| [PRD: Unified Settings View](./2026-01-11-settings-view-unified.md)                                                                      | 2026-01-11 | 2026-02-19 |
| [PocketFlow Implementation Issues - Progress Tracker](./2025-12-25-POCKETFLOW_ISSUES_PROGRESS.md)                                        | 2025-12-25 | 2026-02-10 |
| [Logging & Streaming Architecture Investigation](./2026-01-03-LOGGING_STREAMING_ARCHITECTURE.md)                                         | 2026-01-03 | 2026-02-10 |
| [PRD: Agent History Access via `/executions` Virtual Filesystem](./2026-01-17-agent-history-access.md)                                   | 2026-01-17 | 2026-02-10 |
| [PRD: ProgressView Modernization - Phase 3](./2026-01-24-prd-progressview-phase3.md)                                                     | 2026-01-24 | 2026-02-10 |
| [PRD: ProgressView Modernization - Phase 4](./2026-01-25-prd-progressview-phase4.md)                                                     | 2026-01-25 | 2026-02-10 |
| [PRD: ProgressView Modernization - Phase 5](./2026-01-25-prd-progressview-phase5.md)                                                     | 2026-01-25 | 2026-02-10 |
| [PRD: Lit-Native Improvements - Phase 8](./2026-01-26-prd-lit-native-phase8.md)                                                          | 2026-01-26 | 2026-02-10 |
| [PRD: Lit-Native Improvements - Phase 9](./2026-01-26-prd-lit-native-phase9.md)                                                          | 2026-01-26 | 2026-02-10 |
| [PRD: MainView Modernization - Phase 7](./2026-01-26-prd-mainview-phase7.md)                                                             | 2026-01-26 | 2026-02-10 |
| [PRD: ProgressView Modernization - Phase 6](./2026-01-26-prd-progressview-phase6.md)                                                     | 2026-01-26 | 2026-02-10 |
| [PRD: Task Group State, UI, and Persistence - Phase 9](./2026-01-26-prd-taskgroup-phase9.md)                                             | 2026-01-26 | 2026-02-10 |
| [UI Regressions from Lit Migration](./2026-01-26-ui-regressions-lit-migration.md)                                                        | 2026-01-26 | 2026-02-10 |
| [PRD: UI Regression Audit - All Views](./2026-01-27-prd-ui-regression-audit.md)                                                          | 2026-01-27 | 2026-02-10 |
| [PRD: UI & Logic Regression Audit - Round 2](./2026-01-29-prd-ui-regression-audit-round2.md)                                             | 2026-01-29 | 2026-02-10 |
| [PRD: Code Review Fixes - January 2026](./2026-01-30-code-review-fixes.md)                                                               | 2026-01-30 | 2026-02-10 |
| [PRD: Feature Logic Consolidation](./2026-01-30-dual-logic-features.md)                                                                  | 2026-01-30 | 2026-02-10 |
| [PRD: UI & Logic Regression Audit - Round 3 (Consolidated)](./2026-01-30-prd-ui-regression-audit-round3.md)                              | 2026-01-30 | 2026-02-10 |
| [PRD: Dual-Logic Consolidation (2026-02)](./2026-01-31-dual-logic-audit.md)                                                              | 2026-01-31 | 2026-02-10 |
| [PRD: Token Counting & Context Management Audit](./2026-01-31-token-counting-audit.md)                                                   | 2026-01-31 | 2026-02-10 |
| [PRD: Context Window Compactization](./2026-02-02-prd-context-compactization.md)                                                         | 2026-02-02 | 2026-02-10 |
| [PRD: Split createResponse into Phased Architecture](./2026-02-02-prd-token-counting-refactor.md)                                        | 2026-02-02 | 2026-02-10 |
| [Compaction](./2026-02-05-claude-documentation-compactization.md)                                                                        | 2026-02-05 | 2026-02-10 |
| [Plan: Server-Side Compaction via `compact_20260112` API](./2026-02-05-plan-claude-server-compactization.md)                             | 2026-02-05 | 2026-02-10 |
| [PRD: Model Selection in Settings View](./2026-02-06-model-selection.md)                                                                 | 2026-02-06 | 2026-02-10 |
