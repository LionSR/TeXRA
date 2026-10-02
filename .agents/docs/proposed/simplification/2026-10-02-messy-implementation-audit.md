# Ad-hoc / messy-implementation audit: 2026-10-02

Date: 2026-10-02
Status: proposed
Origin: scheduled audit with the charter "identify the largest areas with ad
hoc or messy implementations that should be refactored." Five parallel
subagents scanned the heaviest production areas (`src/tools`, `src/agent`,
`packages/cli`, `src/shared`+`src/controllers`, `packages/extension`+
`packages/desktop`); `packages/llm` was swept directly.

## Headline

**The codebase is in good shape.** There is no large "messy ad-hoc" area left
to rescue. Every scanner independently reported that the obvious copy-paste
suspects are already factored behind shared helpers — GitHub pollers share
`PollingSourceBase`, the agent CLIs share `agentCliShared.ts`, provider
streaming shares `transport.ts`, settings/approval/host-request wiring is
already pushed into host-agnostic core behind typed ports, and the run ledger
has exactly one writer and one row-builder. The repo also runs this exact audit
routinely and records refused refactors in
`config/ratchets/refuted-candidates.json`; those were not re-proposed.

What remains is **concentrated structural debt**, not pervasive mess:
(a) a handful of God-modules and oversized functions that are change-magnets,
and (b) a few genuinely-recurring idioms where a builder either doesn't exist
or is under-used. Realistic net deletion across everything below is
**~700–1200 LOC**, plus a large readability gain in ~3–4k LOC of God-modules
that mostly moves rather than deletes. None of it is urgent.

Marker signal confirms this: only ~22 `hack`/`workaround`/`fixme` comments in
all of production code, and the CLI's 109 "TODO" grep hits are almost entirely
the Todo-list *feature*, not debt.

## Prioritized findings (ranked by ROI = savings ÷ effort)

### 1. Cross-cutting `exit → rethrow-interrupt → log → recover` idiom — **best ROI**
- **Where:** `src/agent/` — the pattern `Effect.exit(e); if (Exit.isFailure)
  { if (Cause.hasInterrupts) return Effect.interrupt; logger.warn(Cause.squash
  …); /* fallback */ }` is hand-written ~12–15 times. Densest in
  `output/documentRounds.ts:201-281`, `output/compileCheck.ts:180-210`,
  `runtime/loop/toolUse.ts:253-272`, `runtime/run/compaction.ts:204`,
  `runtime/childRunLoop.ts:722-726`. An existing `recoverOutputFailure` is
  catch-based and *drops interrupts*, so none of these interrupt-preserving
  sites can use it.
- **Why messy:** the same delicate "preserve interruption, log the real cause,
  then fall back" sequence is re-derived each time; a single site getting the
  interrupt check wrong is a silent-degradation bug.
- **Savings:** ~50–80 LOC. **Effort: S–M.**
- **Approach:** one pure-Effect combinator `attemptOrElse(effect, { onInterrupt:
  rethrow, log, recover })`; no bus/publisher/ledger impact.

### 2. Under-used builders: repeated binding & message plumbing — **high ROI, low risk**
A recurring theme across `src/shared` and `src/controllers`/hosts: a factory
exists (or clearly should) but thin wrappers are re-typed inline.
- `shared/settingsView/settingsViewMessages.ts` (864 LOC) — 37 inline
  `z.object({ command: z.literal(...), ...fields })` schemas; sibling schema
  modules already use `durable()`/`trace()` builders, so this file is the
  outlier. One `message(command, shape)` builder → ~40–70 LOC. **S.**
- `controllers/settingsView/*` — `bindings.post(Effect.map(effect, built =>
  ({ command: X, ...built })))` recurs ~13×; one `postMessage(bindings,
  command, effect)` helper → ~25–40 LOC. **S.**
- `packages/extension/src/extensionHostRequests.ts` (736) and
  `packages/desktop/src/…/desktopHostRequests.ts` (620) re-assemble the
  identical `SharedHostRequestBindings` shape around host-specific leaf fns.
  A `makeSharedHostRequests(leaves)` factory in `@controllers/session`
  (leaves injected, so core stays vscode-free) → ~80–150 LOC. **M.**
- `controllers/modelAccess/subscriptionUsage/*` — `fetchXUsage` + the
  `apiKey ? fetch(...) : Effect.succeed(null)` guard repeat 3× each; a
  `keyedUsageAdapter(loadKey, fetch)` factory → ~15–25 LOC. **S.**
- `src/tools` — `.pipe(Effect.mapError(ensureError))` around file reads repeats
  ~11× (`AcceptRunFilesTool.ts`, `WorkflowScriptTool.ts`, `DelegationTools.ts`);
  a `readToolFile(fs, path)` helper → ~10–15 LOC. **S.**
- **Combined savings:** ~170–300 LOC, mostly S. **Approach:** add/adopt the
  one-line builder per cluster; no new barrels.

### 3. CLI modal & form layout machinery (`packages/cli`) — self-contained
- **Rows-budget math:** a shared `confirmCardContentRowsBudget` exists, yet each
  modal hand-declares its own `*_SPACIOUS_FIXED_ROWS…`/`*_COMPACT…` magic
  constants plus a thin wrapper (`modals/EditApproval.tsx`, `PlanApproval.tsx`,
  `ScrollableModalText.tsx`); 224 `availableRows`/budget references across 39
  files. A per-modal "chrome profile" descriptor fed to one budget fn →
  ~70–110 LOC.
- **`modals/UserQuestion.tsx` (471 LOC)** is the worst offender: it bypasses the
  shared helper with three bespoke budget fns *and* re-implements prompt wrapping
  /overflow/slicing that `ScrollableModalText.tsx` already owns. Route it through
  both → ~60–100 LOC.
