# Design red-flag audit, round 5 (read-only): the test suites themselves

Round 3's R report (`../2026-11-07-design-red-flags-round-3/R-test-infrastructure.md`)
audited the test infrastructure, and its fixes landed in #14823 and #14826 (fakes are production layers
over a scripted edge; the fake host is a service). This round audits the
suites: what they pin, what they protect, what they cost. Start from `main`
at `c9ceb23` and state that commit at the top of your report.

The red-flag species and the per-finding format are round 2's
(`../2026-11-06-design-red-flags-round-2/BRIEF.md`, "The red flags" and
"Output format"), read through the testing rules in `AGENTS.md` "Testing
discipline" and `src/test-kernel/AGENTS.md`. Read both before you start.
Three additions:

- A finding already in an earlier round's report, in
  `.agents/docs/refuted-candidates.json`, or in an `.agents/docs/proposed/`
  note is FOUND: do not repeat it. Cite it where it borders yours.
- The fix may be "delete". A test that protects nothing is a cost: say what
  it would catch (nothing, a typo, a mock echo), and what still protects the
  behaviour if it goes.
- Each finding names its file(s) and the churn rank below where it has one.
  Suites touched by an open PR (B's rename PR, E's R3-E2, A's TUI lifecycle
  PR) are reported with that PR's owner, so the fix can be sequenced.

## Numbers measured at `c9ceb23` (by the orchestrator)

- 267 test files, about 33.8k LoC, plus `src/test-kernel/support` (31 files, about 5k LoC), against about
  250k of source. 21 files use `vi.mock`, 22 use timers or sleeps, 23 casts
  are `as any` / `as unknown as`, and 5 are `.skip` / `.todo`.
- Churn: of the 106 `simplify` / `refactor` commits on main since 11-01,
  these touched:
  - `sessionEvents.vitest.ts` (1,560 lines), `RetryState.vitest.ts` and
    `scriptedRunLayers.ts`: 13 each;
  - `goldenStore.vitest.ts` and `ToolUseDispatchParallel.vitest.ts`: 11
    each;
  - `sessionTestUtils.ts` and `ExecuteCli.vitest.ts`: 10 each;
  - `chatSessionController.vitest.ts`, `TuiApprovalRetry.vitest.ts`,
    `storeFaults.ts` and `nativeToolTestLayer.ts`: 9 each.

  A suite every refactor edits is pinned to an internal interface:
  `AGENTS.md` calls that merge friction. Recompute churn for your files with
  `git log --since=2026-11-01 --format=%s --name-only origin/main -- <path>`
  if you need more than the list.

## Scope

Every suite: `src/test-kernel/**`, `packages/*/test/**`, `packages/llm`'s
live suites, `packages/desktop/tests/e2e/**` (Playwright), and
`supabase/functions/**/*_test.ts`. The support modules are in scope only as
far as a suite's local copy duplicates them (R3-R just rewrote them).

## Lenses (one report each)

| Lens | Report                     | What to find                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `1-pinned-to-internals.md` | Suites that import deep modules or assert intermediate shapes instead of outcomes at a stable boundary: the session's view and rows, a host verb, a tool's result, the CLI's output. Rank them by the churn above. For each, name the stable boundary and what a replacement asserts there.                                       |
| 2    | `2-code-for-tests.md`      | Production code that exists for tests: exports with only test consumers, options or knobs only tests pass, env switches, `Context.Reference`s only tests set, and "for tests" comments. Grep production for each export's consumers. The fix is in production, together with its tests.                                           |
| 3    | `3-cannot-fail.md`         | Tests that cannot fail, or that test the fake: tautologies, expected values computed by the same code, assertions on a mock's calls rather than an outcome, schema defaults re-asserted, and "renders without crashing". Name, for each, the bug it would or would not catch.                                                     |
| 4    | `4-nondeterminism.md`      | Sleeps, polls, real timers, retry-until loops, order dependence and shared module state. Name the signal each should wait on instead: `TestClock`, a latch or deferred, or an event the code already publishes. List each with `file:line`.                                                                                       |
| 5    | `5-scaffolding.md`         | Giant suites and their local helpers that duplicate `support/`, single-consumer helpers, option-bag fixture builders, `as any` / `as unknown as` reaching past a type, and fixture rule-of-three violations. Report the five largest suites with their helper share.                                                              |
| 6    | `6-budget-and-tiers.md`    | The same behaviour tested at several tiers, e2e specs that duplicate kernel suites, tests of behaviour 1.0 deleted (legacy readers, compat, migrations), `.skip` / `.todo`, and slow suites: measure with one `npx vitest run --config vitest.config.mjs --reporter=json --outputFile=<scratch>` and rank the top 15 by duration. |

Every lens covers all suites, `packages/llm`, the desktop e2e specs and
`supabase/functions` included.

## Rules

- Read-only: write only your report file. No code edits, no git commands
  that change anything. Lens 6 runs the suite once to measure; no other lens
  runs the full suite (the machine is shared), though running one suite to
  check a claim is fine.
- Evidence is `file:line` plus a quoted line or two. A claim you could not
  check is marked "unverified".
- Aim for the 5 to 12 strongest findings; batch or drop thin ones. End with
  "Good suites worth copying" and "Already settled, left alone" (the
  citations that justify leaving something).
- Return a summary of at most 20 lines: each finding's title, its flag, the
  fix (including "delete"), and its size (files, lines).
