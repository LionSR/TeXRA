---
created: 2026-10-11
updated: 2026-10-12
status: proposed
---

# TeXRA refactoring-debt audit

> **Status:** proposed. A dated audit of candidate refactors. The verification
> pass (2026-10-12), independently corroborated by a second automated reviewer,
> refuted every finding: the dedup opportunities are already realized, and the
> size-concentration items would need single-caller extractions the repo bans.
> Conclusion: no structural refactor is warranted now. No code has landed.

_Generated 2026-10-11 by a scheduled codebase scan. Three subagents scanned the
harness, the app (`texra`/`llm`), and the three hosts (`extension`/`cli`/`desktop`)
in parallel; findings were cross-checked against the repo's own
`config/ratchets/core-quality/` baselines and spot-verified with grep._

> **Verification update (2026-10-12).** Before implementing any finding, each top
> candidate was read in full to confirm the refactor was real. **It wasn't.** Every
> "duplication / cheap win" below collapses on close reading: the maintainers have
> already extracted the shared cores, and what the structural scan flagged as
> parallel code is either already-shared-plus-irreducible-per-case-specifics,
> divergent-by-design with documented intent, or a cleanly-decomposed large file.
> No code refactor was shipped, because forcing one would be net-negative churn
> that this repo's own rules (single-caller-extraction ban, "build nothing for a
> problem we don't have", "never split a file mechanically") are designed to reject.
> See **Verification results** below for the per-finding evidence. The headline
> stands, now stronger: **this is an unusually well-refactored codebase.**

## Headline

The codebase is **well-disciplined, not messy in the usual sense**. Debt is not
comment-marked (a word-boundary grep finds exactly one source file with a `TODO` —
`replacement/rulesRegex.ts` — and zero `FIXME`/`HACK`/`XXX`), and the cross-cutting
concerns you'd expect to be copy-pasted are already centralized:

- error formatting → `@utils/errors/errorMessage` (`toErrorMessage`/`ensureError`, used throughout)
- JSON parsing → `@common/parsing/safeParseJson`
- file-tool boilerplate → `@tools/pathResolution` + `fileEditFlow` + `formatting`
- model/provider config → `llm-zoo` / `computeModelOptions` (data-driven)
- cross-host rendering → `sharedHostRequests`, `@shared/transcript`, `@ui/markdown`
- LLM wire transport → `packages/llm/src/api/transport.ts` + `assembleTurn` + `parts`

So the remaining debt is **structural concentration** — a few god-files/factories —
rather than scattered duplication. (The scan initially flagged a "parallel
CLI-agent pair" too, but verification found its shared core already extracted; see
below.) Net LOC savings are therefore moderate; the real payoff is maintainability,
testability, and clearing the project's own grandfathered ratchet baselines (41
harness files are frozen over the 400-line bar in `file-size.json`).

---

## Prioritized list — ⚠️ SUPERSEDED (raw scan output, do NOT implement)

> This section and the **Ranking summary** below are the pre-verification scan
> output, kept only for provenance. **Every item in it was refuted** by the
> **Verification results** section further down — do not act on the priorities,
> LOC estimates, "confidence: verified" labels, or sequencing here. They are
> wrong or overstated; the verified conclusion is that no refactor is warranted.

### 1. `codex*` vs `claudeAgent*` — two ~1,200-LOC parallel CLI-agent families ⭐ top pick

**Impact: highest. Savings: ~200–350 LOC. Effort: L. Confidence: verified.**

- **Where:** `packages/texra/src/tools/codex*.ts` (~1,193 LOC) and
  `claudeAgent*.ts` (~1,368 LOC), over an existing shared layer `agentCliShared.ts`
  (~835 LOC incl. model/session helpers).
- **What's messy:** Both families drive an external CLI coding agent (stream a turn
  into the transcript, loop follow-ups) and a large parallel skeleton was never
  hoisted into the shared layer:
  - Both export their own `runStreamedTurn` (`codex.ts:229`, `claudeAgent.ts:177`) —
    same shape: drain the SDK async-iterator as an Effect `Stream`, collect
    `responseParts`/`usage`, emit/end live tool cards, `Effect.ensuring` finalizer
    calling `endOpenToolUseCards`. Only the per-SDK event switch differs.
  - Tool-card builders (`buildCodex*ToolLog` vs `buildClaudeToolUseLog` +
    `handleAssistantBlocks`/`handleToolResults`) both map "SDK event → `ToolUseLog`
    → `emitToolUseCard`/`endToolUseCard`". Verified: this idiom lives in **only
    these 5 files**, so it's a self-contained parallel pair, not a shared primitive.
  - `codexImport.ts` vs `claudeAgentImport.ts` both hand-roll `PLATFORM` package
    maps, a `*_BINARY_NAME = IS_WINDOWS ? …`, a dynamic SDK `import()`, and a
    near-identical `createCachedBinaryResolver(...)` call.
