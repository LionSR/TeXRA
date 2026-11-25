# Agent SDK readiness: what the 2026-11-25 audit landed, and what it left

Date: 2026-11-25
Status: proposed (one theme landed with this note; the rest are recorded under
earlier notes and are owner-gated, ratchet-reversing, or their-own-change
decompositions)

Origin: a scheduled review of the harness for Agent SDK readiness — the agent
core, the model handler, the logger and the public host surface — looking for
unnecessary abstractions, wrapper layers, pass-through indirection,
single-caller helpers, re-export shims, redundant interfaces and dual
representations of one fact, and for logical units that could run as
independent agents. Read against `main` at `37a22c5`, continuing
[`2026-11-20-agent-sdk-readiness-audit.md`](2026-11-20-agent-sdk-readiness-audit.md),
[`2026-11-21-agent-sdk-readiness-shallow-indirection.md`](2026-11-21-agent-sdk-readiness-shallow-indirection.md),
[`2026-11-23-agent-sdk-readiness-left-open.md`](2026-11-23-agent-sdk-readiness-left-open.md)
and
[`2026-11-24-agent-sdk-readiness-left-open.md`](2026-11-24-agent-sdk-readiness-left-open.md).
A re-derived-fact scout over the model-invocation, run-lifecycle, model-access,
logger-trace, public-SDK and host-request seams, crossed with the mechanical
`check:fact-spread` vocabulary-overlap report and a repo-wide read of every
`RunOutcome` literal comparison.

## Headline

The SDK surface stays well-aligned, for the fifth run running. The four prior
runs confirmed every forbidden import edge is zero, the run loop is one program
with one publisher, no shallow presenter or re-encoding wrapper survives in the
host surface, and no two-value-union-as-boolean remains in the core. This run
adds two mechanical confirmations: `check:fact-spread` reports only six
vocabulary-overlap pairs repo-wide, every one a coincidental three-member
overlap or a legitimately-separate per-surface list (see "Verified dead-ends"),
and a very-thorough re-derived-fact scout turned up one small, complete theme
and nothing larger. There is no 200+-line net-negative theme left in this area
that does not reverse a deliberate ratchet or need an owner decision; the
landable work is now marginal, and this run lands all of it.

## Landed with this note

**Run-outcome and approval-bypass vocabularies are read from their owners, not
re-spelled.** This is the exact shape of the three facts the 2026-11-24 run
routed through their owners (`NESTED_NOUNS`, `RUN_OUTCOME`,
`getDisplayedInstruction`); the scout found the remaining instances.

- `RUN_OUTCOME` (`shared/schemas/run.ts`) is the single owner of the
  `{completed, cancelled, failed}` triad (`Schema.Enum(RUN_OUTCOME)`). Ten
  sites compared a `RunOutcome`-typed value against the bare literal instead.
  The most telling was inside `runToolUse` (`agent/runtime/loop/runLoop.ts`):
  the file imports `RUN_OUTCOME` and already uses it in six places, yet one
  `if (turn.outcome === 'cancelled')` returned `{ outcome: RUN_OUTCOME.CANCELLED }`
  — the comparison and its own return disagreed on how to spell one value. The
  loop (`runLoop.ts`, seven sites), the run-action rule (`runActions.ts`), the
  CLI history note (`runtime/history.ts`) and attention bell
  (`chat/tui/runChatTui.tsx`), the chat controller
  (`chat/chatSessionController.ts`, two sites), the onboarding funnel
  (`controllers/onboarding/onboardingFunnel.ts`) and the extension chime
  (`progressView/ProgressViewProvider.ts`) now read `RUN_OUTCOME.*`. Every swap
  is identical-value and behavior-preserving; no stored row, wire or digest
  changes.
