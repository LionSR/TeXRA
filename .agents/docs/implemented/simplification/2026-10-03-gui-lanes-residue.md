# GUI lanes G2–G6: what the sweep left for a design call

Date: 2026-10-03
Status: implemented (items 2 and 3 by the pre-freeze cleanup lane; item 1 handed to the R1 lane, which owns `src/tools/registry.ts`)
Origin: the simplification sweep over the GUI lanes (#13636, #13640, #13645,
#13647, #13648, #13659, #13661). The sweep's batched PR removed what had no
consumer and merged the plugin row model the Plugins page and `/plugins`
each spelled. The lane PRs themselves cleaned up after their cuts: the
Tools tab, "Edit as new task", `/ps`, `/send`, Copy run context, the welcome
credential section, the desktop team dialog and the "Auto:" switches left
no command id, message type, copy entry, slice or test helper behind
(grepped by symbol and by string literal). The findings below are the ones
the sweep did not implement, because each needs an owner's call or sits in
a file another lane owns.

## 1. `extractionShorthandToolConfig` has one caller

`src/shared/schemas/proposalInput.ts` held the delegation-input parser until
#13661 deleted `parseDelegationToolInput`. What remains is
`extractionShorthandToolConfig`, whose only caller is
`src/tools/registry.ts:129` (`FIGURE_OPTIONS.toolConfig`), reached through the
`@shared/schemas` barrel line `export * from './proposalInput'`: a whole file
and a barrel export for one option mapping.

Proposal: inline the function beside `FIGURE_OPTIONS` in `src/tools/registry.ts`
and delete `proposalInput.ts` and its barrel line. That removes one file and
one barrel export, for about −5 lines net.

Why it was not done here: `src/tools/registry.ts` is the plugin registry,
which another lane owns this week. Do it in that lane's next PR, or after
that lane lands.

## 2. `usageCostLabel(...) ?? formatCostUsd(cost)` four times (done)

`usageCostLabel` now takes the usage record (`cost`, `usageRoute`,
`usagePlan`) and is total: an unknown route shows the bare amount, even at
zero. The four fallbacks went, and so did the CLI's local `costLabel`
wrapper. The one caller that omits the line for a task that never reached
a model, the CLI resume hint, tests `cost > 0 || usageRoute !== undefined`
itself, which is the old `undefined` case exactly (`usageRouteBadge`
returns `undefined` only for an absent route).

## 3. `deliveredResponse` parses the same output twice per tool row (done)

The `agent` row's `carriesOutput` is now read from the section the builder
built (`AGENT_ANSWER_LABEL`) instead of a second parse. The two tests
agreed already: `deliveredResponse` never returns an empty string, since a
present body is decoded non-empty and an absent one falls back to
`summarizeSubagentFollowup`, which returns the non-empty envelope or its
summary.

## Rejected

- **Hoisting the CLI's task-root lookup.** `sessionStatus.ts:73` and
  `statusBarDisplay.ts:279` both read the root as `run.ancestors[0]` (root
  first, so correct). Two sites in one host: a helper would be an
  extraction with no shared owner.
- **Renaming `SessionListRow`, `sessionListRows` and `sessionListRunIds`**
  (`packages/cli/src/chat/tui/state/cliState.ts`) to the "agent list" noun the
  copy now uses. This is churn-class (R5): the names are internal, and the
  rename removes no element.
- **`STOPPED_SELECTED_BACKGROUND_TASK_MESSAGE`** in `validate-tui.mjs`. Same
  reason: it is a test-script constant name, and its value is current.
- **Hoisting `formatResumeHint`'s cost line or the interrupted-task notice into
  `src/ui`.** Already done: both hosts render from
  `@ui/copy/interruptedTasks`, and the script card from
  `@ui/transcript/scriptStage`.
- **`applyHarnessApprovalPolicySelection`'s `status` branch**
  (`tui-harness.tsx`). This is harness-only and pre-existing. Production has
  no such branch, so deleting it changes nothing a scenario covers. Too
  small to stand alone.