- **Approach:** Add a generic `drainAgentStream({ onEvent, finalize })` + a
  `ToolCardTracker` to `agentCliShared`; each provider supplies only its
  event→`ToolUseLog` mapping. Unify the two `*Import` resolvers behind one
  config-driven resolver.
- **Why #1:** Largest body of genuine duplication in the repo (~2,500 LOC affected),
  a concrete and low-risk seam, and every new external-agent integration pays the
  tax again until it's fixed.

### 2. `sessionFold.ts` (1,302) + `runStateFold.ts` (772) — parallel folds over one event vocabulary

**Impact: high. Savings: ~150–250 LOC. Effort: L. Confidence: ratchet-corroborated.**

- **Where:** `packages/harness/src/shared/session/{sessionFold,runStateFold}.ts`.
  `sessionFold` is the single largest file in the package (3.25× the 400-line bar).
- **What's messy:** Two large `switch` dispatchers over the _same_ ~18-arm
  discriminated event vocabulary (`run.activate`, `model.message`, `tool.intent`,
  `tool.result`, …; 32 case arms in one, 17 in the other). Not copy-paste — they
  project different things (`SessionView` vs `RunState`) — but **shotgun surgery**:
  every vocabulary change must be edited in lockstep in both, with per-arm payload
  destructuring repeated across both.
- **Approach:** Extract a shared per-event dispatch skeleton/table so each fold
  supplies only its arm bodies; lift sessionFold's two over-complex arm handlers
  (flagged in `complexity.json`) into named functions. Keep the two projections
  separate — unify only the skeleton.

### 3. `controllers/session/Database.ts` (1,186) — one `databaseLayer` closure with ~61 inline sub-closures

**Impact: high. Savings: ~150–250 LOC. Effort: M–L. Confidence: verified (61 closures).**

- **Where:** `packages/harness/src/controllers/session/Database.ts`
  (`max-lines-per-function` flags 4 functions >150 lines).
- **What's messy:** Classic god-layer: connection management, SQL exec/decode,
  aggregate-claim concurrency, and projection catch-up are all private closures in
  one lexical scope. The three `writeFailed`/`readFailed`/`openFailed`
  error-wrapping closures are near-duplicates.
- **Approach:** Carve out a "projection runner" (`applyOp`/`project`/
  `catchUpProjections`/`setProjectionState`) and a "row codec/exec" module, each
  taking the connection/services as params; the layer wires them. Collapse the
  three error-wrappers into one tagged-error helper.

### 4. CLI `createChatSessionController` — an 844-line factory function

**Impact: high maintenance burden. Savings: ~50–100 net LOC. Effort: L.**
**Confidence:** the 844-line function length is `wc -l`-verified (not ratchet-sourced);
the sibling counts below were hand-counted and corrected 2026-10-12. Finding refuted
in Verification results — a single-consumer justified factory, not a split target.

- **Where:** `packages/cli/src/chat/chatSessionController.ts` (lines 309–1153, an
  844-line function) — one function holding ~25 nested closures (`startRootRun`,
  `resume`, `startSession`, `activateSkill`, …) over shared mutable state
  (`preparingRoot`, `pendingSkillActivations`, …). Siblings in the same shape:
  `runChatTui.tsx` `runChat` (733-line file) and `App.tsx` (697-line file, ~28
  hook call sites across ~10 distinct hooks). `packages/cli/` is not covered by
  `file-size.json`, so these are not ratchet-corroborated.
- **What's messy:** The entire chat-session lifecycle lives in one closure sharing
  mutable vars — hard to test in isolation, high change-risk. This is the host-side
  twin of the harness god-files.
- **Approach:** Extract cohesive collaborators (resume controller, skill-activation
  store, root-run launcher) each owning their slice of state; split `runChat`
  startup into named phase helpers; lift `App.tsx` sub-state into hooks/children.

### 5. Cheap wins bundle — best savings-per-effort (do these first as warm-ups)

**Impact: moderate. Savings: ~270–420 LOC combined. Effort: S–M each. Confidence: evidence-backed.**

- **GitHub per-scope event formatters** (`tools/github/format{PR,Repo,Issue}Event.ts`):
  the same comment/close/subscription-error messages are formatted 3× across PR/Repo/Issue
  scopes while real primitives already sit in `formatUtils.ts`. Collapse into
  scope-parameterized functions. **~80–120 LOC, M.**
