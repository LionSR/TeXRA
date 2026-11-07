# Round 5 (test suites): ranked findings and the fix plan

Audited at `c9ceb23`. Reports: `1-pinned-to-internals.md` through
`6-budget-and-tiers.md` in this directory. A finding is cited `L<lens>
F<n>`. The ranking weighs what a finding costs today (vacuous protection
first, then churn, then flake risk and tier cost) against the size of the
fix.

## Ranked

1. **Two setup-tool suites protect nothing since #14826** (L3 F1).
   `InvokeCommandTool` and `SendToTerminalTool` build their host with
   `Layer.build(FakeHost.layer(...))` and drop the context, so the tool reads
   the block's host. Every assertion passes with the allowlist or the newline
   filter deleted (probe-checked). It is an R6 regression.
2. **The run-loop suites enter the loop mid-way, on local copies of the
   scripted model** (L1 F1.1, L5 F4, L4 F1 and F6, L3 F4). `RetryState`
   (churn 13) and `ToolUseDispatchParallel` (11) write the invoker's rows by
   hand and keep two `BoundModel` literals and four `ORIGIN`s. They pump the
   clock in a loop, use real 5–20 ms sleeps and a 5 s barrier, and their
   "configured limit" case expects the setting's own default.
3. **The headless CLI and chat TUI suites run over mocked launches and
   sessions** (L1 F1.2 and F1.3, L3 F3, L5 F6, L2 F3). There are 13 mocked CLI
   modules, 62 `vi.fn` and 23 `vi.mock`, mock copies of production branches,
   and test-only injection options in the CLI. Churn 9–10 each. Owner: A's
   TUI lifecycle PR.
4. **`run.start` rows and one tool-use turn are hand-written in 13 suites
   and 3 helpers** (L1 F1.4, L5 F2). One rename (#14788) edited 18–20 test
   files. Fix: a row builder in support. It follows E's #14829.
5. **The desktop e2e environment switches put 9 of 11 specs on the app's
   fallback path** (L2 F2). The custom data root makes the service refuse,
   so tasks run in-app. The headless constant is read 16 times. Next to it,
   each launch has hand-written teardown (L5 F7: 25 launches, 21
   `try`/`finally`, 55 `!` outside the lint zone), and specs read Lit
   properties (L1 F1.7).
6. **Forked work nobody joins, and per-case state in module variables**
   (L4 F4 and F5). `runFork` is used at 8 sites. `ToolEditApprovalGate`
   resets 8 module bindings by hand, and three suites keep run-id counters.
7. **`ToolUseFollowUp` runs over a hand-written session log** (L1 F1.5, L5
   F5). It has five `as unknown as`, two spies and a namespace spy on
   `resumeRun`.
8. **`BashTool`, `ExecutionsToolOutput` and `grep` stub `executeCommand`**
   instead of the spawner (L1 F1.6). The stub hides `executeCommand`'s own
   bugs.
9. **Tier cost and placement** (L6 F1, F2 and F3). 18 suites are
   `isolated` only for a repository `vi.mock`. `DOM_DIRS` isolates 11 suites
   by directory, and its `settings` entry names no suite. Behaviour checks
   sit in Playwright projects no CI job runs.
10. **Smaller items, batched.**
    - Weak or vacuous assertions (L3 F2, F5, F7, F8).
    - Three copies of "every pinned model is live" (L6 F4).
    - Lean's always-`'lake'` parameter (L2 F4) and five ways of waiting on
      a process (L4 F8).
    - Edge functions that serve on import (L5 F8).
    - The shuffle check nothing runs (L4 F9).
    - Comments that promise tests (L2 F5).
    - `test:pure` documented at 30 s, measured at 4.5 s (L6 F7).

Not findings: no test covers behaviour 1.0 deleted, there is no `.skip` or
`.todo`, and the crash tier's 63% of test time is justified (L6).

## Fix plan: two PRs with no file in common

**PR 1, the run-loop and tool suites onto production paths** (D):

- the R6 regression in `InvokeCommandTool` and `SendToTerminalTool`
  (ranked 1);
- `RetryState` and `ToolUseDispatchParallel` (ranked 2);
- `ToolUseFollowUp` (ranked 7);
- `BashTool`, `ExecutionsToolOutput` and `grep` on the scripted spawner,
  and `BashTool`'s unjoined fork (ranked 8, part of 6);
- `ToolEditApprovalGate`'s module state and weak assertion, `ConfigTools`'
  weak assertion, and `helperModelPreference`'s wrong-branch case (ranked
  6 and 10).

It touches `src/test-kernel/{agent,tools}/**`,
`packages/harness/test/{agent,tools}/**` and
`src/test-kernel/support/childProcessTestLayer.ts`.

Status of PR 1: ranked 1, 2 and 7 landed; ranked 6 and 10's parts landed
(`ToolEditApprovalGate`, `ConfigTools`, `helperModelPreference`, and
`BashTool`'s fork, now a yielded `closeInput`). Ranked 8 landed for `grep`
and `BashTool`'s foreground case. Left: `BashTool`'s two background cases
and `ExecutionsToolOutput` keep their `executeCommand` stubs, because a
background run forks on the session's context, whose spawner
`ownerProcessLayer` builds itself (`nodePlatformServices`), so no layer a
suite provides reaches it. Moving them needs the session graph to take a
spawner, which belongs with L2 F1's `processLayer` options. Two waits are
left: `ToolUseDispatchParallel`'s barrier case holds its first read for at
most 200 ms of live time, because no row marks a write that is waiting and
the call's prelude does real I/O; and `ToolUseFollowUp`'s ordering case does
not fail with the send lane removed (neither did the old one). `toolCallTurn`
in `src/test-kernel/support/scriptedRunLayers.ts` now takes a call's input.

**PR 2, tiers, the desktop e2e specs, edge functions and test-only knobs**
(G):

- the desktop e2e switches, a Playwright launch fixture, the lint zone for
  `!`, ARIA instead of Lit reads, and the duplicate or uncovered specs
  (ranked 5, plus L3 F7 and L6 F3/F5);
- `DOM_DIRS` and shuffled `pure` and `kernel` in CI (L6 F2, L4 F9);
- the edge functions' `import.meta.main` (L5 F8);
- Lean's `lakeCommand` and its waits (L2 F4, L4 F8);
- the pinned-model dedupe, the unused mocks in `ModelAccess` and
  `CompileCheck`, the comments promising tests, and the `test:pure` figure
  (L6 F4, L3 F8, L2 F5, L6 F7).

It touches `packages/desktop/**`, `vitest.config.mjs`, `.github/workflows/`,
`supabase/functions/**`, `oxlint.config.mts`, the Lean sources and suites,
`src/test-kernel/{model,agent/output/CompileCheck*,cli/ModelAccess*}` and
the CLI settings comments.

**Sequenced after other PRs: D's PR 3 once each blocker lands, except ranked 3, which is A's:**

- ranked 3 goes in A's TUI lifecycle PR;
- ranked 4, `sessionEvents`' split (L5 F1), the `processLayer` test options
  (L2 F1) and `ProviderCapabilities` (L3 F6) follow E's #14829;
- the 40-file move of single-package suites (L6 F6) follows B's and A's
  PRs;
- the UsageLogService `TestClock` rewrite (L4 F7) depends on G9.
