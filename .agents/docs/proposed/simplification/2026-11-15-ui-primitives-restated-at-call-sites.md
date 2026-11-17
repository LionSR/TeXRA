# UI primitives restated at call sites: what the 2026-11-15 audit left

Date: 2026-11-15
Status: proposed
Origin: the scheduled UI-consistency audit of 2026-11-15, on `main` at
`1dd278b`. The same PR lands three of its findings: `joinFacts` and
`FACT_SEPARATOR` own the " · " between facts in every host, `waSpinner()`
writes every `<wa-spinner>`, and the TUI footers share `CLOSE_HINT`,
`ENTER_OR_ESC_CLOSE_HINTS` and the arrow-key labels. The audit also checked
the icon set (every web icon goes through `waIcon()` and the Font Awesome
resolver; no inline SVG, codicon class or `fa-` class is left), inline
`style="…"` attributes (none), hex colors in component styles (none) and the
TUI's bordered boxes (the two that bypass `BorderedPanel` are a top rule and
the input box, neither a panel). Those are clean.

Items 1 to 3 have landed: #14957 added `renderEmptyMessage` and moved most
one-line placeholders onto it, and the 2026-11-17 audit finished the rest.
That run moved the memory card's three lines, the key list's loading line and
the desktop's empty task history onto `renderEmptyMessage`; made
`.clickable-link` (`packages/texra/src/ui/styles/commonViewStyles.ts`) the one
look for a text link, native button included, in place of the dependency
banner's `.tool-link`, the proposal panel's file names, the log's
`.file-link` copy and the inquiry panel's anchors; gave the run header's fork
and ancestor chips one `.run-chip` rule; and added `DETAIL_SEPARATOR` beside
`FACT_SEPARATOR` for every " — " between a label and its detail.

Left on purpose: GitTab's "Started by an agent that is no longer active." is
a status sentence inside an owner row, not an empty list, and keeps its
left-aligned class. The run header's two chips stay local: no other surface
draws a chip that navigates.

What follows is open.

## 4. Fixed wording that keeps its own dot

`joinFacts` joins computed facts. Titles such as `/config · Agents` (seven
in the TUI forms) and the access-route words in
`packages/cli/src/runtime/models/modelAccessRoute.ts` (`On · key required`)
are sentences and were left as literals on purpose. If the title prefix
grows, a `formTitle(command, page)` in the forms' shared frame is the owner;
it is not worth one today.