- **`LatexMediaManager.ts`** (715): four+ private methods repeat the same
  "filter to `.tex` → resolve latex dir → walk deps → mirror into workspace"
  skeleton. Extract one `mirrorDependencies({ files, collect, resolveDest })`.
  **~100–150 LOC, M.**
- **Per-host subscription sign-in presenters** (`extension` 201 / `cli` 152 /
  `desktop` 73): all re-derive the same device-code → copy-code → open-URL flow and
  wording. Lift into one `buildSubscriptionSignInPresenter(primitives)` in `texra`.
  **~60–100 LOC, M.**
- **Per-provider token-usage mapping** (the four `llm/api` usage mappers): looks like
  identical total arithmetic with per-provider field names. One `buildUsage({...})`
  normalizer. **~30–50 LOC, S.**

---

## Ranking summary

| #   | Area                                       | LOC saved | Effort | Savings/effort | Note                                  |
| --- | ------------------------------------------ | --------- | ------ | -------------- | ------------------------------------- |
| 1   | `codex*`/`claudeAgent*` CLI-agent families | 200–350   | L      | ★★★            | genuine large-scale dup; top priority |
| 2   | `sessionFold` + `runStateFold` folds       | 150–250   | L      | ★★             | biggest file; shotgun-surgery risk    |
| 3   | `Database.ts` god-layer (61 closures)      | 150–250   | M–L    | ★★             | clean projection/codec seam           |
| 4   | CLI `createChatSessionController` factory  | 50–100    | L      | ★              | maintainability, not deletion         |
| 5   | Cheap-wins bundle (4 items)                | 270–420   | S–M    | ★★★            | start here; lowest risk               |

**Suggested sequencing:** ~~#5 → #1 → #2/#3 → #4~~ — **superseded. Do not follow
this sequence.** Verification refuted every item; implementing any of them would be
the net-negative churn the repo's rules reject. See **Verification results** below.

## Verification results (per finding)

Each finding was opened and read against its actual source before any edit.

- **#1 `codex*`/`claudeAgent*` — already shared.** The common machinery is already
  extracted: `importForeignSdk` and `createCachedBinaryResolver`/`binaryIfPresent`/
  `resolvePackageDir` in `@texra/tools/support/externalBinaryUtils` (both `*Import.ts`
  use them), `buildAgentCliLaunch`/`dispatchAgentCliTool` in `agentCliShared.ts`, and
  `emitToolUseCard`/`endToolUseCard`/`endOpenToolUseCards` shared by both card
  builders. The two `runStreamedTurn` bodies share only a ~5–10-line stream-drain
  skeleton; the bulk is irreducibly provider-specific (different SDK event
  vocabularies, promise-returning `runStreamed` vs synchronous `query()`, abort-link
  - background-task finalizer vs turn-card finalizer, different return types,
    throw-vs-flag error models). A `drainAgentStream` wrapper would be a leaky
    abstraction saving almost nothing. The only literal twins are the two-line
    `IS_WINDOWS ? 'x.exe' : 'x'` and the per-provider platform-package maps, which are
    data, not logic. **No clean refactor.**
- **#2 `sessionFold`/`runStateFold` — not god-functions.** `sessionFold.ts` is ~40
  small, well-named functions (`applyOwnArm`, `withAggregates`, `foldDurable`,
  `reconcileExistence`, …); it is large by line count because an event fold
  legitimately has many arms, each doing real projection work. The "2 over-complex
  functions" are two inherently-branchy arm handlers. The two folds project different
  things and share the event-type contract, not code. Unifying their dispatch
  skeleton saves little and couples two independently-evolving projections; splitting
  the file is the mechanical split the harness AGENTS.md explicitly forbids.
  **No clean refactor.**
