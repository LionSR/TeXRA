# GUI lanes G2–G6: what the sweep left for a design call

Date: 2026-10-03
Status: proposed
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
`@shared/schemas` barrel line `export * from './proposalInput'`. Its doc still
calls it "the single mapping shared by the agent tool and replay", which is
no longer true.

Proposal: inline the function beside `FIGURE_OPTIONS` in `src/tools/registry.ts`
and delete `proposalInput.ts` and its barrel line. That removes one file and
one barrel export, for about −5 lines net.

Why it was not done here: `src/tools/registry.ts` is the plugin registry,
which another lane owns this week. Do it in that lane's next PR, or after
that lane lands.

## 2. `usageCostLabel(...) ?? formatCostUsd(cost)` four times

There are four call sites:

- the CLI's `sessionStatus.ts:89`
- the extension's `extension.ts:613`
- the progress view's `UsagePanel.ts:279`
- the progress view's `UsagePanel.ts:355`

Each one falls back to the bare amount when `usageCostLabel` has nothing to
say. A total variant of `usageCostLabel` that takes the `TokenUsageStats`
and never returns `undefined` would replace all four.

Not done: it adds one exported function and removes none. The four sites
are the same pattern but not the same caller shape: `extension.ts`
destructures the fields, and `UsagePanel` passes `this.usage` fields.
Worth doing only if the next cost-surface change touches three of the
four anyway.

## 3. `deliveredResponse` parses the same output twice per tool row

In `src/ui/transcript/toolRowSections.ts`, an `agent` call's row parses
`ctx.outputText` once in the section builder (`:378`) and again when
`toolRowModel` decides `carriesOutput` (`:685`). That is a redundant parse
of the same string on every render of an agent row.

The two tests differ: `if (answer)` treats an empty answer as absent, but
`!== undefined` counts it. Carrying the parse once, by returning it from the
builder or deciding `carriesOutput` from the presence of the `Result:`
section, needs that difference settled first. Behaviour-preserving only if
an empty `<response>` cannot reach here.

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
