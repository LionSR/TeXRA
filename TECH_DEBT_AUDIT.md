# TeXRA refactoring / tech-debt audit

_Scheduled audit, 2026-10-07. Read-only analysis — no code was changed. ~255k LOC scanned across `packages/*/src` by four parallel subagents (harness, texra+llm, the three hosts, cross-cutting metrics), then the concrete claims spot-verified._

## Headline

**The codebase is in genuinely good shape.** The classic "messy" markers are essentially absent across all packages:

- `catch {}` / empty-catch silent drops: **0**
- `@ts-ignore` / `@ts-expect-error`: **0**
- `as any`: 11 total repo-wide (9 harness, 1 cli, 1 extension); `as unknown`: ~20
- `TODO`/`FIXME`/`HACK`/`XXX`: **1** (texra), 0 everywhere else
- Zod `.catch()` on persisted/wire data: **0** (the only hit is a comment _forbidding_ it)
- Hand-rolled promise chains in the app: 3, all at legitimate host edges

So there is no "fix the hacks" work here. The real debt is **size and branch-density concentration** — a handful of mega-functions on the hottest code paths — plus a few true duplications. The repo already acknowledges most of it: `config/ratchets/core-quality/` tracks **55 oversized files, 32 over-length functions, 36 over-complexity functions** as shrink-only baselines, but that gate only covers the harness + llm cores, not the 62k-LOC app.

Below, ranked by potential-savings ÷ effort.

---

## 1. Run-loop / tool-dispatch mega-functions (highest impact)

**Where:** `packages/harness/src/agent/runtime/`
- `loop/toolUseDispatch.ts` — 1,279 LOC, 4 functions >150 lines; `execute` ~270 lines, nested `call` ~145
- `childRunLoop.ts` — 1,108 LOC; `startChildRunLoop` is a single **586-line** function
- `loop/toolUse.ts` — `runToolUse` is **572 lines**
- `loop/step.ts` — `openStep` ~230 lines

~3,600 LOC of the hottest code in the product (every run, every tool call) sits in fewer than 10 functions, all grandfathered past the repo's own 150-line cap.

**What's messy:** `responseCall`, `scriptCall`, and `resumeCall` each inline the same per-call pipeline (resolve tool → open streaming card → `execute` → `captureAttachments` + `settlementContent` + build settlement row). `startChildRunLoop` interleaves a hand-rolled compensation ledger (`sessionStage` / `releaseChildActivation` / `setupUnwound` / `forked` mutable flags + `unwindSetup`) with the run body — exactly what `Effect.acquireRelease`/`Scope` finalizers exist for.

**Est. savings:** ~250–400 LOC and 8+ functions brought under the cap.
**Approach:** Lift the shared call tail into one `settleCall` helper (genuine dedup, not a mechanical split); convert the manual rollback ledger in `childRunLoop` to scoped resources.
**Effort:** Medium-high (hot path, fiber-sensitive). **Savings/effort: high** — biggest ongoing maintenance cost in the repo.

## 2. `Database.ts` — one ~1,000-line layer closure

**Where:** `packages/harness/src/controllers/session/Database.ts` — 1,193 LOC, 142 branches, 4 functions >150 lines. `databaseLayer` is a single `Effect.gen` spanning ~1,000 lines holding 25+ nested `Effect.gen` blocks: SQL constants, connection/migration, projection liveness + catch-up, the append/blob/ref writer, and all read queries.

**Est. savings:** ~100–150 LOC, 4 functions under cap, file under the 400-line budget.
**Approach:** The closure captures one SQLite connection + prepared statements — the shared dependency. Split into `sessionSchema.ts` (SQL + migration), `projections.ts` (`projectionsCurrent`/`catchUpProjections`), `eventAppend.ts` (append writer), each taking the connection as a value; `databaseLayer` wires them.
**Effort:** Low-medium (cohesive, low-risk). **Savings/effort: high** — cleanest structural win.

## 3. CLI `chatSessionController.ts` god-controller

**Where:** `packages/cli/src/chat/chatSessionController.ts` — 1,153 LOC. The factory body is ~844 lines defining ~77 inner closures over shared mutable state. The run-claim lifecycle (`Deferred.makeUnsafe` → `await` → `markRunPending` → `settleClaimOnExit` → `markRunCompleted`) is hand-choreographed ~5× across `startSession` / `startRootRun` / `resume` / `adoptResumedRoot` / `claimPreparingRoot` (24 verified claim/Deferred references in this one file vs 2 in the next CLI file).

