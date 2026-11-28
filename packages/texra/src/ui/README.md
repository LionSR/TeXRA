# TeXRA design system

`packages/texra/src/ui/` is the one visual system all three hosts render from. This page
holds its rules; the values live in code.

## What the UI has to say

TeXRA is an AI theorist, and it is trusted to do the work. The interface
is for the person: to follow what is happening and to step in, not to
supervise each step. Every surface serves one of these:

- **Trust the model.** Commands and edits run without asking by default
  (the approval policy's Auto-approve); a person narrows it to Ask.
  Add no control whose job is to tune or second-guess what the model decides
  for itself: which tool, which model for a sub-agent, how hard to think. A
  request for a person is the exception, and it is shown where the
  conversation ends.
- **Results first.** A finished turn shows its message, what it changed and
  its answer; how it got there is one click away. When the work is shown, it
  is the work itself: the diff, the derivation, the source, undecorated.
- **Made for the person.** The rail, the statuses and the usage meters
  answer a person's questions: what is running, what needs me, what
  finished, what it costs. Autonomy has one vocabulary, the approval
  policy's: Ask / Auto-approve, set in Settings. Under Ask, a request card
  grants a kind of work for the task, and the run header shows that grant
  for as long as the run lives. Every failure the person must act on is shown where
  it happened.

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
   The transcript reads as a conversation, not a log. A person's message is
   a bubble at the trailing edge and an answer is its text on the page, so
   neither carries an author line; its time and its Copy and Fork actions
   sit on the line under it, shown on hover or focus
   (`messageMetaStyles` in `styles/messageHeaderStyles.ts`). A tool call or
   a thought is one unframed line (icon, what it did, what to) that opens
   in place. Only an error with details keeps a framed header.
   Two groups keep a long run readable, both computed from the rows
   (`progress/turnLayout.ts`) and closed until opened: consecutive finished
   calls read as one sentence ("Read 3 files and ran 1 command"), and a
   finished turn's work stands behind "Worked for 1m 3s", leaving the
   message and its answer. The turn the run is working on stays open, and
   so does a call still running.
6. **Canvas widgets:** xterm.js and Monaco draw on a canvas and cannot read a
   CSS token. `wa/cssTokenColor.ts` is the one reading of a token as the color
   the host paints; `wa/xtermTheme.ts` and the desktop's
   `packages/desktop/src/renderer/monacoTheme.ts` build their themes from it.
   The desktop's `monacoOptions.ts` and `monacoStyles.ts` beside it supply
   typography, gutter geometry and widget styling for source and diff
   surfaces. Do not override Monaco colors with a second CSS palette.

## The controls

- **Buttons.**
  - `.btn-primary` is the one accent fill, and a view has at most one
    (composer send included).
  - `.btn-secondary` is neutral.
  - `.btn-ghost` is the workhorse.
    Its `.is-row-content` modifier lets the enclosing navigation row own the
    background, avoiding two overlapping hover fills.
  - `.is-link` is prose weight, underlined.
- **One icon per action.** The same action shows the same icon on every
  host: refresh or check again `arrows-rotate`; retry, restart or update
  `rotate-right`; reset to a default `arrow-rotate-left`; export
  `file-export`; open outside TeXRA `arrow-up-right-from-square`; dismiss
  or remove from a list `xmark`; delete what is stored `trash`; stop
  `circle-stop`; an error or failure notice `circle-exclamation`, a warning
  `triangle-exclamation` (`TONE_GLYPH`, `copy/runStatus.ts`). A log level's icon
  and word come from `copy/logLevels.ts`, a run status's from
  `copy/runStatus.ts`.
- **Status badges.** A badge or tag that shows a status takes its variant
  from the status's tone (`toneVariant`, `wa/waVariant.ts`) and its glyph
  from `statusGlyph`; it names neither directly.
- **File links.** A file path that opens its file is `buildFileLinkSpan`,
  and the view's delegated click reads it with `fileLinkTarget`
  (`progress/formatters/htmlBuilders.ts`).
- **Fact separators.** Facts on one line are joined by `joinFacts` when they
  are strings and by `factDot()` (`wa/factDot.ts`) when they are elements.
- **Disclosure toggles.** A button that opens a section passes `expanded`
  and names no icon: the helper draws the chevron, which turns while open.
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

- **Drop targets.** A file drop zone takes `.is-drag-active` from its
  `FileDropController` and the one skin in `dropTargetStyles`
  (`styles/commonViewStyles.ts`); it never paints its own drag outline.
- **Few choices, all visible.** Two to four mutually exclusive options are a
  segmented `wa-radio-group` (`appearance="button"`), with the selected
  option's one-line description under it. A dropdown is for long or dynamic
  lists.

## Rules

- **No per-component skin.** A control that needs a new look gets a skin or
  token here, never a local override (a hand-rolled focus ring, a hard-coded
  height).
- **One home per action** (AGENTS.md "UI anti-patterns"). Before adding a
  control, find the existing home of that action and cut the duplicate.
- **Words come from `copy/`.**
  - One name per concept across hosts.
  - No internal identifiers (run ids, camelCase agent names, "child") on
    the main surface.
- **Keep files small.** New UI lands as its own component, not as growth in
  an already large file.
- **Inline templates stay on one line.** Lit keeps a template's whitespace,
  so a template whose text is inline (a label, a badge, a path) is written
  on one line under `// prettier-ignore`; indenting it across lines puts
  spaces into the rendered text.

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
without replacing document groups. The Theme preference lives in Settings →
General → Appearance. All Electron verification uses isolated, offscreen
windows.