- `APPROVAL_BYPASS_KINDS` (`shared/approvalBypassKind.ts`) is the pinned owner
  of the three bypass kinds. `GOAL_AUTO_APPROVALS.allAgentWork`
  (`tools/plan/PlanTool.ts`) hand-listed all three; since its type
  (`readonly ApprovalBypassKind[]`) does not enforce completeness, a fourth
  kind would silently drop out of "all agent work." It now spreads
  `APPROVAL_BYPASS_KINDS`, so "all agent work" tracks the owner. `commands:
  ['bash']` is a genuine subset and is left alone. The value is consumed via
  `grants.goal.includes(kind)`, so the order change is not behavior.

## Verified dead-ends (recorded so a later run does not re-chase them)

- **`hooks.ts`'s Stop-hook `turn.outcome`** (`loop/hooks.ts`) is typed `string`
  at the hook boundary, not `RunOutcome` — a deliberately loosened edge, left
  alone rather than re-coupled to the owner for a single literal.
- **`runBypasses`** (`approvalBypassKind.ts`) hand-spells its three keys, but
  its return type `Record<ApprovalBypassKind, boolean>` already makes adding a
  kind a compile error there, so it is compile-safe; iterating the owner would
  only trade an exhaustiveness the type gives for an `as` cast. Left explicit.
- **The `ScriptDelivery` outcome** (`['completed', 'failed', 'stopped']`,
  `shared/scriptDelivery.ts`; read in `subagentFollowup.ts`, `scriptRun.ts`) is
  a different, un-named triad with `stopped` instead of `cancelled` — not a
  re-spelling of `RUN_OUTCOME`.
- **The store-cleanup outcome** (`['failed', 'kept', 'deleted']`,
  `projectDatabase.ts`) is its own result union, not `RunOutcome`.
- **The SDK examples** (`packages/harness/example/*`) compare outcome literals
  as an embedder would; they are documentation of the wire values, not core
  re-spellings.
- **`check:fact-spread`'s six overlap pairs** are all coincidental or
  legitimately separate: `dockControls.ts ~ workbenchController.ts` (both
  `satisfies WorkbenchKind[]` subsets over the owner `WorkbenchKind`);
  `hookProtocol.ts ~ hookOutcome.ts` (`allow/ask/deny` on a wire boundary);
  `storedTurn.ts ~ message.ts`/`turn.ts` (media kinds and finish reasons
  normalized at the llm boundary); `message.ts ~ turn.ts` (`high/low/medium`
  across request/response shapes); `settingsTarget.ts ~ settingsViewMessages.ts`
  (the latter imports `SettingsTargetSchema` from the former — the three-member
  overlap is an unrelated literal set). None is one vocabulary spelled twice.

## Open: recorded elsewhere, owner-gated or its-own-change

No new larger finding survived. The standing candidates in this area are
already catalogued and unchanged:

- The below-bar / ratchet-reversing / owner-gated items in
  [`2026-11-24-agent-sdk-readiness-left-open.md`](2026-11-24-agent-sdk-readiness-left-open.md)
  (the three dead public re-exports, `IMAGE_LIMITS`, `PLAN_EFFORTS`,
  `NOTICE_OF`).
- The complex-function decompositions in
  [`2026-11-24-duplication-and-complexity-scan.md`](2026-11-24-duplication-and-complexity-scan.md)
  (`createEditorPane`, the `openGuiWindow` dispatcher, `configureAnsi`,
  `buildStatusBarDisplay`), each its own careful change, not a sweep.

## Subagent boundaries

Unchanged from the four prior runs: a run is already the independent-agent unit
(`executeAgent` / `launchProcessChild`), delegation launches children through
`childLaunch.ts`, and a plugin program is a run on a generated script. No new
split is proposed; a second orchestration layer beside the run loop is the shape
the design doc rules out ("no flow engine").

## Verified

- Read `main` at `37a22c5`. The changes are internal identical-value swaps; no
  public export, no persisted/wire/digest change. (Gate and test results in the
  PR body.)
- Not run: a live model, the desktop and VS Code e2e.
