// Desktop command palette: owns the wa-dialog shell, filter/keyboard wiring,
// and Lit render loop over the desktop command surface and its accelerator
// formatting.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import { html, nothing, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type { IconName } from '@ui/wa/iconNames';
import { renderEmptyMessage } from '@ui/wa/emptyState';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { formatDesktopAccelerator } from '../shared/accelerators';
import type { OsPlatform } from '@texra/shared/osPlatform';
import {
  dispatchDesktopCommand,
  paletteEntries,
  type DesktopCommandActions,
} from '../shared/desktopCommandSurface';

// Single row: a command, or a project the Switch Project command lists. `meta` is the trailing label (an accelerator hint, a
// category, etc.). `category` is an optional, separate field included in the
// search haystack without being displayed — useful when `meta` is reserved for
// an accelerator but the row should still match category-name queries.
interface CommandPaletteEntry {
  /** Unique among the rows shown together. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly meta?: string;
  readonly category?: string;
  run(): void;
}

/** One list the palette shows: its rows and the words around them. */
interface CommandPaletteList {
  readonly entries: readonly CommandPaletteEntry[];
  readonly searchLabel: string;
  /** Shown when the list has no rows at all, before any filtering. */
  readonly emptyLabel: string;
  readonly noMatchLabel: string;
}

const NO_LIST: CommandPaletteList = {
  entries: [],
  searchLabel: 'Search commands',
  emptyLabel: 'No matching commands',
  noMatchLabel: 'No matching commands',
};

/** A project the palette can switch to. */
interface PaletteProject {
  /** The project's folder, which is also its key. */
  readonly key: string;
  readonly name: string;
}

interface CommandPaletteController {
  element: HTMLElement;
  open(): void;
  /** Lists `projects` in place of the commands; choosing one runs `select`.
   *  Opens the palette when it is closed. */
  showProjects(
    projects: readonly PaletteProject[],
    select: (key: string) => void,
  ): void;
}

interface DesktopCommandPaletteOptions {
  document: Document;
  actions: DesktopCommandActions;
  platform: OsPlatform;
}

// Combobox wiring lives on the wa-input HOST, not its shadow input: ARIA
// IDREFs (aria-controls/aria-activedescendant) cannot cross the shadow
// boundary out to the light-DOM listbox, and wa-input delegates focus from
// the host, so the host is where the combobox semantics resolve.
const COMMAND_PALETTE_LIST_ID = 'desktop-command-palette-list';

function commandPaletteOptionId(entryId: string): string {
  return `desktop-command-palette-option-${entryId}`;
}

function filterCommandPaletteEntries(
  entries: readonly CommandPaletteEntry[],
  query: string,
): CommandPaletteEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...entries];

  const queryParts = normalizedQuery.split(/\s+/);
  return entries.filter((entry) => {
    // Include both `category` and `meta` (separated by a space) so rows that
    // reserve `meta` for an accelerator/reason can still surface by
    // category-name match. Empty/undefined fields collapse to '' and don't
    // affect matching.
    const haystack =
      `${entry.label} ${entry.category ?? ''} ${entry.meta ?? ''} ${entry.id}`
        .replaceAll('.', ' ')
        .toLowerCase();
    return queryParts.every((part) => haystack.includes(part));
  });
}

function getNextCommandPaletteIndex(
  currentIndex: number,
  itemCount: number,
  delta: number,
): number {
  if (itemCount <= 0) return -1;
  return (currentIndex + delta + itemCount) % itemCount;
}

