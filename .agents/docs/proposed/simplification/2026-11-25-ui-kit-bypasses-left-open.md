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
   `FileList.ts` and `ProposalRequestPanel.ts` and a native `title` in
   `FileSelectGroup.ts`, `LaunchAttachments.ts` and `htmlBuilders.ts`. A
   `<wa-tooltip>` anchors by `id`, and the formatter rows render many to a
   shadow root, so the choice is between a native `title` everywhere and an
   id per row. (Closed for a message's time: `buildMessageHeader` writes the
   user, assistant and error headers, with the full moment as a `title`.)
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
7. **Closed.** `toneVariant` (`wa/waVariant.ts`) maps a `RunTone` to a
   badge or tag variant; the approval badge reads the waiting status's
   glyph and name.
8. **`RetryRequestPanel.styles.ts` re-skins `.collapsible-quiet`** (header
   height, padding, hover colour) and restates the error-details `pre` of
   `toolUseStyles.ts`.
9. **`DependencyBanner.ts`** joins its install links with a hand-written
   "a, b, and c" and a native `<button class="clickable-link">`, the one
   use of that rule on a button. `formatWordList` returns a string; a
   `formatToParts` variant and the kit's link button would replace both.

## Desktop

10. **Two status dots.** `.status-dot` (`styles.css`, 6px, `--dot-color`)
    sits beside the kit's `.status-indicator`
    (`styles/statusIndicatorStyles.ts`, 7px, `--tone-color`); the left rail
    shows both sizes, a project's unseen dot above a run's. (The "unsaved"
    dot is one template now, `unsavedDot` in `paneChrome.ts`; a tab's is
    the text colour and a tree row's the accent, which is a design call.)
11. **Sidebar group labels** (`.shell-sidebar-section-label` and the Files
    header in `desktopShell.css`) are small grey labels beside the kit's
    `.overline`, which `RunTabs.ts` uses for its headings in the same
    sidebar. Moving them makes the labels uppercase.
12. **Closed.** `pathFooter` (`paneChrome.ts`) builds it for both panes.

## Terminal

13. **`detailRows` is still counted by the caller.** `ListForm` now measures
    its description; `AccountAccessForm.tsx`, `GitHubTokenForm.tsx` and the
    skills forms still pass a row count for a `detail` they render, at one
    row a line. Ink's `useBoxMetrics` measures the rendered block, which
    would delete `detailRows`, `detailRowsFor` and the description's own
    count; it reports zero until the first layout, so the first frame needs
    a list budget that cannot overflow the terminal, and an Ink render check.
14. **Closed.** The attached task's transcript is bounded by
    `boundedScrollableLines`, under a `… N previous rows` marker.
15. **Clipping text to fit beside a fixed suffix** is written in
    `render/scrollBounds.ts` and twice in `modals/UserQuestion.tsx`, and
    `UserQuestion.tsx` bounds its prompt lines with its own version of
    `boundedScrollableLines`. Its version keeps the question and drops the
    oldest context, which the shared one does not.
16. **Closed.** `SelectGroupHeading` (`tui/ui/Select.tsx`).
17. **Closed.** `App.tsx` reads Ctrl-C and Ctrl-Z through `isCtrlInput`.

## Every host

18. **Two files still type the fact separator.**
    `packages/cli/src/runtime/models/modelAccessRoute.ts` (the `On · …` and
    `Off · …` preference labels) and
    `packages/texra/src/ui/copy/delegationApproval.ts` (the child agent
    heading) were left as they are because other open PRs rewrite the same
    lines; they take `joinFacts` once those land.

The 2026-11-26 run closed entries 2, 4, 5, 7, 12, 14, 16 and 17 and half of
1 and 10, and rewrote 3 and 13 to what it found. Its scan of the three hosts
found no new custom icon, colour literal or inline style.

## Checked and declined

- **The shell's log-level colours** (`styles.css`, `logEntryStyles.ts`)
  onto `tone-*`. `copy/logLevels.ts` says each host colours a level's
  icon, and the quiet fills stay local either way.
- **The trace viewer's scrubber.** A native range input; the kit has no
  slider and nothing else needs one.
