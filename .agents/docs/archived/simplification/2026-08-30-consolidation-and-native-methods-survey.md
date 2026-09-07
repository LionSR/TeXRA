# Survey: code consolidation and native-method opportunities (2026-08-30)

Status: implemented
Archived: 2026-09-06

> **Status:** Written 2026-08-30 against branch HEAD `b36051b`
> (`fix(hosts): preserve launch and walkthrough actions`, #11633). Scheduled
> routine re-ran the standing question — "find duplicate/similar logic to
> consolidate, and hand-rolled code that a native method or the standard
> library already covers" — one day after
> `2026-08-29-consolidation-and-native-methods-survey.md`. **Verdict: nothing
> new survives scrutiny.** No code changes accompany this entry.

## 0. Why this pass is short

This is the ninth consecutive daily run of this exact question. The five days
before 2026-08-29 already produced six back-to-back simplification survey
rounds (`2026-08-25-simplification-survey-49-candidates.md` through
`2026-08-27-simplification-survey-round5-deep-read.md`, the latter reading
all 295,148 lines of production TypeScript), and 2026-08-29's dedicated pass
narrowed to the two lenses this routine asks about and found nothing new.

Between that pass's grounding commit (`e7f535c`) and this one (`b36051b`), 42
commits touched `src/` or `packages/*/src/` — real feature and fix work
(shared workflow run model, CLI account/access surface, progress-view
phase-tab UI, several `simplify(...)` PRs already landed by other passes),
not a quiet period. So this pass re-ran the same two lenses against current
HEAD rather than assuming yesterday's answer still holds, and additionally
spot-checked the areas touched by those 42 commits for newly introduced
duplication or hand-rolled patterns.

## 1. Method

Four independent read-only survey agents, each required to back every
candidate with a `file:line` citation and a grepped (not guessed) instance
count at current HEAD:

1. Cross-tree duplication among the three parallel webview trees
   (`webview/frontend`, `progressView/frontend`, `settingsView/frontend`) —
   message dispatch, listener lifecycle, signal registries, persistence,
   debounce, id generation, formatting/validation helpers.
2. Hand-rolled code vs. native ES2022+ builtins or existing root
   dependencies, repo-wide: dedup loops, deep clone, debounce/throttle,
   promise-chain queues vs. `p-queue`, `hasOwnProperty.call`, hand-rolled
   sleep, chunking/grouping, string padding, retry/backoff duplication —
   including a direct check of the six browser-reachable `@utils/*` modules.
3. Duplicated logic across `src/agent/modelHandlers/<provider>/` and
   `src/tools/` — request-building, response/error mapping, streaming-chunk
   parsing, and repeated tool-schema fragments.
4. Compatibility/migration machinery whose replacement shipped more than
   three months ago (before 2026-05-30) and desktop-only migration code
   (disallowed by policy on a package with no public release).

## 2. What was checked and ruled out

**Native-method opportunities (repo-wide production code):** zero hand-rolled
dedup loops, deep-clone helpers (`structuredClone` is already the established
pattern, 23 call sites: 6 production, 17 test-kernel), debounce/throttle
implementations (`p-throttle` is already used where needed),
`hasOwnProperty.call` calls, `setTimeout`-based sleeps, or
chunking/grouping/padding reimplementations. Two attempt-counter loops exist:
`inBandSubagentExecution.ts:628` is durable execution-lease reconciliation,
not error-driven retry; `StreamSnapshotStore.ts:1617`
(`retryDirtyWrites`) bounds `MAX_DIRTY_WRITE_RETRIES` blanket
re-persist attempts over all still-dirty sidecar writes rather than reacting
to a specific error, so it is a bounded durability flush, not a `p-retry`
shape either. (2026-08-29's doc cited this same loop at a stale line number,
`StreamSnapshotStore.ts:1657`, which now lands inside the unrelated
`drainSeedChains` loop — corrected here.) `p-queue` is already used
correctly wherever a sequential-await queue shape exists
(`packages/desktop/src/main/index.ts`, `desktopSupabaseAuth.ts`); no
unmanaged promise-chain queue found elsewhere.

**Model handlers and tools:** SDK error mapping is already fully
consolidated through `support/sdkErrorMetadata.ts`; per-provider
OpenAI-compatible handlers (DeepSeek, Kimi, GLM, MiniMax, DashScope, XAI)
share `ReasoningModelHandlerOpenAI`/`OpenAICompatibleModelHandler` and only
override genuinely provider-specific quirks; streaming loops iterate
different SDKs' native async-iterable shapes, not hand-rolled SSE parsing.
`src/tools/core/inputSchema.ts` (`nullishWithDefault`, 17 call sites) and
`src/tools/delegation/inputFields.ts` already centralize shared schema
fragments.

**Cross-tree webview duplication:** message dispatch, window-listener
lifecycle, signal-reset registries, and webview persistence all already
route through shared bases (`BaseViewMessageHandler`, `BaseWebviewApp`,
`createTrackedSignalRegistry`, `createWebviewStorage`). No near-identical
logic exists outside those shared points; remaining per-tree code (manager
classes, domain-specific validation) is genuinely distinct, not copy-paste.

**Compatibility/migration machinery:** every dated compat reader found is
either less than a week old (#11568, 2026-08-29), has an explicit future
retirement date (`executionLease.ts:104`, retire after 2026-11-24), is
already tracked by an open issue (#10921, #10300), was already adjudicated
and rejected for removal with a live-data-loss risk
(`migrateLegacyWorkspaceStorage`, `.agents/docs/archived/simplification/2026-08-25-simplification-survey-49-candidates.md:2447`),
still has a live producer (`workflowOutputCopyStem`'s legacy filename
grammar — the extension's "Save as copy" action still writes it), or is a
permanent reader over immutable historical data that the code's own
comments already exclude from the retirement policy — for example
`agentRoster.ts:54`'s `AgentDelegationScopeLegacySchema`, introduced
2026-08-04 (#9705) but self-documented as "a permanent parse-side reader,
not a dated migration," so it doesn't belong in a retirement-window bucket
at all. `packages/desktop/` has zero `legacy`/`migrat` hits — already
compliant with the "no migration machinery" rule by having none to remove.

## 3. Verdict

No candidate in any of the four lenses clears the bar prior rounds set. The
nine open `label:tech-debt` issues at HEAD are all pre-existing and outside
this survey's scope (relay/legacy retirement, docs deployment, run-window
semantics, roster/predicate consolidation, workflow-projection removal,
serialization rulings) — none overlaps or needs updating from this pass.

This entry exists to record that the routine ran and to save the next pass
from re-treading the same ground; no code changes accompany this cycle.
