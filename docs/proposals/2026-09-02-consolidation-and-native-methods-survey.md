# Survey: code consolidation and native-method opportunities (2026-09-02)

> **Status:** Written 2026-09-02 against branch HEAD `646475d` (`ci:
issue-tracker raise the bar for post-merge follow-up issues`, #11750).
> Scheduled routine re-ran the
> standing question — "find duplicate/similar logic to consolidate, and
> hand-rolled code that a native method or the standard library already
> covers" — three days after
> `2026-08-30-consolidation-and-native-methods-survey.md`. **Verdict: nothing
> new survives scrutiny.** No code changes accompany this entry.

## 0. Why this pass is targeted rather than a full re-sweep

Six full simplification survey rounds (2026-08-25 through 2026-08-27, the
last reading all production TypeScript) and two prior dedicated passes on
this exact question (2026-08-29, 2026-08-30) already swept the repo
end-to-end and found nothing outstanding in either lens. Between
2026-08-30's grounding commit (`b36051b`) and this one, 76 commits touched
`src/` or `packages/*/src/` — real work, and notably a large share of it was
already simplification/consolidation churn landed by other passes:
`consolidate: fold duplicated logic into shared helpers` (#11736),
`refactor: macroscopic simplification round over verified findings`
(#11737), `refactor: churn-residue simplification sweep` (#11746), two
`refactor: behavior-preserving simplification sweep` PRs over
`packages/*/src` and repo-root `src/` (#11733, #11725), and
`refactor: simplify TypeScript implementations` (#11708). Given that volume
of upstream simplification work already targeting this exact question, this
pass re-ran the standard native-method tells against current HEAD and
audited every one of the 76 commits' diff for newly introduced duplication,
rather than re-deriving the six prior full-repo rounds' conclusions from
scratch.

## 1. Method

- Direct `rg`/`git diff` sweeps of `src/` and `packages/*/src/` (production
  code only) between `b36051b` and current HEAD (`646475d`) for the classic
  tells: `.hasOwnProperty(`, hand-rolled `setTimeout`-based sleeps,
  `JSON.parse(JSON.stringify(` deep clones, `filter(...).indexOf(...) ===
index` dedup loops, `arr[arr.length - 1]` vs. `.at(-1)`, new `Object.assign(`
  call sites, hand-rolled `debounce`/`throttle` definitions, and new manual
  attempt-counter retry loops.
- Every newly added hit in the 76-commit diff traced to its call site and
  checked against the accepted carve-outs from the 2026-08-29/08-30 rounds
  (freshly-built local array vs. shared/prop state; durable
  attempt-ledger reconciliation vs. error-driven retry; draft-proxy mutation
  vs. plain object).
- A repo-wide baseline re-check (not diff-only) of `.hasOwnProperty(`,
  hand-rolled sleeps, and `JSON.parse(JSON.stringify(` to catch anything the
  diff-only pass could have missed from files not touched in this window.

## 2. What was checked and ruled out

- **`.hasOwnProperty()` direct calls:** zero repo-wide.
- **Hand-rolled sleeps (`new Promise(resolve => setTimeout(...))`):** all 16
  repo-wide hits are in `src/test-kernel/**` test fixtures (timer-flush
  waits), none in production code — same conclusion as prior rounds.
- **`JSON.parse(JSON.stringify(` deep clones:** all repo-wide hits are
  `src/test-kernel/**` test assertions plus the one already-adjudicated
  `src/agent/workflowScript/parseScript.ts:130` `vm.Script` sandbox literal
  (not a clone helper). No production clone helper exists to consolidate.
- **New `.sort()` call sites in the diff (4 total):** `latexModules`'
  `findDisplayMathRanges` — a pure function relocation, not new logic, sorting
  a function-local array; `workflowRunModel.ts:209,217`
  (`workflowCardsInTranscriptOrder`) — sorts two arrays built fresh inside
  the same function from a readonly input, and the same function already
  uses `.at(-1)` for its tie-break, i.e. native-method-idiomatic; a
  `StreamLogSummary` loader's `.sort()` on the output of a fresh
  `.filter()` chain. All four sort a function-local array, the accepted
  carve-out, not the shared/prop-state violation the rule targets.
- **New `Object.assign(` call site (1 total):** a call-recovery merge in the
  workflow runtime that conditionally spreads a subset of fields onto an
  existing mutable `call` object built earlier in the same function —
  matches the already-accepted "mutating a plain owned object, not
  shared/prop state" pattern from 2026-08-29's `Object.assign` audit, not a
  new duplicate pattern.
- **New manual attempt-counter loop in the diff:** the one hit
  (`MAX_DIRTY_WRITE_RETRIES` loop) is the same
  `StreamSnapshotStore.retryDirtyWrites` durability-flush loop the
  2026-08-29/08-30 rounds already traced and ruled a bounded re-persist
  sweep, not `p-retry`-shaped error-driven retry — reappearing in the diff
  only because the surrounding file was reformatted/moved, not because new
  retry logic was added.
- **New hand-rolled `debounce`/`throttle` definitions:** zero.
- **Cross-tree webview duplication:** `git diff --stat` over the three
  parallel frontend trees since `b36051b` shows 105 files changed, but the
  touched files are component-level UI work (onboarding cards, file-select
  styles, LaTeX diff sections) — no new manager, dispatch, or persistence
  logic introduced outside the shared `BaseViewMessageHandler` /
  `BaseWebviewApp` / `createTrackedSignalRegistry` bases the prior rounds
  already confirmed as the consolidation point.

## 3. Verdict

No candidate in either lens clears the bar the six prior full-repo rounds
and the two prior dedicated passes on this exact question set. The volume of
upstream `refactor:`/`simplify:`/`consolidate:` commits landed by other
passes in this three-day window (six PRs explicitly targeting this class of
work) is itself evidence the surface this routine watches is already being
actively worked, not neglected.

This entry exists to record that the routine ran and to save the next pass
from re-treading the same ground; no code changes accompany this cycle.