**Est. savings:** ~150–250 LOC + large cognitive-load drop.
**Approach:** Extract one `RunClaim` helper owning make/await/mark-pending/settle/mark-completed as a unit; split start/resume/adopt/observe into sibling modules sharing an explicit context object instead of 77 co-scoped closures.
**Effort:** Medium (intra-host, isolated). **Savings/effort: high.**

## 4. Tool/transcript rendering painted twice over one shared section model

**Where:** The `ToolSection` union and section-selection are shared once (`packages/harness/src/shared/transcript/toolRowModel.ts` + `toolRowSections.ts`), but per-kind paint is reimplemented per medium:
- Lit/HTML (extension+desktop): `extension/src/progressView/frontend/formatters/logFormatters/toolFormatters/*` ≈ 965 LOC
- Ink/ANSI (cli): `cli/src/chat/tui/panes/toolRenderers.tsx` + `transcriptEntries.ts` + `transcriptEntryLayout.ts` ≈ 1,331 LOC

Both switch over the identical `section.kind` union and re-derive the same presentation (file-link-with-line, diff hunks, fileGroups, badge/status glyphs). Some medium divergence (DOM vs terminal cells) is inherent; the dispatch skeleton and data-shaping are parallel.

**Est. savings:** ~200–350 LOC.
**Approach:** Add a shared "section → medium-neutral primitives" layer in `@shared/transcript` (resolve label, link+line, diff hunks, badge spec); each host becomes a thin adapter mapping primitives to Lit templates or Ink spans.
**Effort:** Medium (two render surfaces, visual regression risk). **Savings/effort: medium-high** — the cleanest true cross-host duplication, with a home that already exists.

## 5. Cheap, zero-risk consistency wins (good warm-up)

- **Duplicated `logFailure` helper** — byte-identical (comment included) in `controllers/session/sessionLayer.ts:127` and `sessionStore.ts:89`. The broader "log a failure with its data on a named channel" idiom appears **66×** alongside **53** separate `const CHANNEL` declarations. Lift one `logFailure(channel, message)` into `@logger/effectLog`, delete the copies, fold in sites opportunistically.
- **Duplicated directory-watch-with-retry** — same `fs.watch(dir).pipe(Stream.retry(Schedule.exponential…))` + "stopped watching" warning in `platform/defaults/fileSecrets.ts:154` and `tools/agentCatalogFollower.ts:130` (~15 lines each). Extract `watchDirectoryWithRetry(dir, {onChange, onStopped})`.

**Est. savings:** ~40–80 LOC + removes two copies that must stay in sync.
**Effort:** Very low. **Savings/effort: high per hour**, low absolute.

---

## Prioritized ranking

| # | Area | Est. LOC saved | Effort | Why this rank |
|---|------|---------------:|--------|---------------|
| 1 | Run-loop / tool-dispatch mega-functions | 250–400 | Med-high | Hottest path, highest maintenance burden, 8+ over-cap fns |
| 2 | `Database.ts` 1k-line closure | 100–150 | Low-med | Cleanest low-risk structural win |
| 3 | CLI god-controller | 150–250 | Med | Isolated, big readability gain |
| 4 | Transcript rendering dup | 200–350 | Med | Real cross-host dup, shared home exists |
| 5 | `logFailure` + dir-watch dups | 40–80 | Very low | Near-zero-risk, removes drift |

**Do-first order by ROI:** 5 (warm-up) → 2 → 3 → 1 → 4.

## Two structural notes (document, don't execute opportunistically)

- **The 62k-LOC `packages/texra/src` app has no size/complexity ratchet** — the core-quality gate covers harness+llm only, and that's where the ungated long functions live (`createSettingsViewBody` 345 lines, `settingsAgentCommands` 259, `acceptFiles` 212). Highest-leverage _preventive_ move: extend a function-length ratchet to the app so this stops re-accumulating.
- **~26k LOC of shared Lit webview UI lives inside `packages/extension`** (`progressView/frontend`, `settingsView/frontend`) and desktop reaches across the package boundary into it. This contradicts the "`@ui` is the host-neutral toolkit" layering. But CLAUDE.md records a comparable `shared/ui` regroup was **refused on cost** (235 imports + hardcoded test paths) under the "never widen a baseline" invariant — so record as a dated proposal, don't attempt opportunistically.

## What was checked and cleared (not debt)

LLM provider adapters (distinct wire protocols, shared infra already extracted), GitHub pollers (`PollingSourceBase`), subscription-usage adapters, `sessionFold.ts`/`runStateFold.ts` (huge but decomposed into ~40 small single-purpose fns — the documented single-authority projections), the settings catalog (data-driven SSOT), `replacement/{rules,maxRules}.ts` (intentional user-selectable presets), and the two webview message architectures (documented-intentional).
