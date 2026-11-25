# UI kit bypasses: what the 2026-11-22 audit left open

Date: 2026-11-22
Status: proposed

Origin: the scheduled audit for UI code written beside the kit
(`packages/texra/src/ui/wa/`, `packages/cli/src/tui/ui/`). The PR that adds
this note lets a button's `kind` decide its Web Awesome appearance, drops the
`.icon-button` alias, gives errors and list removal one icon each, moves the
process command strip onto the shared inset focus ring, gives the desktop
and the request cards one rule for "is this key typing", and moves the TUI's
pointer prompt row and render-error line onto the kit.

## Open

1. **Closed.** The helper takes a template label, `current` and
   `expanded`, and the onboarding choices, project rows, review rows and
   composer chips are built through it.
2. **One row button outside the helper.** `SettingsCatalog.ts` writes a
   native `<button>` with `aria-current` for its row, because the row holds
   a two-line text block and a badge slot.
3. **Hard-coded row heights** beside `--row-height` and `--height-control*`:
   `ScriptStage.ts` (32px), `logEntryStyles.ts` (26px), `NewTaskHero.ts`
   (24px), `progressAppStyles.ts` (44px), and the desktop's `styles.css` and
   `desktopShell.css` (28 to 36px). Each wants a check in both themes and
   both hosts before it takes a token.
4. **The desktop's no-project panel** (`packages/desktop/src/renderer/main.ts`)
   builds the icon surface, heading and paragraph that `renderEmptyState`
   renders. It also holds a capabilities list and a primary action, which
   the helper has no slot for; `workbenchController.ts` puts its actions
   beside the empty state, and the panel could do the same and keep only
   the list and its card frame.
5. **`TerminalOutput.ts`'s focus ring** restates the inset ring under a
   `:has(.xterm-helper-textarea:focus-visible)` selector; the rule belongs in
   `focusRingStyles` if a second canvas widget needs it.
6. **`SlashPalette.tsx` is the TUI's one cursor list outside `Select`.** It
   needs arrows that pass through to input history, Tab to complete and Esc
   left to the text input; `Select` has none of the three.
7. **`UserQuestion.tsx`'s answer row** is the pointer prompt with a
   one-row clipping wrapper; `PromptInput` could own that wrapper for
   `maxDisplayRows={1}` once an Ink render check confirms the other three
   rows do not change.

8. **`RunHeader.ts` chips hint two ways.** The forked-from chip names a
   native `title`, the ancestor chips beside it a `<wa-tooltip>`; both are
   native `<button class="run-chip">`. Pick one hint for the chip.
9. **`renderDisclosureToggle` (`wa/settingsSection.ts`)** still builds its
   own `wa-button` with a `.settings-disclosure-toggle` skin, because its
   content is a template (a name and a count). The chevron is the kit's;
   the skin is the remaining per-component one.

The 2026-11-23 run closed two entries: the run tab's expand toggle and the
script stage's Log toggle take their chevron from the button helper
(`expanded`), and the latexdiff file links are the kit's link button. Its
scan of the three hosts found no custom SVG or glyph icon in the web UI,
no color literal outside the palettes, and no TUI glyph, color or bordered
box outside `packages/cli/src/tui/ui/`.

The 2026-11-25 run rewrote entries 1, 2 and 4 to what the code holds now.
What it found and left open is in
`.agents/docs/proposed/simplification/2026-11-25-ui-kit-bypasses-left-open.md`.

## Checked and declined

- **A `useEscape` hook for the TUI.** Three standalone copies of a
  two-line `useInput` call; the hook would save a line each.
- **`renderBannerFrame` for the danger callouts** in `ProgressApp.ts`,
  `editorFileNotice.ts` and `editorPane.ts`. They are pane notices, not
  banners: the frame adds a `.banner-frame` wrapper whose styles those
  surfaces do not adopt. Only their icon disagreed, and that is fixed.
