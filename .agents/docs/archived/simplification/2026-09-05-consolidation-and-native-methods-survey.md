# Survey: code consolidation and native-method opportunities (2026-09-05)

Status: implemented
Archived: 2026-09-06

> **Status:** Written 2026-09-05 against branch HEAD `05b6cd3`
> (`refactor(desktop): read the open-session set from the paper registry in
the resume owner`, #11871). Scheduled routine re-ran the standing
> question — "find duplicate/similar logic to consolidate, and hand-rolled
> code that a native method or the standard library already covers" — two
> days after `2026-09-03-consolidation-and-native-methods-survey.md`.
> **Verdict: no new candidate clears this survey's bar.** The classic
> native-method tells are clean repo-wide, and the one area with real,
> ongoing consolidation opportunity (the desktop paper-scoping work from
> PRD lane 6, #11827) is already tracked, scoped, and being worked through
> a dedicated ledger issue, #11865 ("Lane 7: ledger collapses"), with two
> items still open (#11847, #11848) that this pass would otherwise have
> re-derived. No code changes and no new issues accompany this entry.

## 0. Window covered

`646475d..d418d45` was the prior pass's window. Between `d418d45` (2026-09-03,
the prior entry's grounding commit) and `05b6cd3` (today), 48 commits landed,
34 touching `src/` or `packages/*/src/` (591 files changed, +15,786/-9,302
lines across the full diff including tests and desktop's new
paper-scoping feature). The bulk of that volume is one large, tracked
feature landing across several PRs — "session-scoped workspace roots and one
session per paper on the desktop" (#11827, PRD lane 6) — plus its immediate
follow-up consolidation work (#11845, #11846, #11849, #11858, #11859,
#11870, #11871), a startup-repair deletion (#11837), and unrelated fixes
(model catalog additions, a sox-process await fix, a Vite ESM migration).

## 1. Method

Same as the 2026-09-02 and 2026-09-03 entries:

- Repo-wide `rg` sweeps of `src/` and `packages/*/src/` (production code
  only, `test-kernel` and `.vitest.ts` excluded) for the standing tells:
  `.hasOwnProperty(`, hand-rolled `setTimeout`-based sleeps (`new
Promise(resolve => setTimeout(...))` in any of its executor shapes —
  bare, wrapped, or nested), `JSON.parse(JSON.stringify(` deep clones,
  `.indexOf(...) !== -1` in place of `.includes(`, `.filter` + `.indexOf`
  dedup, hand-rolled `Math.random().toString(36)` IDs, hand-rolled
  `isEqual`/`deepEqual`, hand-rolled attempt-counter `for` loops, hand-rolled
  `debounce`/`throttle` definitions, and new `Object.assign(` call sites.
- `git log`/`git diff --stat` over the 34-commit `src`/`packages/*/src`
  window to isolate which tell hits are newly introduced versus
  pre-existing and already adjudicated by a prior round.
- Checked open `label:tech-debt` issues (`gh`-equivalent via the GitHub MCP
  tools) before writing anything, specifically #11865 ("Lane 7: ledger
  collapses") and its children, since the window's dominant diff is the
  lane-6 desktop feature that ledger issue was opened against.

## 2. What was checked and ruled out

- **Hand-rolled sleeps (`new Promise((resolve) => ... setTimeout ...)`, all
  shapes):** three hits repo-wide, all pre-existing (none touched in this
  window per `git log d418d45..HEAD -- <file>`), none newly introduced:
  `packages/desktop/src/main/desktopSupabaseAuth.ts:227-249`'s
  `waitForCompletion` races a callback-driven `attempt.settle` against a
  timeout, clearing the timeout on whichever settles first — not a plain
  sleep, a settle-or-timeout race with its own cleanup. `src/tools/lean/direct/leanSession.ts:359-369`'s
  `waitForDiagnosticsQuiet` waits on a registered waiter entry (pushed onto
  `state.diagnosticsWaiters`) that a diagnostics-publish handler can resolve
  early, with the `setTimeout` firing only as the fallback and cleaning up
  its own waiter-list entry; last touched by `8d16c08` in this window as
  part of an unrelated simplification sweep, but the wait-with-early-resolve
  shape itself did not change. `packages/extension/src/progressView/frontend/components/TerminalOutput.ts:305-308`'s
  `writeTerminalText` races `terminal.write(text, resolve)`'s completion
  callback against a 100ms fallback timeout with an explicit comment
  ("Whichever lands first wins; a promise ignores every later resolve").
  All three are event-or-timeout races, not the plain "wait N ms" pattern
  `node:timers/promises`' `setTimeout` replaces — same conclusion as
  `src/platform/defaults/lifecycleHost.ts:70-72`, already adjudicated by the
  2026-09-03 entry. Not candidates.
- **`.hasOwnProperty()` direct calls:** zero repo-wide, same as every prior
  round.
- **`JSON.parse(JSON.stringify(` deep clones:** the one hit,
  `src/agent/workflowScript/parseScript.ts:126`, remains the
  already-adjudicated `vm.Script` sandbox literal (its `JSON.parse(...)`
  runs _inside_ a `vm.Script` source string, not as a runtime clone
  helper). No new hits.
- **`.indexOf(...) !== -1` (including assignment-in-condition form) and
  `.filter` + `.indexOf` dedup:** zero repo-wide. The one instance the
  2026-09-03 entry found and correctly ruled out
  (`src/replacement/advanced.ts:329`, a positional scan that needs the
  matched index, not membership) is unchanged.
- **Hand-rolled `Math.random().toString(36)` IDs:** zero in production
  (unchanged from prior rounds; the two test-kernel hits are unrelated to
  this survey's production-code scope).
- **Hand-rolled `isEqual`/`deepEqual`:** zero.
- **Hand-rolled attempt-counter `for` loops:** the same three
  previously-adjudicated instances (`SidecarWriteCoordinator.retryDirtyWrites`'s
  `MAX_DIRTY_WRITE_RETRIES`, `StreamSnapshotStore.requestEviction`'s
  `MAX_EVICTION_DRAIN_ATTEMPTS`, `inBandSubagentExecution.ts:624`'s
  durable-attempt-sequence scan) — all bounded reconciliation loops over
  already-persisted state, not `p-retry`-shaped error-driven retry. None
  changed shape in this window. No new instances.
- **Hand-rolled `debounce`/`throttle`:** the same two previously-adjudicated,
  doc-commented exceptions (`createFlushableDebounce`,
  `AnnotationFetchBudget`). Neither changed in this window. No new hits.
- **New `Object.assign(` call sites:** none of the 34 touched production
  files in this window added one. The nine repo-wide hits are unchanged
  from the prior round's already-accepted "mutating an owned,
  function-local object" pattern (spot-checked
  `src/agent/workflowScript/workflowExecutionState.ts:231,258`, neither
  touched this window: both mutate a `call` object this method already
  owns and is about to return/store, not build a new merged object a
  spread would replace more idiomatically).
- **The dominant window diff — desktop paper-scoping (#11827, PRD lane 6)
  and its follow-ups:** this is exactly the area a fresh consolidation
  survey would otherwise target (a large feature landing across many files,
  the classic source of copy-pasted wiring). It is already covered: a
  2026-09-04 post-lane-6 simplification pass filed five issues against it
  (#11844, #11845, #11846, #11849, #11850), four of which are already
  merged (via #11858, #11859, #11870, and — as of today's `05b6cd3` — the
  open-session-set duplication #11844 described), and the remaining two
  (#11847, the `computeModelOptionsData` 5s LRU double-cache; #11848, the
  per-stream pre-stage reconcile fold, sequenced behind the substrate
  cutover #11867) are open, assigned, and already scoped with `path:line`
  evidence and estimated LoC deltas in more depth than a repeat pass could
  usefully add. Re-deriving or re-filing either here would duplicate
  tracked work, not add to it. The umbrella ledger issue, #11865, is the
  correct place for any further finds against this lane, not a fresh
  standalone survey entry.

## 3. Verdict

Nothing in the `d418d45..05b6cd3` window clears this survey's bar. The
classic native-method tells are unchanged or clean repo-wide, and the one
area of real ongoing consolidation opportunity — the desktop paper-scoping
feature — already has an active, well-scoped tracking issue (#11865) two
days ahead of what a fresh sweep would find, with three of five originally
filed items already merged and the remaining two correctly sequenced
against a dependency (#11867) rather than sitting idle. Filing a duplicate
issue against either open item, or re-surveying files #11865's own passes
already read in more depth, would not move the codebase forward.

This entry exists to record that the routine ran and to save the next pass
from re-treading this exact ground; no code changes and no new issues
accompany this cycle. The next pass should re-check #11865's open items
(#11847, #11848) for status before re-surveying the same desktop feature
area, and should widen scope to a different part of the tree if that ledger
is still the most current record of outstanding work there.
