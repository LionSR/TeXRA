# Survey: code consolidation and native-method opportunities (2026-08-29)

> **Status:** Written 2026-08-29 against branch HEAD `e7f535c` (`chore: bump
version to 0.40.7`, #11556). Scheduled routine re-ran the standing question —
> "find duplicate/similar logic to consolidate, and hand-rolled code that a
> native method or the standard library already covers" — as its own pass
> rather than a diff of prior rounds. **Verdict: nothing new survives
> scrutiny.** No code changes accompany this entry.

## 0. Why this pass is short

This is not a fresh area of the codebase. In the five days before this pass,
the repo went through six back-to-back simplification survey rounds:
`2026-08-25-simplification-survey-49-candidates.md`,
`2026-08-26-simplification-survey-round{2,3,4-production,4-tests}.md`,
`2026-08-27-simplification-survey-round5-deep-read.md` (36 agents, every one
of the 295,148 lines of production TypeScript read completely), and two
follow-on targeted sweeps on 2026-08-28
(`simplification-survey-cli.md`, `simplification-survey-multi-agent-dispatch.md`).
Round 5 explicitly named "hand-rolled code reimplementing a Node builtin" and
"consolidate" as finding categories and swept `packages/desktop`,
`packages/trace-viewer`, `supabase/functions`, and `scripts/` alongside
`src/`. No production code changed between that round's grounding commit and
this one (`git log --since` over `src/` and `packages/*/src/` since
2026-08-28 18:00 returns only doc/chore/dependency-bump commits).

Given that, this pass narrowed to exactly the two lenses the routine asks
about and checked them for real, rather than re-running a broad structural
survey that would only re-find what six prior rounds already found (and
mostly already fixed).

## 1. Method

- Direct `rg` sweeps across `src/` and `packages/*/src/` (production code
  only) for the classic tells: `JSON.parse(JSON.stringify(` (deep clone),
  `new Promise(resolve => setTimeout(...))` (hand-rolled sleep), mutating
  `.sort(` outside `.toSorted()`, `.hasOwnProperty(`, `arr[arr.length - 1]`
  (vs `.at(-1)`), `Object.assign(`, hand-rolled `debounce`/`throttle`,
  `filter(...).indexOf(...) === index` dedup loops, hand-rolled
  `deepEqual`/`isEqual`, and manual attempt-counter retry loops.
- Two read-only survey agents for the two areas least likely to have been the
  _primary_ focus of round 5's per-slice partitioning: (a) cross-tree
  duplication among the three parallel webview state/manager trees
  (`webview/frontend`, `progressView/frontend`, `settingsView/frontend`) —
  called out in the find-simplification skill as a recurring source — and (b)
  `scripts/`, `packages/desktop/src/`, `packages/trace-viewer/`,
  `supabase/functions/` for both lenses.
- Every candidate either agent surfaced was required to carry a `file:line`
  and a grepped, not guessed, consumer/duplicate count, confirmed present at
  current HEAD.

## 2. What was checked and ruled out

**Native-method opportunities (repo-wide production code):**

- `.hasOwnProperty()` direct calls: zero.
- Hand-rolled `sleep`/`setTimeout(resolve, …)` promise delays: zero.
- Hand-rolled debounce/throttle implementations: zero.
- `filter + indexOf` dedup loops (vs `Set`): zero.
- Hand-rolled `deepEqual`/`isEqual`: zero (the only `JSON.parse(JSON.stringify(`
  hit is `src/agent/workflowScript/parseScript.ts:139`, inside a `vm.Script`
  sandbox literal, not a clone helper).
- `arr[arr.length - 1]` vs `.at(-1)`: one hit, not a real duplicate pattern.
- `Object.assign(` sites (9 total): checked each — two in webview code write
  onto `mutative`/immer-style draft proxies (`streamStateMerge.ts:57`,
  `permissionSlice.ts:117`), where object-spread doesn't apply; the rest are
  single-purpose merges with no duplicate pattern across call sites.
- Mutating `.sort()` outside `.toSorted()` (22 repo-wide hits, spot-checked
  including all three in `progressView/frontend/components/messageIndex.ts`
  and `packages/desktop/src/main/desktopCrashEventScrubber.ts:37`): every
  checked instance sorts a freshly-built local array, not shared/prop state —
  the accepted carve-out, not a violation.
- Hand-rolled retry-with-backoff vs `p-retry`: the two attempt-counter loops
  found (`src/transcript/StreamSnapshotStore.ts:1657`,
  `src/tools/delegation/inBandSubagentExecution.ts:628`) are durable
  attempt-ledger reconciliation over persisted execution leases, not
  error-driven retry — not a `p-retry` shape. `supabase/functions/auth-device/index.ts:156`
  is a DB unique-constraint-collision regenerate loop with no backoff — also
  not a `p-retry` shape.
- Hand-rolled promise-chain queuing vs `p-queue` (already a root dependency,
  and the repo's own canonical swap target per AGENTS.md): `p-queue` is
  already imported and used where the pattern would apply
  (`packages/desktop/src/main/index.ts`, `desktopSupabaseAuth.ts`); no
  unmanaged sequential-await chain found elsewhere in scope.

**Duplicate/similar logic:**

- Cross-tree duplication among `webview/frontend`, `progressView/frontend`,
  `settingsView/frontend`: badge/status-icon helpers already route through
  `@shared/wa/statusIcons`; small utilities (`formatBytes`, `pluralize`,
  `clamp*`) already import from `@utils/core` / `@utils/text/stringUtils`
  everywhere; all three message handlers already extend the shared
  `BaseViewMessageHandler` / `HandlerRegistry` dispatch pattern. The ✓/✗
  glyph duplication this lens would have flagged was already consolidated in
  `e01925a` (2026-08-28) — confirmed gone, not re-flagged.
- `scripts/` file-walk helpers: `scripts/walkFiles.mjs` is already the
  canonical shared helper, imported by 5 other scripts; the three remaining
  `readdir`/`readdirSync` sites each have materially different traversal
  semantics (sync vs. async, top-level-only vs. full-recursive vs.
  BFS-with-pruning) and are not near-identical duplicates.
- `supabase/functions/*`: all functions already share `_shared/cors.ts` and
  `_shared/responses.ts`; no repeated CORS/JSON-response or zod-validation
  boilerplate found.

## 3. Verdict

No new candidate in either lens clears the bar this repo's prior rounds set.
The eight open `label:tech-debt` issues at HEAD (#11512, #11449, #11014,
#10921, #10920, #10753, #10300, #10140) are all pre-existing and outside this
survey's two lenses (relay/legacy retirement, docs deployment, rulings
requests) — none overlaps or needs updating from this pass.

This entry exists to record that the routine ran and to save the next pass
from re-treading the same ground; no PR beyond this doc is warranted this
cycle.
