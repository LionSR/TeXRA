# UI kit bypasses: what the 2026-11-25 audit left open

Date: 2026-11-25
Status: proposed

Origin: the scheduled audit for UI code written beside the kit
(`packages/texra/src/ui/wa/`, `packages/texra/src/ui/styles/`,
`packages/cli/src/tui/ui/`). The PR that adds this note makes `ListForm`
paint and measure its own description, names a list's hotkeys in `Select`,
joins every one-line fact list through `joinFacts`, has the desktop toolbar
and file tree read `WORKBENCH_KIND_META`, and paints failed cards from the
tone table. It continues
`.agents/docs/proposed/simplification/2026-11-22-ui-kit-bypasses-left-open.md`,
whose entries 3 and 5 to 9 are still open.

Each entry below changes something a user sees, so each wants a look in
both themes and both graphical hosts, or an Ink render check, before it
lands.

## Web views

1. **A hover hint has two forms for one kind of thing.** A message
   timestamp is a `<wa-tooltip>` in `UserMessage.ts` and a native `title`
   in `bannerFormatters.ts` and `messageFormatters.ts`; a file path is a
   `<wa-tooltip>` in `FileList.ts` and `ProposalRequestPanel.ts` and a
   `title` in `FileSelectGroup.ts`, `LaunchAttachments.ts` and
   `htmlBuilders.ts`. A `<wa-tooltip>` anchors by `id`, and the formatter
   rows render many to a shadow root, so the choice is between a native
   `title` everywhere and an id per row. The same three files write the
   message header (icon, author, time, Copy) out in full; one
   `buildMessageHeader` beside `messageHeaderStyles` would hold it.
2. **A clickable file path has three markups and three click handlers.**
   `buildFileLinkSpan` (`htmlBuilders.ts`) is the owner; `FileList.ts` and
   `ProposalRequestPanel.ts` write their own span without its accessible
   name, each with its own click and keydown handler.
3. **`PluginsTab.renderSelectRow` restates `renderStateSettingSelectRow`**
   (`settings/components/shared/stateSettingRows.ts`): the same catalog
   lookup, row markup and write. The plugin card passes its own label and
   a narrower select, so the helper needs a `label` first.
4. **Closed.** `UserMessage.ts` draws its Copy through `buildCopyButton`,
   so the user, assistant and error headers share one `<copy-button>` and
   its native `title` hint.
5. **Dot separators in templates.** `UsagePanel.ts`, `SessionComposer.ts`
   and `ModelSelectionList.ts` write `<span aria-hidden="true">·</span>`
   between elements. `joinFacts` joins strings only; a template join that
   hides the dot from a screen reader would be the owner. (`wa/metaStrip.ts`
   was that helper without the `aria-hidden` and without a caller; it is
   deleted.)
6. **A status glyph and its colour disagree in two places.** `LaTeXTab.ts`
   shows a missing dependency as `triangle-exclamation` in the error colour,
   and the "Failed to render" entry (`progress/formatters/index.ts`,
   `logEntryStyles.ts`) shows `circle-exclamation` in the warning colours.
   The success mark is `check` in three places and `circle-check`
   (`TONE_GLYPH.success`) in one, in three greens. `statusGlyph({ tone })`
   with a `tone-*` class is the owner; which green stays is a design call.
7. **Closed.** `BackgroundTasksPanel.ts`'s badges take their variant from
   a `RunTone` table and their glyph and accessible name from the running
   and waiting statuses. The table stays in the panel until a second badge
   reads a tone.
8. **Closed.** The retry card's "Error details" is a plain
   `.collapsible-quiet`; its header and summary rules are gone. Its body
   stays local: it is extra-small, height-capped text in the card, where
   `toolUseStyles.ts`'s error `pre` is a transcript row at body size, and
   the two sheets never meet in one shadow root.
9. **Closed.** `DependencyBanner.ts` joins its install links with
   `Intl.ListFormat.formatToParts`, the formatter `formatWordList` wraps.
   The native `<button class="clickable-link">` stays: the link sits inside
   a sentence, and a `wa-button` is inline-flex and would break the line
   (`button.clickable-link` in `commonViewStyles.ts` says so).

## Desktop

10. **Two status dots.** `.status-dot` (`styles.css`, 6px, `--dot-color`)
    sits beside the kit's `.status-indicator`
    (`styles/statusIndicatorStyles.ts`, 7px, `--tone-color`); the left rail
    shows both sizes, a project's unseen dot above a run's. The two
    remaining `.status-dot` users, `desktopShell.ts` and `main.ts`, are in
    open PRs. (The 2026-11-26 run gave the file tree's "unsaved" dot in
    `editorPane.ts` the accessible name the dock tab's has.)
11. **Sidebar group labels** (`.shell-sidebar-section-label` and the Files
    header in `desktopShell.css`) are small grey labels beside the kit's
    `.overline`, which `RunTabs.ts` uses for its headings in the same
    sidebar. Moving them makes the labels uppercase.
12. **The path footer** (`footer.shell-editor-toolbar` with a path and one
    compact button) is built in `pdfPane.ts` and in `projectWorkbench.ts`.

## Terminal

13. **`detailRows` is still counted by the caller.** `ListForm` now measures
    its description; `AccountAccessForm.tsx`, `GitHubTokenForm.tsx` and the
    skills forms still pass a row count for a `detail` they render, at one
    row a line.
14. **Closed.** `TasksForm.tsx` shows the newest rows under a dim
    `previousRowsText` marker when the transcript is longer than its budget.
15. **Clipping text to fit beside a fixed suffix** is written in
    `render/scrollBounds.ts` and twice in `modals/UserQuestion.tsx`, and
    `UserQuestion.tsx` bounds its prompt lines with its own version of
    `boundedScrollableLines`. Its version keeps the question and drops the
    oldest context, which the shared one does not.
16. **A group heading inside a `Select`** is `<Text bold dimColor>` in
    `SubagentList.tsx` and a one-row truncating box in
    `ScriptStagePopup.tsx`.
17. **`App.tsx` tests Ctrl-C and Ctrl-Z itself** where 22 sites use
    `isCtrlInput` (`tui/inputKeys.ts`), which also rejects Meta.

## Every host

18. **Closed.** The CLI's preference labels
    (`packages/cli/src/runtime/models/modelAccessRoute.ts`) and the child
    agent heading (`packages/texra/src/ui/copy/delegationApproval.ts`) join
    their facts with `joinFacts`.

## The kit itself

19. **`controlStyles.ts` restates a block of `commonViewStyles.ts`.**
    `.btn-ghost.is-row::part(label)` writes out `truncateDeclarations`,
    which lives in the module above it (`commonViewStyles.ts` imports
    `controlStyles.ts`, so the lower file cannot import it back). The
    2026-11-26 run moved `visuallyHiddenDeclarations` down into
    `controlStyles.ts`, where `.action-button-label` now interpolates it.
    `truncateDeclarations` takes the same move once `FileList.styles.ts`
    and `SessionDrawer.ts`, two of its importers, are out of open PRs.

## Checked and declined

- **The shell's log-level colours** (`styles.css`, `logEntryStyles.ts`)
  onto `tone-*`. `copy/logLevels.ts` says each host colours a level's
  icon, and the quiet fills stay local either way.
- **The trace viewer's scrubber.** A native range input; the kit has no
  slider and nothing else needs one.
