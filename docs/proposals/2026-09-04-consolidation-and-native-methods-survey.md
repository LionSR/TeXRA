# Survey: code consolidation and native-method opportunities (2026-09-04)

> **Status:** Written 2026-09-04 against branch HEAD `4579625` (`chore: bump
version to 0.40.9`, #11820). Scheduled routine re-ran the standing
> question — "find duplicate/similar logic to consolidate, and hand-rolled
> code that a native method or the standard library already covers" — one
> day after `2026-09-03-consolidation-and-native-methods-survey.md`.
> **Verdict: nothing new survives scrutiny; all four issues that survey
> filed (#11809–#11812) are already fixed and closed.** No code changes
> accompany this entry.

## 0. What happened since the last pass

Between 2026-09-03's grounding commit (`d418d45`) and this one, 23 commits
landed, most of them itself already the follow-through on the prior survey
and on other simplification work:

- `refactor: resolve post-merge consolidation follow-ups` (#11814) — fixed
  three of the four issues the 2026-09-03 entry filed via its `Fixes #...`
  merge: #11810 (the byte-identical desktop/extension workspace-adapter
  duplication), #11811 (the desktop/extension resume-skeleton dedup), and
  #11812 (`scheduleViewerDisplay`'s hand-rolled sleep). The fourth, #11809
  (`fetchWithTimeout` reimplementing `AbortSignal.timeout`), was resolved
  earlier and separately by #11804 — #11814's own body says so explicitly
  ("#11809 was already resolved by #11804 and has been closed separately")
  — and was closed directly by the repo owner at `2026-09-03T08:50:05Z`,
  about 32 minutes before #11814 merged. Verified directly via the GitHub
  API: all four issues are `state: closed`, `state_reason: completed`;
  #11810/#11811/#11812 list #11814 as their closing PR, #11809 lists none.
- `refactor: land the tail of the recorded audits — 44 verified findings in
nine batches` (#11804) — a single commit (`733b8a4`, 122 files changed,
  +909/-1340) landing much of the backlog prior survey rounds had been
  citing; the 337-file, +2389/-3313 figure in §1 below is the whole
  `d418d45..HEAD` 23-commit window scoped to `src`/`packages/*/src`, not
  this one commit.
- `refactor(session): give the startup stream sweep one owner per host, not
a flag` (#11808), `refactor(desktop): make DesktopAgentExecution.runExecution
private` (#11802), `refactor(storage): delete the taskRuns absolute-path
arm` (#11794), `refactor(progress-view): give stop and sendFollowUp one
home each` (#11793), `refactor(auth): share the OAuth subscription session
base schema` (#11816), `refactor(desktop): share the subscription
auth-change control flow` (#11815) — six more consolidation/dedup refactors
  in the same window, several explicitly targeting the "one owner" shape
  this survey watches for.

Given that volume of upstream consolidation work landing in the 23-commit
window — including the exact four fixes this survey's own prior pass
requested — this pass re-ran the standard native-method tells against
current HEAD and read the diff for newly introduced duplication, rather than
re-deriving the many prior full-repo rounds' conclusions from scratch.

## 1. Method

- Repo-wide `rg` sweeps of `src/` and `packages/*/src/` (production code
  only) for the standing tells: `.hasOwnProperty(`, hand-rolled
  `new Promise((resolve) => setTimeout(...))` sleeps, `JSON.parse(JSON.stringify(`
  and `JSON.stringify(JSON.parse(` round-trips, `.indexOf(...) !== -1`
  patterns, `.filter(...).indexOf(` dedup, `Math.random().toString(36)` ID
  generation, hand-rolled `isEqual`/`deepEqual`, hand-rolled
  `debounce`/`throttle` definitions, `arr[arr.length - 1]` in place of
  `.at(-1)`, and manual promise-chain accumulation (`chain = chain.then(...)`)
  that `p-queue` already covers.
- `git diff d418d45..HEAD` scoped to `-- src packages/*/src`, filtered to
  non-test files (337 files, +2389/-3313 net), for newly added
  `Object.assign(`, attempt-counter `for` loops, and spread-copy-then-iterate
  patterns the tells above could miss.
- Direct read of the three new hand-rolled-sleep-shaped hits the sweep
  surfaced, following the 2026-09-03 entry's finding that its own regex had
  missed real cases by requiring a literal executor-body `setTimeout` call.
- GitHub lookup confirming the disposition of the four issues the prior
  entry filed, rather than assuming from the doc text alone.

## 2. What was checked and ruled out

- **`.hasOwnProperty()` direct calls:** zero repo-wide.
- **Hand-rolled sleeps:** three new hits beyond the already-adjudicated
  `lifecycleHost.ts:70`, all read in full and all the same
  race-against-an-external-event species, not a plain fixed-delay sleep:
  - `packages/desktop/src/main/desktopSupabaseAuth.ts:227-249`
    (`waitForCompletion`): races a device-auth callback's `attempt.settle`
    against a `setTimeout`-driven expiry, `clearTimeout`ing the timer on
    early settlement and running cleanup (`clearAwaitingCallback`) only on
    the timeout branch. An interruptible "first of two, with cleanup on the
    loser" race — not `node:timers/promises`-swappable without losing the
    early-cancel path.
  - `src/tools/lean/direct/leanSession.ts:359-369`
    (`waitForDiagnosticsQuiet`): registers a waiter in
    `state.diagnosticsWaiters` with a self-removing timeout, released early
    by `handlePublishDiagnostics` when new diagnostics arrive
    (`releaseDiagnosticsWaiters`, line 382). Same species — an interruptible
    wait for an external event, not a fixed sleep.
  - `packages/extension/src/progressView/frontend/components/TerminalOutput.ts:305-308`
    (`writeTerminalText`): races `xterm.js`'s `terminal.write(text, resolve)`
    completion callback against a 100ms fallback timeout, with an explicit
    comment ("Whichever lands first wins"). Same species.

  All three fit the pattern the 2026-09-03 entry names for
  `lifecycleHost.ts:70`: "the delay only starts once [an external condition],
  giving [something] one [window] to settle... not a fixed wait from now."
  None is a plain-sleep candidate.

- **`JSON.parse(JSON.stringify(` / `JSON.stringify(JSON.parse(`:** the one
  hit remains the already-adjudicated `src/agent/workflowScript/parseScript.ts:126`
  `vm.Script` sandbox literal (a string template of injected code, not a
  clone helper). No new hits either direction.
- **`.indexOf(...) !== -1` / `.filter(...).indexOf(`:** zero hits repo-wide
  in production code this pass (the assignment-in-condition form the
  2026-09-03 entry found at `src/replacement/advanced.ts:329` is unchanged
  and still not a candidate — it needs the matched position, not membership).
- **Hand-rolled `Math.random().toString(36)` IDs:** zero in production. The
  two `Math.random()` hits found are unrelated: a jitter multiplier in a
  backoff helper (`src/utils/core/index.ts:464`) and a workflow-script
  sandbox guard that _blocks_ script authors from calling `Math.random()`
  for determinism (`src/agent/workflowScript/sandbox.ts:75`) — neither is an
  ID-generation site.
- **Hand-rolled `isEqual`/`deepEqual`/`debounce`/`throttle` definitions:**
  zero new hits; the two previously-accepted exceptions
  (`createFlushableDebounce`, `AnnotationFetchBudget`) are unchanged.
- **`arr[arr.length - 1]` vs `.at(-1)`:** one hit,
  `src/agent/modelHandlers/vscodelm/modelHandlerVscodeLm.ts:106`, but it's an
  _assignment_ target (`content[content.length - 1] = ...`) — `.at()` is
  read-only and cannot replace an assignment LHS. Not a candidate.
- **New `Object.assign(` call sites in the diff:** none.
- **New manual attempt-counter loops in the diff:** none.
- **New spread-copy-then-iterate patterns in the diff:** none.
- **Manual promise-chain accumulation (`chain = chain.then(...)`,
  `p-queue` territory):** the one `.then(` assignment in the diff window,
  `src/platform/defaults/lifecycleHost.ts:59`, is a single settlement-tracking
  callback (`tracked = pending.then(onSettle, onError)`) raced against a
  deadline via `Promise.race`, not a growing hand-rolled queue — bounded to
  one attachment per call, no chain accumulates. Not a candidate.

## 3. Verdict

No candidate in either lens (duplication to consolidate, hand-rolled code a
native method or `p-queue` already covers) clears the bar the many prior
full-repo and targeted rounds set. All four issues the immediately preceding
survey (`2026-09-03-consolidation-and-native-methods-survey.md`) filed —
#11809, #11810, #11811, #11812 — are verified closed: #11810, #11811, and
#11812 fixed by #11814 within hours of filing, and #11809 resolved earlier
and separately by #11804 per #11814's own body. The 23-commit window between
surveys carried substantial
additional consolidation work of the same kind this routine watches for
(#11804's 44-finding sweep, plus six more targeted `refactor:` PRs), which is
itself evidence the surface is being actively worked, not neglected.

This entry exists to record that the routine ran, confirm the prior round's
follow-ups landed, and save the next pass from re-treading the same ground;
no code changes accompany this cycle.
