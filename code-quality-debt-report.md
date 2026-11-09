# Code-quality debt analysis — TeXRA

_Scheduled audit, 2026-11-09. Scanned `packages/*/src` (~250k LOC) with five parallel
subagents (harness core, app, CLI, llm/hosts, cross-cutting), cross-checked against the
repo's own debt program and git churn. Every finding below was re-verified against the
tree by hand before inclusion._

## Bottom line

**The codebase is in good shape.** The `AGENTS.md` discipline — one-owner-per-fact, no
barrels, no legacy-compat layers, typed ports, declarative tables — is actually enforced,
and there is an active, detailed debt program already running (design "red-flag" rounds
1–3 under `.agents/docs/`, with ~40 findings catalogued and many PRs landed/in-flight).
Four of the five scans independently reported "unusually clean," and three of the
cross-cutting suspicions (duplicate schemas, re-export shims, duplicated host↔webview
plumbing) were **refuted** by the evidence.

So this is **polish, not rescue.** There is no large rotten area and no single big
deletion. The genuine, verified debt is modest and concentrated. Ranked below by
payoff-to-effort. None of the top items appear to overlap the deletion lists in the
current red-flag rounds I reviewed, so they look like net-new candidates — worth a
quick check against the in-flight PRs before starting.

---

## Prioritized findings

### 1. llm provider history-lowering: duplicated replay skeleton + rejection vocabulary + continuation plumbing
**Impact: ~120–180 LOC · Effort: Medium · shipped code · highest genuine value**

- `packages/llm/src/api/anthropicMessages.ts` `invocationBody` (~143–255)
- `packages/llm/src/api/googleInteractions.ts` `lowerMessages` (~103–214), `googleContinuation` (~524)
- `packages/llm/src/api/openaiResponsesLower.ts` `lowerMessages` (~61–224), `withResponsesContinuation` (~238)

The stream/assembly/transport/upload spine is **already** one owner (`assembleTurn.ts` +
shared `transport.ts`/`uploadCache.ts`/`background.ts`) — the original suspicion that the
three adapters duplicate request/response/stream handling is **refuted**. What is still
triplicated is the *history-lowering* layer: each provider re-writes the same loop
skeleton (iterate `replayableHistory` → switch on `message.role` → resolve tool results →
switch on `part.kind` → reject foreign content via `sameModelOrigin`). Verified **29
near-identical `invalid-request` rejection sites** (11 + 11 + 7) with almost-identical
wording. Separately, Google and OpenAI each hand-write ~60 lines of structurally identical
continuation-anchor plumbing (verified **5 `prefixFingerprint` call sites**): build prefix
→ fingerprint → store anchor → re-validate/slice. The wire shapes genuinely differ per
provider (keep those); the control-flow skeleton, the foreign-evidence guard, and the
rejection wording do not.

**Approach:** extract a `lowerHistory(messages, turn, handlers)` driver owning the role
switch + foreign-evidence refusal (one owner for the wording); providers pass only their
per-`part.kind` wire emitters. Add one `storedContinuation({domain, lowerAndCount,
anchorOf})` helper for Google+OpenAI (Anthropic correctly excluded — it uses
`anthropicThreads`). **Caveat:** security-adjacent replay/continuation validation — verify
each provider's exact refusal semantics survive.

### 2. `toErrorMessage(Cause.squash(cause))` idiom repeated verbatim
**Impact: ~40–60 LOC · Effort: Small · lowest risk · cross-cutting**

Verified **35 occurrences** across cli, texra, extension, llm (e.g.
`cli/src/chat/tui/state/transcript.ts:214`, `extension/src/extension.ts:489`,
`texra/src/tools/latex/latexPreview.ts:176`; 103 `Cause.squash` total). Every site
re-imports `Cause` and re-writes the squash-then-stringify dance to turn a failed Effect
`Cause` into a display string — several also squash the same cause twice (once for the
message, once for `annotateLogs({data})`). This exact "log the cause and continue" shape
is *mandated* by the silent-degradation rule, yet has no owner.

**Approach:** add one browser-safe `causeMessage(cause)` helper beside `toErrorMessage` in
`@utils/errors/errorMessage`; optionally `logDegraded(channel, message, cause)` for the
full warn+annotate shape. Mechanical, no behavior change. **This is the cleanest win — do
it first.**

### 3. Run-loop `Cause`/`Exit` failure-classification duplicated on the hot path
**Impact: ~30–50 LOC · Effort: Medium · interrupt-safety surface**

Verified **17-site spread** of `Cause.hasInterrupts` / `findStorageRefusal` across
`agent/`. The same four-way decision over a failed cause (interrupt → reraise; storage
refusal → `runRefusal`; `findError`+`Result.isFailure` → `die(squash)` defect; else typed
error) is hand-written at `ModelInvoker.ts:315` and `:750` (twice in one file),
`toolUseDispatch.ts:536`, `tools/core/definition.ts:114`, and more. The repo *already*
tracks `Cause.hasInterrupts` in its `check:fact-spread` list — institutional awareness this
fact is leaking.

**Approach:** one `splitRunCause(cause)` returning a tagged union
`{interrupt}|{refusal}|{defect}|{error}`, beside the existing `findStorageRefusal`; each
site collapses its ~15–20-line block to a 4-arm match. Helper must still expose the raw
cause for the few sites handling a finalizer-failure-beside-interrupt
(`toolUseDispatch.ts:539`).