- **Config/agent forms** (`forms/ConfigForm.tsx`, `WorkspaceAgentsForm.tsx`,
  `AgentListForm.tsx`, `CliConfigForm.tsx`) re-implement select-window sizing by
  hand while simpler list forms ride the declarative `AsyncListForm`. Extend the
  shared form layer and migrate → ~80–140 LOC.
- **Combined savings:** ~210–350 LOC. **Effort: S–M.** Removes fragile
  duplicated magic numbers; no architectural risk.

### 4. Event-vocabulary shotgun surgery (`src/shared/schemas/sessionEvent.ts`) — structural
- **Where:** five functions re-enumerate the whole event vocabulary — `edgesOf`,
  `referencedAggregates`, `listingTypeOf` (~24-case fall-through),
  `listingKeyOf`, `pendingKeyOf` — and the three folds then switch again
  (`sessionFold` 26 cases, `runStateFold` 11, `transcriptFold` 10). Adding one
  event arm means editing 4–5 switches plus the folds.
- **Why messy:** classic shotgun surgery over one vocabulary; easy to add an arm
  and miss a switch (a `default: return` that silently drops it is exactly the
  silent-degradation defect the guardrails call out).
- **Savings:** ~40–60 LOC deleted; the real win is killing a whole class of
  edit-fan-out. **Effort: M** (fold correctness is pinned by existing tests).
- **Approach:** attach listing/pending/edge classification to each arm at its
  `durable()` definition site (SSOT per arm); derive the switches as table
  lookups. Keep the fold suite as the pin.

### 5. God-modules & oversized functions — biggest maintenance burden, lowest deletion
The single largest *burden* but the smallest net deletion (extract-method is
roughly LOC-neutral; only branch collapse deletes). Worth doing incrementally
for testability, not for line count.
- `packages/desktop/src/renderer/main.ts` (1007) — procedural bootstrap mixing
  ~8 layout templates, layout persistence, shell state, message routing,
  resize/shortcut wiring. Split into `DesktopShellView` +
  `shellLayoutPersistence`. Relocates ~400–500 LOC. **L.**
- `packages/cli/src/chat/tui/panes/statusBarDisplay.ts` (924) — ~15 segment
  formatters + compact-priority + bindings in one file. Split into `segments/`.
  ~40–80 LOC. **M.**
- `packages/extension/src/extension.ts` `activate()` (~380) and
  `ProgressViewProvider.ts` (729) — extract command registration, status-bar
  controller, listener wiring; thin the provider to lifecycle. ~150–200 LOC
  relocated. **M.**
- `@progressView/frontend` Lit monsters (`WorkflowRunBoard` 722,
  `SessionComposer` 624, `RunHeader` 545) — giant `render()` methods; split into
  sub-components and promote the shared pieces into `@ui/*` (which also removes
  desktop's fragile deep import of `@progressView/*`). ~150–250 LOC. **M.**
- `src/agent/output/documentRounds.ts` (565) — `nextRound` (~110 LOC) mixes
  TeXCount/prompt/media/logging, and compile-rejection facts live in a
  hand-rolled mutable object cleared via `delete` in 4 places. Lift to a typed
  state value with explicit set/clear; split `nextRound`. ~40–60 LOC. **M.**
- `src/tools` long functions — `recoverOrLaunchWorkflowChild` (~278),
  `executeInBand` (~233), `acceptFiles` (~211): extract labelled phases into
  named `Effect.fn` helpers in-file. ~0–60 LOC (complexity win). **M.**

## Also-rans (real, but deliberately low priority)
- **Automatic-retry batch duplicated** between `ModelInvoker.invoke` and
  `runtime/run/modelCall.callModel` — same attempt/`autoRetryable`/backoff
  skeleton twice. Extract `automaticRetryBatch` serialized through the existing
  `ModelRetryGate`; ~25–40 LOC, **M** (invoke also folds manual-retry +
  token-recovery + background arms, so extract carefully).
- **`compileCheck.ts` errored→synthetic-failure** shape built 3×; one
  `erroredOutcome()` builder → ~15–20 LOC. **S.**
- **GitHub subscription-halted formatters** (`formatUtils`/`formatPREvent`/
  `formatRepoEvent`/`formatIssueEvent`) — `formatSubscriptionHalted(ref, detail)`
  → ~15 LOC. **S.**
- **`packages/llm`** — `sdkFailure` duplicated between `anthropicMessages.ts`
  and `googleInteractions.ts` (~15 LOC); otherwise already consolidated behind
  `transport.ts`. Per-provider usage canonicalization is genuinely shape-specific
  — leave it.

## Explicitly NOT debt (so a future pass doesn't chase them)
- The ~10 snapshot/position write points in `loop/toolUse.ts` — distinct,
  legitimate ledger write points, not copy-paste.
- `state/stateSettings.ts`'s 63 `.prefault` entries — a legitimate SSOT catalog.
- `sessionFold.ts` (1477) / `runStateFold.ts` (795) / `sessionLayer.ts` (1224)
  / `ToolEditApprovalController.ts` — genuinely-complex incremental state
  machines, single-responsibility.
- The three-renderer run-status derivation (CLI) — already shares
  `@shared/runs/runStatusDisplay`.
- The Claude/Codex SDK mirror in `src/tools` — parallel but SDK-event-specific
  with exactly 2 callers; borderline on the "factories need multiple real
  callers" rule. Leave it.

## Suggested order
1 (combinator) → 2 (builders) → 3 (CLI modals) are the low-risk, high-ROI
batch. 4 (event vocabulary) is the most valuable *structural* fix. 5
(God-modules) is incremental hygiene, best done opportunistically when touching
those files anyway.