export function createDesktopCommandPalette({
  document,
  actions,
  platform,
}: DesktopCommandPaletteOptions): CommandPaletteController {
  const commandList = (): CommandPaletteList => ({
    ...NO_LIST,
    entries: paletteEntries(platform).map((entry) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      meta: formatDesktopAccelerator(entry.accelerator, platform),
      category: entry.category,
      run: () => dispatchDesktopCommand(entry.id, actions),
    })),
  });

  // Reactive state: every mutation calls renderTemplate() to keep the DOM in
  // sync. wa-dialog handles modal backdrop, focus trap, escape key, and focus
  // restoration natively, so none of those are managed here.
  let list = NO_LIST;
  let visibleEntries: CommandPaletteEntry[] = [];
  let activeIndex = -1;
  let query = '';

  const dialog = document.createElement('wa-dialog');
  dialog.classList.add('desktop-command-palette');
  dialog.withoutHeader = true;
  dialog.lightDismiss = true;
  dialog.setAttribute('aria-label', 'Command palette');

  /** Runs a row, then closes the palette unless the row put another list
   *  in it, as Switch Project does. */
  const runEntry = (entry: CommandPaletteEntry | undefined): void => {
    if (!entry) return;
    const shown = list;
    entry.run();
    if (list === shown) close();
  };

  const applyQuery = (nextQuery: string): void => {
    query = nextQuery;
    visibleEntries = filterCommandPaletteEntries(list.entries, query);
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderTemplate();
  };

  const handleFilterInput = (event: Event): void => {
    applyQuery(
      event.target instanceof WaInput ? (event.target.value ?? '') : '',
    );
  };

  const handleFilterKeydown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        activeIndex = getNextCommandPaletteIndex(
          activeIndex,
          visibleEntries.length,
          delta,
        );
        renderTemplate();
        scrollActiveItemIntoView();
        break;
      }
      case 'Enter':
        event.preventDefault();
        runEntry(visibleEntries[activeIndex]);
        break;
    }
  };

  const handleItemMouseEnter = (index: number) => (): void => {
    activeIndex = index;
    renderTemplate();
  };

  const renderTemplate = (): void => {
    const groups = [
      ...Map.groupBy(visibleEntries, (entry) => entry.category ?? 'Other'),
    ];
    const activeEntry =
      activeIndex >= 0 ? visibleEntries[activeIndex] : undefined;
    render(
      html`
        <div class="desktop-command-palette-search">
          ${waIcon('magnifying-glass', {
            className: 'desktop-command-palette-search-icon',
          })}
          <wa-input
            class="desktop-command-palette-input input-plain"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder=${list.searchLabel}
            aria-label=${list.searchLabel}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls=${COMMAND_PALETTE_LIST_ID}
            aria-activedescendant=${
              activeEntry ? commandPaletteOptionId(activeEntry.id) : nothing
            }
            .value=${query}
            @input=${handleFilterInput}
            @keydown=${handleFilterKeydown}
          ></wa-input>
          <kbd class="desktop-command-palette-key">Esc</kbd>
        </div>
        <div
          class="desktop-command-palette-list"
          id=${COMMAND_PALETTE_LIST_ID}
          role="listbox"
          aria-label="Commands"
        >
          ${
            visibleEntries.length === 0
              ? renderEmptyMessage(
                  list.entries.length === 0
                    ? list.emptyLabel
                    : list.noMatchLabel,
                )
              : nothing
          }
          ${groups.map(
            ([category, categoryEntries]) => html`
              <section
                class="desktop-command-palette-group"
                aria-labelledby=${`command-group-${slugify(category)}`}
              >
                <h2
                  id=${`command-group-${slugify(category)}`}
                  class="desktop-command-palette-group-label overline"
                >
                  ${category}
                </h2>
                ${repeat(
                  categoryEntries,
                  (entry) => entry.id,
                  (entry) => {
                    const index = visibleEntries.indexOf(entry);
                    return html`
                      <wa-button
                        class="desktop-command-palette-item"
                        id=${commandPaletteOptionId(entry.id)}
                        type="button"
                        appearance="plain"
                        size="s"
                        role="option"
                        data-command-id=${entry.id}
                        aria-selected=${
                          index === activeIndex ? 'true' : 'false'
                        }
                        tabindex="-1"
                        @mouseenter=${handleItemMouseEnter(index)}
                        @click=${() => runEntry(entry)}
                      >
                        <span class="desktop-command-palette-main">
                          <span class="desktop-command-palette-item-icon">
                            ${waIcon(entry.icon)}
                          </span>
                          <span class="desktop-command-palette-copy">
                            <span class="desktop-command-palette-label">
                              ${entry.label}
                            </span>
                          </span>
                        </span>
                        ${
                          entry.meta
                            ? html`<kbd
                                slot="end"
                                class="desktop-command-palette-meta"
                                >${entry.meta}</kbd
                              >`
                            : nothing
                        }
                      </wa-button>
                    `;
                  },
                )}
              </section>
            `,
          )}
        </div>
        <footer class="desktop-command-palette-footer">
          <div class="desktop-command-palette-help" aria-hidden="true">
            <span><kbd>↑↓</kbd> Navigate</span>
            <span><kbd>↵</kbd> Open</span>
          </div>
        </footer>
      `,
      dialog,
    );
  };

  const scrollActiveItemIntoView = (): void => {
    const items = dialog.querySelectorAll<HTMLElement>(
      '.desktop-command-palette-item',
    );
    items.item(activeIndex)?.scrollIntoView({ block: 'nearest' });
  };

  const show = (next: CommandPaletteList): void => {
    list = next;
    applyQuery('');
    if (dialog.open) focusFilter();
    else dialog.open = true;
  };

  const open = (): void => {
    if (!dialog.open) show(commandList());
  };

  const showProjects: CommandPaletteController['showProjects'] = (
    projects,
    select,
  ) =>
    show({
      entries: projects.map(({ key, name }) => ({
        id: key,
        label: name,
        icon: 'folder',
        category: 'Open projects',
        run: () => select(key),
      })),
      searchLabel: 'Search open projects',
      emptyLabel: 'No other project is open',
      noMatchLabel: 'No matching projects',
    });

  const close = (): void => {
    if (!dialog.open) return;
    dialog.open = false;
  };

  // wa-dialog focuses its first focusable child on show. Override that to
  // focus the filter input directly so users can start typing immediately.
  const focusFilter = (): void => {
    dialog.querySelector<WaInput>('.desktop-command-palette-input')?.focus();
  };
  dialog.addEventListener('wa-after-show', focusFilter);

  renderTemplate();
  return { element: dialog, open, showProjects };
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');
}
