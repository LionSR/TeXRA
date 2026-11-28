# UI kit bypasses: what the 2026-11-28 audit left open

Date: 2026-11-28
Status: proposed

Origin: the scheduled audit for UI code written beside the kit
(`packages/texra/src/ui/wa/`, `packages/texra/src/ui/styles/`,
`packages/cli/src/tui/ui/`). The PR that adds this note moves
`<copy-button>` into `wa/`, makes `renderStatusBadge` the tag without an
icon, adds `renderSettingsSelectRow`, draws the context gauge with
`renderMeterBar`, gives a received message's heading one rule for the web
and the terminal, reads two settings wordings from `copy/plugins.ts`, and
lets Ink truncate the request cards' fact lines. It closes entries 3, 4
and 8 of
`.agents/docs/proposed/simplification/2026-11-27-ui-kit-bypasses-left-open.md`,
the three plain tags of its entry 6 and half of its entries 9 and 11; the rest of that note and of
`.agents/docs/proposed/simplification/2026-11-25-ui-kit-bypasses-left-open.md`
still stands.

Its scan of the commits since the 2026-11-27 audit found no custom SVG or
glyph icon, no colour literal outside the palettes, no inline style, no
native control with a local skin and no hand-drawn Ink box, spinner or list.

## Open

1. **Two preview widths for one row.** `RECEIVED_PREVIEW_MAX_CHARS`
   (`packages/texra/src/ui/progress/formatters/logFormatters/messageFormatters.ts`)
   and `HEADER_PREVIEW_MAX_CHARS` (`toolFormatters.ts` beside it) are both
   120 and both feed `buildDetailsSummary`. The width belongs to the summary
   builder in `progress/formatters/htmlBuilders.ts`. No visible change.
2. **The script stage's section label** (`.section` in
   `packages/texra/src/ui/progress/components/ScriptStage.ts`) is small
   secondary text over a group of rows; `overlineDeclarations`
   (`styles/commonViewStyles.ts`) is the kit's group heading and would make
   it uppercase. The terminal draws the same sections with
   `SelectGroupHeading`. A design call.
3. **The script row is 28px**, a height no token holds on either host
   (`--control-size-m` is 24px on the desktop and 22px in the editor). It
   joins entry 3 of the 2026-11-22 note.
4. **A settings heading and its tab differ**: "Approval & safety"
   (`settings/tabs/ApprovalTab.ts`) under the tab "Approval"
   (`settings/settingsNav.ts`). Which name stays is a wording call; the
   heading should then read the nav table.
5. **`PlanRequest.tsx` and `QueuedFollowUpsPanel.tsx` still truncate by
   hand.** The plan notice pads its line with `fillRows` and the queue
   panel builds its rows in a display function its row budget reads, so
   neither is the one-line move the two request cards were.
6. **The desktop theme is a three-option select.** The README's rule for
   two to four exclusive options is a segmented `wa-radio-group`; the row
   is now `renderSettingsSelectRow`, and the kit has no segmented settings
   row yet (`ApprovalTab.ts` writes its own).

7. **The plugin card's tool badge** (`.catalog-tool-badge` in
   `settings/components/plugins/PluginCard.ts`) is the one `<wa-tag>` still
   written by hand: a filled tag around a `<bdi>` name, which
   `renderStatusBadge` has no filled tag or template label for.

## Checked and declined

- **A `captionDeclarations` block** (entry 7 of the 2026-11-27 note). The
  pair is two token reads; an interpolation with its import is as long as
  what it replaces, and the tokens are already the owner.
- **`'Partial entry'` in the desktop's `logsPane.ts`.** Only the desktop
  has a logs pane, so the string has one reader.
