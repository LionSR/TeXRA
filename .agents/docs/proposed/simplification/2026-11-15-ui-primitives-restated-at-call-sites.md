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

What follows is open. Each item changes what the user sees, so it needs a
look at the rendered surface in the hosts it touches before it lands.

## 1. One-line placeholders have a class per component

`renderEmptyState` (`packages/texra/src/ui/wa/emptyState.ts`) is a hero: icon,
heading, body. `renderLoadingState` (`packages/texra/src/ui/wa/loadingState.ts`)
is a centred, padded block with a spinner. Neither fits a single muted line
inside a list or a card, so each such line has its own markup and class:

| Site                                                                   | Markup                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/texra/src/ui/progress/components/FileSelectGroup.ts`         | `.file-list-placeholder`                             |
| `packages/texra/src/ui/progress/components/StageList.ts`               | `.log-placeholder`                                   |
| `packages/texra/src/ui/settings/components/shared/SettingsCatalog.ts`  | `.catalog-empty`, twice                              |
| `packages/texra/src/ui/settings/tabs/GitTab.ts`                        | `.subscription-owner-placeholder`                    |
| `packages/texra/src/ui/settings/components/profile/ProviderKeyList.ts` | `<em class="text-secondary">`, loading               |
| `packages/texra/src/ui/settings/components/memory/MemoryItem.ts`       | `<em class="text-secondary">`, loading, error, empty |
| `packages/desktop/src/renderer/desktopCommandPalette.ts`               | `.desktop-command-palette-empty`                     |
| `packages/desktop/src/renderer/desktopShell.ts`                        | `.shell-history-empty`                               |
| `packages/desktop/src/renderer/reviewPane.ts`                          | `.desktop-review-no-results`                         |

The two loading lines also differ from every other loading state: no spinner
and no `role="status"`.

Decide first: either one inline skin in
`packages/texra/src/ui/styles/commonViewStyles.ts` (a muted line, with a
`role="status"` variant that takes `waSpinner()`), with the nine classes
deleted, or a `compact` form of the two existing helpers. The first is the
smaller interface. Swapping the two loading lines to `renderLoadingState` as
it stands was tried on paper and refused: its padding and centring would
move the layout of a key list and a memory card.

## 2. Hand-written `<button>` where a skin exists

Seven templates write a bare `<button>` with their own class. Four are rows
or tabs whose box is the component's layout and are fine as they are
(`RunTab.ts`, `BackgroundTasksPanel.ts`, `SettingsCatalog.ts`, `TeamsTab.ts`).
Three are text-weight actions that `controlStyles.ts` already has skins for:

- `packages/texra/src/ui/progress/components/DependencyBanner.ts`:
  `.tool-link` is prose weight and underlined, which is `.is-link`.
- `packages/texra/src/ui/progress/components/RunHeader.ts`: `.forked-from`
  and `.ancestor` are quiet inline actions, which is `.btn-ghost` with
  `.is-row-content` or `.is-link`.

Each has local hover and focus rules to delete with the swap.

## 3. The " — " before a detail

A description or detail after a label is joined with " — " in the TUI's
`Select` and `UserQuestion` rows, the script-call line
(`packages/texra/src/ui/copy/scriptStage.ts`), the script request summary
(`packages/texra/src/ui/copy/scriptRequest.ts`), the document-task details
and the headless progress line
(`packages/cli/src/runtime/headless/runProgressRenderer.ts`, which also
measures its width). It is the same kind of fact as `FACT_SEPARATOR` and
would sit beside it in `packages/harness/src/utils/text/stringUtils.ts`.
Left out of this PR because half the sites are JSX spans with their own
dimming, and a helper has to serve both the string and the span form.

## 4. Fixed wording that keeps its own dot

`joinFacts` joins computed facts. Titles such as `/config · Agents` (seven
in the TUI forms) and the access-route words in
`packages/cli/src/runtime/models/modelAccessRoute.ts` (`On · key required`)
are sentences and were left as literals on purpose. If the title prefix
grows, a `formTitle(command, page)` in the forms' shared frame is the owner;
it is not worth one today.
