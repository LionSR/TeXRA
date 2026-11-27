# UI kit bypasses: what the 2026-11-27 audit left open

Date: 2026-11-27
Status: proposed

Origin: the scheduled audit for UI code written beside the kit
(`packages/texra/src/ui/wa/`, `packages/texra/src/ui/styles/`,
`packages/cli/src/tui/ui/`). The PR that adds this note moves the model
picker onto the list helpers, gives the two popover panels one chrome and
the subscription quota bar one helper, has `ListForm` measure its own
detail, and gives the terminal's tool-output prefix one owner. It continues
`.agents/docs/proposed/simplification/2026-11-25-ui-kit-bypasses-left-open.md`,
whose open entries still stand.

Each entry changes something a user sees unless it says otherwise.

## Web views

1. **The model picker's reasoning levels are hand-written radios.**
   `ModelPicker.ts` draws `role="radio"` buttons in a `role="radiogroup"`
   with no arrow-key movement and no roving tab stop. The kit's choice for
   a few visible options is `wa-radio-group` with `appearance="button"`
   (`ApprovalTab.ts`), which brings both. A model offers up to seven
   levels, more than the two to four the README gives a segmented group,
   so the row needs a look in the popover's 20rem before it moves.
2. **The model picker's search is a native `<input>` with its own skin.**
   `.input-plain` is the kit's search that owns a band, but it is sized for
   the command palette (header height, large type). A compact step of that
   skin would serve both; the picker also lacks the palette's combobox
   roles (`aria-activedescendant`, `aria-controls`).
3. **The context gauge is the third bar.** `UsagePanel.ts` styles its own
   `wa-progress-bar` (6px, `--tone-color`); `renderQuotaBar`
   (`wa/quotaBar.ts`) draws the other two. The file is in an open PR.
4. **`<copy-button>` lives under `progress/components/`** and the LaTeX
   settings tab now imports it from there. It belongs in `wa/`; one of its
   three importers, `htmlBuilders.ts`, is in an open PR. No visible change.
5. **Settings say "ready" three ways.** `PluginCard.ts` shows `check` in
   `--color-status-ok`, `LaTeXTab.ts` the same with its own classes, and
   `SubscriptionSection.ts` an uncoloured `circle-check`;
   `renderSetStatusIcon` (`wa/statusIcons.ts`) draws `check` in a third
   green. `--color-status-ok` is the editor's test colour on purpose, so
   which mark and which green stay is a design call (entry 6 of the
   2026-11-25 note).
6. **A tag without an icon has no helper.** Four settings files write
   `<wa-tag size="s">` themselves (`SubscriptionSection.ts`, `PluginCard.ts`,
   `LaTeXTab.ts`, `SkillsTab.ts`, the last with no variant);
   `renderStatusBadge` requires an icon.
7. **Caption text is restated.** Sixteen rules in the settings sheets and
   two desktop sheets pair `--font-size-xs` with `--color-text-secondary`;
   nine more pair `--font-size-sm` with it. A `captionDeclarations` block
   beside `truncateDeclarations` would hold the first. No visible change.
8. **A settings select row is written twice**, in
   `settings/components/shared/stateSettingRows.ts` and the desktop's
   `settingsDialog.ts` (Theme); `wa/settingsSection.ts` has a toggle row
   and a number row and no select row. No visible change.
9. **The same action is worded twice.** `LaTeXTab.ts` says "Run in
   Terminal" where `PLUGINS_PAGE.installInTerminal` says "Install in
   terminal"; `SkillsTab.ts` types "Available to agents", which
   `PLUGINS_PAGE.availableToAgents` holds; a settings section tab and the
   heading under it differ in `settingsNav.ts` and `LaTeXTab.ts` /
   `ApprovalTab.ts` ("Approval" and "Approval & safety").

## Terminal

10. **Row counts typed for chrome another component draws.**
    `REVERSE_SEARCH_ROWS`, `SLASH_PALETTE_ROWS`, the fixed-row constants in
    `ScrollableModalText.tsx` and `ToolEditRequest.tsx`, and
    `PLAN_APPROVAL_GOAL_NOTICE_ROWS` are hand sums of a `BorderedPanel`'s
    border, margins and footer. `borderedPanelChromeRows` or a measured box
    (as `ListForm` now does) is the owner. No visible change.
11. **Text truncated by hand before `<Text>`.** `PluginTrustRequest.tsx`,
    `BashRequest.tsx`, `PlanRequest.tsx` and `QueuedFollowUpsPanel.tsx`
    call `truncateToWidth` on a string they then paint;
    `wrap="truncate-end"` uses the same `cli-truncate`. The widths they
    pass re-derive the padding of the box around them.
12. **A warning coloured by hand.** `PluginTrustRequest.tsx` and
    `AgentProposal.tsx` paint `COLOR_WARNING` where `ToneLine` draws the
    marker too.
13. **Loading labels are typed in each form** ("Loading models…" twice,
    "Loading skills…" twice, five more); only the plugins form reads
    `PLUGINS_PAGE.loading`. No visible change.
14. **`validate-tui.mjs` fails seven scenarios on `main`** (`config-form`,
    `config-category-back-responsive`, `approval-form`,
    `approval-revoke-grant`, `approval-policy-status-bar`,
    `multi-agent-toggle`, `compact-approval-form`): they expect the
    `/config` categories and approval rows the 2026-11-26 changes removed.
    The scenarios want rewriting against the current forms.

## Checked and declined

- **The prompt gutter in `TextInput.tsx`** (`PROMPT_PREFIX`) equals
  `USER_ENTRY_PREFIX` by value, not by meaning: one is the input's prompt,
  the other a transcript row's mark.
- **A `[hidden]` rule for the desktop's light DOM.** Three one-line rules
  in two sheets; a shared sheet would be longer than they are.
- **`helpText.ts`'s typed `·`.** It is inside Markdown the help command
  prints, between key bindings, not a list of facts.
