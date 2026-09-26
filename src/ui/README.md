# TeXRA design system

`src/ui/` is the one visual system all three hosts render from. This page
holds its rules; the values live in code.

## What the UI has to say

TeXRA is an AI theorist that works with you. It proposes; you decide
(`TEXRA_TAGLINE`, `copy/onboarding.ts`). Every surface serves one of those
two halves:

- **Capable.** Show the work: the diff, the derivation, the source. Do not
  decorate it. Offer a concrete next step (starter prompts, one primary
  action) instead of a blank box.
- **In the loop.** Nothing lands without the user seeing it. Starters fill
  the composer and never send. Approvals are a visible choice
  (Ask / Block / Auto-approve), not a buried setting. Every failure the user
  must act on is shown where it happened.

## Layers

1. **Palette:** per host. The desktop has `--desktop-*` in
   `packages/desktop/src/renderer/themeTokens.css`. It carries the TeXRA
   brand:
   - warm paper surfaces;
   - aubergine ink for text;
   - the logo purple as the single interaction accent.

   The extension maps the VS Code theme in
   `packages/extension/src/common/styles/common.css`. Inside someone's
   editor, native beats branded.

2. **Bridge:** `--wa-*`. Each host sets these once from its palette. A
   component never reads a palette token.
3. **Semantic tokens:** `styles/litStyles.ts`. These are the names
   components use: `--height-button`, `--height-control-compact`,
   `--field-radius`, `--field-focus-halo`, `--row-height`, the type ramp. A
   step that differs per host reads a `--wa-*` indirection.
4. **Skins:** `styles/controlStyles.ts` and `styles/selectStyles.ts`. These
   are the only place a control's look is defined.

## The controls

- **Buttons.**
  - `.btn-primary` is the one accent fill, and a view has at most one
    (composer send included).
  - `.btn-secondary` is neutral.
  - `.btn-ghost` is the workhorse.
  - `.is-link` is prose weight, underlined.
- **Fields** (`wa-input`, `wa-select`, `wa-textarea`, the composer) have
  one shape:
  - The same height as a button on the host.
  - `--field-radius`.
  - One focus treatment: the border takes the focus color and
    `--field-focus-halo` hugs it. There is never an offset outline ring.

  `.input-plain` is the only other skin. It is a search that owns a whole
  band (the command palette), with no box and no halo.

- **Few choices, all visible.** Two to four mutually exclusive options are a
  segmented `wa-radio-group` (`appearance="button"`), with the selected
  option's one-line description under it. A dropdown is for long or dynamic
  lists.

## Rules

- **No per-component skin.** A control that needs a new look gets a skin or
  token here. A local override (a hand-rolled focus ring, a hard-coded
  height) is how three inputs ended up with three shapes.
- **One home per action** (AGENTS.md "UI anti-patterns"). Before adding a
  control, find the existing home of that action and cut the duplicate.
- **Words come from `copy/`.**
  - One name per concept across hosts.
  - No internal identifiers (run ids, camelCase agent names, "child") on
    the main surface.
- **Budgets hold.** New UI lands as its own component, not as growth in a
  file on `config/ratchets/file-size-baseline.json`.