### 4. `replacement/` Unicode→LaTeX mapping split across three tables with silent drift
**Impact: ~30–60 LOC + removes a drift hazard · Effort: Medium · shipped code**

Verified three tables for one concept: `advanced.ts:125` `MATH_UNICODE_MAP` (~155 entries,
in-math only), `rules.ts:792` `UNICODE_REPLACEMENTS` (~90, global), `rules.ts:343`
`HTML_ENTITY_REPLACEMENTS` (~110, global). Greek letters/operators appear in all three
encodings, and there's real key overlap (`μ` U+03BC vs `µ` U+00B5 both → `\mu`, plus
hard-coded `$ μs` rules). A contributor adding a symbol must know which of three tables and
contexts — drift between them is silent.

**Approach:** one `UNICODE_TO_LATEX` keyed by codepoint, each row tagged `math-only |
global`; derive the two passes as filtered projections (the `latexToolchain.ts` pattern
this package already uses elsewhere). Keep `HTML_ENTITY_REPLACEMENTS` separate (distinct
decoding boundary), but document the boundary. The data rows are intrinsic and must
survive — the win is the drift hazard, not raw line count.

### 5. `scripts/tui-harness.tsx` — 50-flag scenario switchboard
**Impact: ~500–900 LOC · Effort: Medium · but dev-only tooling, not shipped**

Biggest and messiest single file in the CLI package (2059 lines). Verified **50
`HARNESS_*` env booleans**, each hoisted to a const, driving ~40 top-level `if (SHOW_*) {…
publish({…}) }` blocks that each imperatively hand-build one demo — a flat cross-product of
independent flags with repeated publish scaffolding. This is exactly the "no option for a
special case" shape `AGENTS.md` targets, written as scattered env reads.

**Approach:** keep the `publish`/`seedRun` core; replace the 50 booleans with one
`HARNESS_SCENARIO=<name>` selector over a `Record<name, (seed)=>void>` registry, factoring
the recurring message/tool/child publish shapes into 3–4 helpers. **Lower stakes** than the
above because it's not in `src` — largest LOC, lowest priority.

---

## Two flags (not clean refactors — need a decision, not a mechanical edit)

- **~700 LOC of shipped personal-style dictionaries.** `replacement/maxRules.ts` (`max_style`
  / `max_style_regex`: `\tauf`, `\barrho`, trigger-word lists) plus `rules.ts`
  `PERSONAL_STYLE_REPLACEMENTS` and `GPTNESS_REPLACEMENTS` are one person's curated
  preferences hard-coded as built-in categories — duplicating the engine's existing
  `CUSTOM_REPLACEMENTS_SETTING` mechanism (`engine.ts:227`), and brushing the `AGENTS.md`
  rule against identifiable-person-specific material in shipped assets. Relocating to
  seeded user config is a product/privacy call, not a refactor — **record as a
  `find-simplification` proposal**, don't just delete.

- **Settings-catalog schema-wrapper ceremony.** ~31 rows in `shared/state/stateSettings.ts`
  spell out `Schema.Boolean.pipe(withDecodingDefault(Effect.succeed(false)))` by hand;
  `providerSettings.ts` already shows the fix (`endpointRow` factory) but its China-region
  toggles right below don't use a parallel `regionRow`. ~40–70 LOC via small
  `boolSetting`/`intSetting`/`regionRow` constructors. Small, low-risk.

## Small clean wins (Small effort each, if touching those files anyway)

- **`TranscriptReader`/`WorkPlanReader` merge** (`cli/.../panes/`): identical reader shells
  differing only in text source + two flags → one parameterized `StreamReader`. ~40 LOC.
- **Credential status-row UI** (settings Git/Provider/Subscription tabs): same "show origin
  + set/replace/remove/create-url" done three ways; `renderSetStatusIcon` is shared but the
  row/action cluster isn't. One `renderCredentialStatusRow` helper. ~40–70 LOC.

## Explicitly NOT debt (do not touch)

The large files that *look* like debt are deliberate deep modules — leave them: the
harness's `sessionViewUpdate.ts` (1120, one reducer), `toolUseDispatch.ts`,
`databaseLayer.ts`; the app's `latexToolchain.ts`, `controlStyles.ts`, `arxivProcessor.ts`,
`openGuiWindow.ts`, `settingsViewMessages.ts`; the CLI's `statusBarDisplay.ts`,
`staticTranscriptRing.ts`, `chatSessionController.ts`; the llm wire codecs and OpenAI file
split. The wide `TranscriptRow` / session-event unions are switched in ~6 projection files
each — this is change-amplification, but the graceful fix is **adding `assertNever`
exhaustiveness guards** (Effect `Match` used 0×, `assertNever` only 12× repo-wide), not a
generic dispatcher, which would be the speculative generality the repo bans.

## Suggested order

1. **#2** `causeMessage` helper — Small, zero-risk, 35 sites, do first.
2. **#1** llm history-lowering — Medium, highest shipped-code value (~120–180 LOC).
3. **#3** `splitRunCause` — Medium, pairs naturally with #2 (both are Cause idioms).
4. **#4** Unicode mapping consolidation — Medium, removes a real drift hazard.
5. Flags/small wins as opportunistic cleanups; **#5** harness last (dev-only).
