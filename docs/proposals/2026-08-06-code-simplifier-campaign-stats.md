# Code-simplifier campaign: full-history stats and rulings

Date: 2026-08-06. Evidence base for `.claude/agents/our-code-simplifier.md`.
Compiled from six archival passes over all PRs, issues, git history, and
deleted workflow scripts. Scope: the TypeScript repo, 2025-05 → 2026-08-06
(the pre-port Python era, 2024-05 → 2025-02, is excluded as a different
codebase; its only durable lesson — delete wholesale when there are no
downstream consumers — appears in the meta-lessons).

## Headline numbers

- **~200 merged** simplification-family PRs; **~25 closed-not-merged**.
- Simplify-titled merged (since 2026-05): 64 net-negative / 36 net-positive,
  total **−18,675 LOC**, median −22. Tech-debt label overall: **−30,161**.
- The 10 big sweeps = **−14,844** (~80% of all deletion); the ~90-PR long
  tail only ~−3,800.
- Diminishing returns per escalating scope: file-level **−11,212** (#9472) →
  module-level **−1,843** (#9473) → subsystem-level **−495** (#9477), each
  seeded by the previous round's harvested cross-batch leads.
- Sweep waves leave "sediment": ~−2.1k of dedicated follow-up (#9586, #9591,
  #9486) — budget it as campaign overhead.
- **Zero post-merge reverts of any simplification in repo history.** The one
  true reversal: #8091 restored a "dead" fallback that resume compat still
  needed. All other known regressions (6 in #9472 alone) were caught
  **pre-merge by the adversarial-review layer** — that layer is load-bearing.

## Success areas, ranked by verified yield × merge rate

1. **Dead code / dead exports / write-only fields** — tsc-provable, ~100%
   merge rate (#7954, #5740).
2. **Single-caller pass-through inlines** — ~85 merged across 15 months,
   ~90% merge rate, zero reverts. Signature hazard: mock-path references
   (grep misses string refs; #3996's one follow-up fix was a stale
   `vi.mock` path).
3. **Ad-hoc → maintained library** — ~25 PRs, zero rejections (#9236
   −3,889 PocketFlow cookbook, #6217 simple-git, #5830 p-retry). Respect the
   reinvented-wheel audit's do-not-reflag list (formatSize compact etc.).
4. **Dual-system elimination** — biggest single-PR wins (#8655 −3,022,
   #4035 −1,711, #4088 −1,159) but **highest collision rate**: #8686
   (−1,364 would-be) died purely because #8655 landed the same convergence
   in parallel. One named owner per convergence + in-flight-PR check.
5. **SSOT / single-owner** — best correctness-per-line; fixes race classes
   (#8252's 2.33M-token explosion, #9507, #9031). Net-positive accepted when
   ownership is the point. ~zero pattern rejections.
6. **Excessive-fallback removal** — delete impossible, make ambiguous LOUD
   (#9639 −319, #9592, #7316 −336, #9215). One restore (#8091) — prove
   resume/persist compat first.
7. **Deep-module consolidation** (one authority per concept, element-counted)
   — #9705 −1,806, #9522 −466, #9339/#9655/#9155 element-negative.
   Elements > LOC codified by #7452 and PR-template R6/R8 (#7814).
8. **Test-suite dedup** — biggest ratios outside mega-sweeps (#6832 −1,886,
   #6845 −841).
9. **Type-tightening** — net-positive accepted when runtime failures become
   compile failures (#7159 +766, #7271 +726). Loosening rejected 2/2 (#310).
10. **Zod at real boundaries** — 4 waves merged; rejected only when the
    schema owns no parse boundary (#9683). Small batches only — the one
    regression wave (#3784) was big-batch async-semantics breakage.
11. **Resolver consolidation** — pays as resolve-once-and-carry (#7586,
    #9657); re-churns when ownership is unfixed (CLI agent resolution
    "centralized" 6× in June 2026).
12. **In-host adapter collapse** — safe inside a host (#8841, #7454);
    NEVER across the Platform-port seam (#4203 added ports on purpose;
    #8456 KEEP adjudication).
13. **"Changed since last release" seam** — renewable forever; ~12 PRs,
    each −40…−337, zero red merges (#5949…#9399). When finders report
    moreAvailable=false, pivot to dirs prior sweeps EXCLUDED (freed by
    since-merged PRs) — higher yield than re-scanning (#7581).

## Failure taxonomy (all ~25 closures, by cause)

1. **Net-positive machinery without a boundary** — #9683 (+469): schemas not
   used as parse boundaries, generics "for future use". Owner: "green checks
   do not resolve the scope and maintenance-cost problem."
2. **Over-broad aggregation** — unrelated refactors in one PR "cannot be
   reviewed or reverted as one coherent behavioral unit" (#9683, #9621).
3. **Premature compat/boundary deletion** — 5 PRs closed Aug 2026 for
   ignoring retirement-ledger dates (#9684, #9622, #9621, #9632, #9620).
   Unmanaged user-workspace artifacts are NEVER age-deleted.
4. **Duplicate/superseded under concurrency** — the #1 non-quality failure:
   #8686/#8655, #8782/#8781, #8442/#8441, #9669/#9672, #4057, #9540, #5952.
5. **Stale finding** — true at audit time, shipped by someone else before
   the PR lands (#6345 re-added already-deleted re-exports).
6. **Type-loosening** — #310 (`Record<string, any>`), rejected 2/2.
7. **Architecture-rewrite-as-collapse** — #2608: a flatten that needed a
   staged migration, closed; later done properly in stages.
8. **Shape-equal ≠ behavior-equal** — #9669: "duplicate" helpers had
   intentional behavioral deltas; caught in review.

## Indirection-species taxonomy (collapse verdicts, adjudicated)

| Species                                   | Verdict                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Single-caller pass-through                | COLLAPSE (~90% merge, zero reverts)                                                |
| In-host event adapter / switchboard       | COLLAPSE (#8853 −446, #8841)                                                       |
| Carrier chain / dead plumbing             | DELETE (#5721, #9303, #7114)                                                       |
| Context bag / DI depth                    | DELETE via resolve-once-at-boundary; never add depth                               |
| Vestigial projection (dual-writer bridge) | DELETE once real channel lands — deferral = #1 cost site                           |
| Pure/orphan re-export barrel              | DELETE (check retirement plans first — #7174)                                      |
| Duplicate registry                        | COLLAPSE the dup (#9212)                                                           |
| Registry/dispatcher as contract           | KEEP, type exhaustively (#7159)                                                    |
| Facade owning a public surface            | KEEP (#7500)                                                                       |
| Platform port / host bridge               | NEVER collapse (#4203, #8456)                                                      |
| Vocabulary alias                          | CANON per surface (#9816) or ISOLATE per host (#7622); global unification debunked |
| Legacy compat arm                         | DELETE only at retirement-ledger date (#6981)                                      |

**Do-NOT-do ledger (adjudicated, issues #8758/#8974 + R-rounds):**
ApprovalRequestHandler settle table (NET_LOSS); PreToolUse/PostToolUse hook
engine (NET_LOSS +300–600); global progress-vocabulary unification
(debunked 2×); Google GenAI handler deletion (freeze-over-delete, #7097);
full D3 dual-writer retirement (ledger-gated); maxRules deletion
(maintainer-vetoed KEEP); terminal-renderer dual (KEEP); alias
extends-collapse + root-typecheck-include (NET_LOSS); CLI scanner fold
(WASH); deno.json flatten (BLOCKED); settings one-composition-path
(maintainer-sanction-gated).

## Machinery evolution

| When          | What                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-10    | `simplify-since-0385{,-pass2,-types}.mjs` + 3 detectors checked in — disjoint batches, direct-edit workers, `edited/skipped/risk/crossFile` schema, zero-edits-valid, no-gates-in-workers          |
| 2026-07-08/09 | Ad-hoc sweeps #7540/#7581/#7628 (−146 total) — diminishing-returns + pivot-to-excluded-dirs lessons                                                                                                |
| 2026-07-18    | `debt-audit.js` — generalized READ-ONLY engine: scout self-decomposition, element-count philosophy, 4 architect lenses, adversarial verify gate (REAL_NET_GAIN/WASH/NET_LOSS/ALREADY_DONE/BLOCKED) |
| 2026-07-19    | #8944 deletes the finished simplify scripts                                                                                                                                                        |
| 2026-07-20    | #8975 adds `tech-debt-tournament.mjs` + skill; ledger #8974; 3 refuters/candidate; NET_LOSS verdicts written back to do-not-do list                                                                |
| 2026-07-24    | #9114 deletes the 3 detector scripts (OSS streamlining)                                                                                                                                            |
| 2026-07-30/31 | Big three (#9472/#9473/#9477) — ad-hoc escalating-scope runs, per-area adversarial review pre-merge                                                                                                |
| 2026-08-06    | #9817 (parallel 3-reviewer pass); repo-local `our-code-simplifier` agent created from this doc                                                                                                     |

**Rotation history**: #8787 debt-audit rotation R1–R7 (~49 verified
findings, ~−10k LOC, 100% closed) — superseded 2026-08-03 by the #8974
tournament (3-area rotation, 10 areas). Tournament has filed 0 issues in 2
cycles: one honest-quiet cycle (all candidates CONTESTED on incomplete
deletion enumeration), one lost to a Workflow-args-drop bug (~1M subagent
tokens wasted; root-cause before further cycles). Never-rotated areas:
platform-infra, storage-transcript, controllers-shared, extension-host,
webviews, cli, desktop.

## try/catch & error-handling census

Baseline: the #7462 audit (2026-07-07) read all **880 catch sites — ~87%
legitimate**; masking concentrates in four diseases (silent Zod
`.catch(default)` on persisted data, per-call-site re-derivation of
undecided best-effort policy, defaulted reads feeding destructive
whole-file rewrites, re-derive resolvers violating decide-once). Bare
`catch {}` is now nearly extinct (2 files repo-wide).

**The catch budget (implemented 2026-08-01): seven planes may catch** —
host entry boundaries; provider-SDK boundary (classify once); tool
boundary; run-lifecycle terminal boundary; listener fan-out isolation;
resource cleanup (`finally`); ENOENT-predicate reads. Everything else
returns result types or crashes up to a plane. Cleaner-solutions menu:
parse-at-entry · decide-once-carry-as-data · result types with one throw
boundary · define-errors-out-of-existence · loud read · single classifier ·
delete-the-guard.

Merged routinely (#5832, #5976, #2088, #2353, #6886; zero regressions, zero
reverts). The one rejection pattern: **blanket defensive-check removal**
(#1376 closed) vs **type-provable removal** (#2088 merged, same idea two
months later). Verdict: high-scrutiny, moderate-yield — surgical (the four
diseases), never sweeping; the edit is an ownership transfer into a plane,
not a deletion.

## Meta-lessons (cross-category)

1. **Adversarial pre-merge review is the load-bearing layer** — every known
   regression was caught there; nothing reached a revert.
2. **Scaffolding lifecycle > scaffolding cost** — build-implies-delete in
   the same PR; the two big accumulated-cost sites were both
   deletion-deferred, not build-wrong.
3. **Concurrency waste is the #1 non-quality failure** — check in-flight
   PRs; one named owner per convergence.
4. **Findings go stale in hours** — re-verify against HEAD right before
   editing; this repo merges dozens of PRs a day.
5. **Fix ownership or it re-churns** — a resolver simplified without an
   ownership fix gets re-simplified in waves.
6. **No downstream consumers** — internal interfaces can break; compat is
   owed only to persisted data, wire contracts, user workspaces, and
   external export formats. Intermediate-era local data compat readers are
   deleted early (loud), not age-gated (#9590 ruling).
7. **Minimal universal patterns beat bespoke machinery** — 25/25 library
   replacements merged; custom frameworks need justification.
8. **Root cause, never band-aid** — fix the data model/owner, not the
   symptom: no render-time compensations for upstream data problems
   (CLAUDE.md UI anti-patterns), no special-case branches a corrected model
   removes, workarounds deleted when their cause dies (#5800, #4625). Clean
   design, clean dataset: one canonical shape, normalized at the boundary.
