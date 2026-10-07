# TeXRA design system

`packages/texra/src/ui/` is the one visual system all three hosts render from. This page
holds its rules; the values live in code.

## What the UI has to say

TeXRA is an AI theorist that works with you. It proposes; you decide
(`TEXRA_TAGLINE`, `copy/onboarding.ts`). Every surface serves one of those
two halves:

- **Capable.** Show the work: the diff, the derivation, the source. Do not
  decorate it. Offer a concrete next step (starter prompts, one primary
  action) instead of a blank box.
- **Autonomous when asked.** One vocabulary, the approval policy's:
  Ask / Block / Auto-approve. The composer's Approval chip follows the policy
  by default, or auto-approves this task alone. That can only loosen Ask:
  Block still blocks. The run header shows the switch for as long as the run
  lives, and the user can turn it off mid-run. One state (the run's
  delegated-work bypass), not a second autonomy system with its own words.
- **In the loop.** Nothing lands without the user seeing it. Starters fill
  the composer and never send. Approvals are a visible choice
  (Ask / Block / Auto-approve), not a buried setting. Every failure the user
  must act on is shown where it happened.

## Layers

1. **Palette:** per host. The desktop has `--desktop-*` in
   `packages/desktop/src/renderer/themeTokens.css`. It carries the TeXRA
   brand:
   - cool neutral surfaces;
   - neutral ink for text;
   - blue as the single interaction accent.

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
5. **Content surfaces:** `styles/surfaceStyles.ts` owns the common panel frame
   and notice layout. Requests, messages, error disclosures and callouts use
   `--panel-*` geometry and `--message-gap`; component files supply content layout.
   Transcript frames use a trailing gap only; the transcript owns its leading
   inset so margins do not stack across shadow roots.
   `styles/messageHeaderStyles.ts` groups the author and short timestamp,
   with Copy and collapse controls at the trailing edge. User, assistant and
   error messages share this geometry; the full date remains in the time tooltip.
6. **Editor adapter:** `wa/monacoTheme.ts` maps the host's resolved palette to
   Monaco. `wa/monacoOptions.ts` and `styles/monacoStyles.ts` supply shared
   typography, gutter geometry, and widget styling for source and diff surfaces.
   Do not override Monaco colors with a second CSS palette.

## The controls

- **Buttons.**
  - `.btn-primary` is the one accent fill, and a view has at most one
    (composer send included).
  - `.btn-secondary` is neutral.
  - `.btn-ghost` is the workhorse.
    Its `.is-row-content` modifier lets the enclosing navigation row own the
    background, avoiding two overlapping hover fills.
  - `.is-link` is prose weight, underlined.
- **Icons and menus.** `waIcon()` uses a square canvas. Dropdown items reserve
  one icon width and share their padding and type in `controlStyles.ts`.
  Style the `wa-dropdown-item` host: it does not expose a `base` part.
  Empty button slots must not contribute space. A dropdown host uses
  `display: contents` by default; give it a box when placing it in a grid.
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
- **Keep files small.** New UI lands as its own component, not as growth in
  an already large file.

## Desktop composition

- Use opaque surfaces: paper for content, a quiet neutral for navigation,
  and a raised surface for inputs. Shadows belong to overlays.
- At the default text size, captions are 12px, labels and controls 13px,
  conversation text 14px, section headings 16px, and page titles 20px. These
  scale with the user's font preference through the `--wa-type-*` bridge.
- Fields and labeled actions are 30px tall. Compact toolbar actions opt
  into `.is-compact` at 24px. Controls use 4–6px radii, cards 8px, and
  overlays 10px. Keep panel seams square; soften bounded controls and content.
- The toolbar opens Agent, Files and Terminal. Each is a dockable tab, alongside
  editors, previews, review and logs. The left rail owns project and task history.
  Files opens a document in an adjacent group, preserving the explorer under the
  pointer. Terminal and logs default below documents. These are starting positions,
  not fixed regions: every group can split horizontally or vertically.
- Follow-up input has at least two lines above its action row. Controls stay
  visible and use the same sizes as the new-task composer.
- Native browser views render above DOM overlays. The desktop overlay tracker
  temporarily detaches them while a dropdown or dialog is open, then restores
  their bounds on close. Keep this behavior shared by all shell menus.
- Tooltips use explicit foreground/background tokens and no pointer arrow.
  Icon-only actions include a hidden text label inside the button so their
  inner native control is named, independently of the custom-element host.
- Hover changes the surface color without moving the control. Selection
  uses the quiet accent fill and a weight, underline, or state indicator.
- Settings use a vertical category rail on desktop, with Up/Down and
  Home/End navigation. The extension keeps its horizontal tabs.
- Define all three Web Awesome variant levels (`quiet`, `normal`, `loud`).
  Leaving `normal` unmapped lets native controls fall back to a different
  palette even when the custom button skins look correct.

## Desktop workspace composition

Dockview owns the recursive grid and serializes it per project. Content owners
retain their editor models, PTYs, browser views and conversation while tabs move.
The dock adapter maps all visual tokens to TeXRA; do not add a second palette.
Group menus offer splits and maximize/restore. Tab menus offer moves and closure;
dragging a tab to any group edge creates a split. Opening a new task reveals Agent
without replacing document groups. The Theme preference lives in Settings > General

> Appearance. All Electron verification uses isolated, offscreen windows.
