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

1. **A file path's hover hint has two forms.** It is a `<wa-tooltip>` in
   `ProposalRequestPanel.ts` and a native `title` in
   `FileSelectGroup.ts`, `LaunchAttachments.ts` and `htmlBuilders.ts`. A
   `<wa-tooltip>` anchors by `id`, and the formatter rows render many to a
   shadow root, so the choice is between a native `title` everywhere and an
   id per row. (The 2026-11-27 run gave the user message's time the native
   `title`; the file-path hint is still open.)
2. **Closed.** `buildFileLinkSpan` draws every clickable file path and
   `fileLinkTarget` reads the click.
3. **`PluginsTab.renderSelectRow` restates `renderStateSettingSelectRow`**
   (`settings/components/shared/stateSettingRows.ts`): the same catalog
   lookup, row markup and write. The plugin card passes its own label and
   a narrower select, so the helper needs a `label` first. The only rows
   that use it are the Codex and Claude Code plugins' inline settings, which
   #15230 deletes; if that lands, the method goes with them.
4. **Closed.** The user message's Copy is the shared `<copy-button>`.
5. **Closed.** `factDot` (`wa/factDot.ts`) is the dot between two
   elements, hidden from a screen reader.
6. **A status glyph and its colour disagree in two places.** `LaTeXTab.ts`
   shows a missing dependency as `triangle-exclamation` in the error colour,
   and the "Failed to render" entry (`progress/formatters/index.ts`,
   `logEntryStyles.ts`) shows `circle-exclamation` in the warning colours.
   The success mark is `check` in three places and `circle-check`
   (`TONE_GLYPH.success`) in one, in three greens. `statusGlyph({ tone })`
   with a `tone-*` class is the owner; which green stays is a design call.
   (The 2026-11-27 run gave `LaTeXTab.ts`'s missing dependency
   `circle-exclamation`, the error glyph its colour already said.)
7. **Closed.** `toneVariant` (`wa/waVariant.ts`) maps a `RunTone` to a
   badge or tag variant; the approval badge reads the waiting status's
   glyph and name.
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
    open PRs. (The "unsaved" dot is one template now, `unsavedDot` in
    `paneChrome.ts`, with its accessible name; a tab's is the text colour
    and a tree row's the accent, which is a design call.)
11. **Sidebar group labels** (`.shell-sidebar-section-label` and the Files
    header in `desktopShell.css`) are small grey labels beside the kit's
    `.overline`, which `RunTabs.ts` uses for its headings in the same
    sidebar. Moving them makes the labels uppercase.
12. **Closed.** `createPathToolbar` (`editorFileNotice.ts`) builds it for
    both panes.

## Terminal

13. **Closed.** `ListForm` measures the box it draws its `detail` in
    (Ink's `useBoxMetrics`), so no form passes a row count and a wrapped
    line is counted.
14. **Closed.** `TasksForm.tsx` shows the newest rows under a dim
    `previousRowsText` marker when the transcript is longer than its budget.
15. **Clipping text to fit beside a fixed suffix** is written in
    `render/scrollBounds.ts` and twice in `modals/UserQuestion.tsx`, and
    `UserQuestion.tsx` bounds its prompt lines with its own version of
    `boundedScrollableLines`. Its version keeps the question and drops the
    oldest context, which the shared one does not.
16. **Closed.** `SelectGroupHeading` (`tui/ui/Select.tsx`).
17. **Closed.** `App.tsx` reads Ctrl-C and Ctrl-Z through `isCtrlInput`.

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

The 2026-11-26 run closed entries 2, 4, 5, 7, 12, 14, 16 and 17 and half of
1 and 10, and rewrote 3 and 13 to what it found. Its scan of the three hosts
found no new custom icon, colour literal or inline style.

## Checked and declined

- **The shell's log-level colours** (`styles.css`, `logEntryStyles.ts`)
  onto `tone-*`. `copy/logLevels.ts` says each host colours a level's
  icon, and the quiet fills stay local either way.
- **The trace viewer's scrubber.** A native range input; the kit has no
  slider and nothing else needs one.