- **#3 `Database.ts` god-layer — genuine size concentration, but a module split
  would be a single-caller extraction.** The 1186-line layer and its ~61 inline
  closures are real (the repo's own ratchet tracks the file size). But the proposed
  "projection runner" and "row codec/exec" modules would be wired only by
  `databaseLayer` — a single consumer — which is exactly the single-caller extraction
  AGENTS.md bans, and this audit supplies no net-LOC accounting showing the new module
  interfaces delete more structure than they add. The one in-place idea the earlier
  draft floated — collapsing the three `openFailed`/`writeFailed`/`readFailed`
  wrappers — does **not** hold either: each is a minimal two-line builder for a
  _distinct_ tagged-error channel (`DatabaseOpenFailed`/`WriteFailed`/`ReadFailed`),
  used at different sites; merging them needs a generic constructor plus three
  bindings, which adds indirection and blurs three typed channels, so it cannot net
  negative. Net result: **nothing here is worth doing** — not a module split, not the
  error-wrapper merge. Downgraded from "strongest candidate" to "no action."
- **#4 CLI `createChatSessionController` — a justified factory, not a split target.**
  It has one production consumer (`runChatTui.tsx`), and it captures initialization
  context in its closures — precisely the repo's documented _justified_ factory case.
  The proposed resume-controller / skill-activation-store / root-run-launcher
  collaborators would each be single-consumer abstractions around state that is
  coordinated in one init closure by design. Without additional consumers or
  build-implies-delete accounting, splitting it for isolation is not warranted. The
  844-line function is a readability cost, but the remedy (if any) is in-place, not
  new single-use modules. **No clean refactor.**
- **#5c per-host sign-in presenters — not one flow.** The three presenters implement
  genuinely different host UX: the CLI (`subscriptionLogin.ts`) only prints copyable
  instructions (no clipboard write, no page open), the extension attempts a clipboard
  write and offers an async open action, and the desktop presenter requires the
  clipboard write before showing a modal. Centralizing them would either change host
  UX/error semantics or need a branch-heavy primitives interface — not the low-risk
  consolidation claimed. **Not worth it.**
- **#5a GitHub per-scope formatters — divergent by design.** The genuinely shared
  parts are already in `formatUtils.ts` (`formatCommentEvent`, `authorOf`, `sections`,
  `truncate`, `wrapWebhookEvent`, `formatPreviousStateHint`), used by all three
  scopes. The remaining divergence is documented intent: the repo-level formatter uses
  a "denser single-line shape and intentionally does not route through" the shared
  comment path, and `formatPRIssueComment` is deliberately named and kept distinct
  from the issue path because the two are not interchangeable and TypeScript can't
  catch a swap. The subscription-error one-liners differ only by a subject noun; one
  parameterized helper saves ~6 lines against a 3-caller indirection. **Not worth it.**
- **#5b `LatexMediaManager` mirror methods — shared skeleton already extracted.**
  `forEachFile` (the concurrency + best-effort-recover + log skeleton), `resolveLatexDir`,
  `pathToLocationIn`, and `extractFigurePathsFromLatex` are already shared across the
  mirror methods. What remains per method is real orchestration difference (BFS
  recursion with a worklist, `.tex` snapshotting, stat-gating, vision-context vs
  mirror-only). The one micro-nit — a `texFilesOf()` helper — covers only 3 `.tex`
  filter sites, so it nets ~zero (6 lines become a declaration plus 3 calls).
  **Nothing worth doing here.**
- **#5d llm per-provider token-usage mapping — divergent semantics.** OpenAI's
  `input_tokens` is already the combined input (and `total_tokens` comes from the
  provider); Anthropic's `input_tokens` excludes cache, so it adds the uncached,
  cached, and cache-creation counters itself and then computes the total; the
  `providerUsage` shapes (`xai`-conditional vs always-`anthropic` with a cache
  breakdown) differ entirely. A `buildUsage` normalizer would need enough
  per-provider policy to obscure that arithmetic. **No clean refactor.**

**Net:** the dedup space is exhausted — the maintainers got there first — and the
size-concentration items (#3, #4) resist the obvious fix too, because splitting them
into helper modules would be single-caller extractions the repo deliberately bans. A
second automated reviewer (Codex) independently reached the same verdict on every
item, citing the same AGENTS.md rules, and further showed that even the one in-place
cleanup the draft kept (merging the three `Database.ts` error-wrappers) would add
indirection rather than remove it — they are three distinct typed error channels. So
the only thing left standing is the optional `texFilesOf()` micro-nit (~8 LOC),
itself borderline against the one-expression-helper bar. **The actionable conclusion
is that this codebase does not currently warrant a structural refactor — nor any
in-place cleanup worth a PR.** If a future change adds a _second_ consumer to the
`Database` projection logic or the chat controller, that is the moment an extraction
would pay for itself; until then, leave them.

## Not worth refactoring (checked, came back clean)

- LLM provider `streamTurn`/wire codecs — genuinely provider-specific, already on
  shared transport. Not dup.
- `replacement/rules.ts` vs `maxRules.ts` — different rule sets sharing `helpers.ts`.
- LaTeX figure parsing — centralized in `extractFigure.ts`, reused. Well-factored.
- The extension's two webview-messaging architectures (settingsView vs progressView)
  are a **documented intentional** split (`extension/src/AGENTS.md`); converging them
  is a deliberate migration, not a quick win — confirm before touching.
- Error formatting, JSON parsing, file I/O tooling, output-truncation constants —
  all already centralized. Don't spend budget hunting dedup there.
