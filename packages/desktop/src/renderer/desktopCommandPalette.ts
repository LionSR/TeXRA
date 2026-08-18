// Desktop command palette: owns the wa-dialog shell, filter/keyboard wiring,
// and Lit render loop over the desktop command surface and its accelerator
// formatting.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { html, nothing, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { StreamTabId, StreamTabInfo } from '@shared/schemas';
import { formatDesktopAccelerator } from '@shared/commands/accelerators';
import type { DesktopShortcutEntry } from '@shared/commands/shortcutPreferences';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { groupBy, isThenable } from '@utils/core';
import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandMenuEntry,
} from '../shared/desktopCommandSurface';
import { getRendererPlatform } from './rendererPlatform';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

// Single command row. `meta` is the trailing label (an accelerator hint, a
// category, etc.). `category` is an optional, separate field included in the
// search haystack without being displayed — useful when `meta` is reserved for
// an accelerator but the row should still match category-name queries.
interface CommandPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon: TeXRAIconName;
  readonly meta?: string;
  readonly category?: string;
}

interface CommandPaletteGroup {
  readonly category: string;
  readonly entries: readonly CommandPaletteEntry[];
}

export interface CommandPaletteController {
  element: HTMLElement;
  open(): void;
  close(): void;
}

export interface DesktopCommandPaletteOptions {
  document: Document;
  actions: DesktopCommandActions;
  getStreams?: () => readonly StreamTabInfo[];
  getShortcuts?: () => readonly DesktopShortcutEntry[];
  platform?: NodeJS.Platform;
  // Returning false suppresses ALL palette opens — both the global
  // Cmd/Ctrl+K shortcut and any direct `controller.open()` call (e.g. while
  // a first-run walkthrough is visible).
  canOpen?: () => boolean;
}

const DESKTOP_SWITCH_STREAM_COMMAND_PREFIX = 'texra.desktop.switchStream:';

// Combobox wiring lives on the wa-input HOST, not its shadow input: ARIA
// IDREFs (aria-controls/aria-activedescendant) cannot cross the shadow
// boundary out to the light-DOM listbox, and wa-input delegates focus from
// the host, so the host is where the combobox semantics resolve.
const COMMAND_PALETTE_LIST_ID = 'desktop-command-palette-list';

function commandPaletteOptionId(entryId: string): string {
  return `desktop-command-palette-option-${entryId}`;
}

// Pure helpers exported for unit testing (filter/index/dispatch) — the
// test-kernel suite exercises the same source of truth the palette runs.

export function filterCommandPaletteEntries<
  T extends {
    id: string;
    label: string;
    description?: string;
    meta?: string;
    category?: string;
  },
>(entries: readonly T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...entries];

  const queryParts = normalizedQuery.split(/\s+/);
  return entries.filter((entry) => {
    // Include both `category` and `meta` (separated by a space) so rows that
    // reserve `meta` for an accelerator/reason can still surface by
    // category-name match. Empty/undefined fields collapse to '' and don't
    // affect matching.
    const haystack =
      `${entry.label} ${entry.description ?? ''} ${entry.category ?? ''} ${entry.meta ?? ''} ${entry.id}`
        .replaceAll('.', ' ')
        .toLowerCase();
    return queryParts.every((part) => haystack.includes(part));
  });
}

export function getNextCommandPaletteIndex(
  currentIndex: number,
  itemCount: number,
  delta: number,
): number {
  if (itemCount <= 0) return -1;
  return (currentIndex + delta + itemCount) % itemCount;
}

export function executeCommandPaletteEntry(
  entry: CommandPaletteEntry | undefined,
  onExecute: (id: string) => boolean | Promise<boolean>,
): boolean {
  if (!entry) return false;
  // Sync handlers report their actual result; an async handler returns a
  // Promise, which counts as "handled" so the palette closes immediately and
  // the work runs in the background. That background rejection would surface
  // as an unhandled rejection at the host, so log it here without
  // propagating; sync handler errors still throw and bubble to the caller.
  const result = onExecute(entry.id);
  if (isThenable(result)) {
    (result as Promise<boolean>).catch((error) => {
      console.error('[command-palette] async dispatch rejected', error);
    });
    return true;
  }
  return result !== false;
}

export function createDesktopCommandPalette({
  document,
  actions,
  getStreams,
  getShortcuts,
  platform = getRendererPlatform(document.defaultView),
  canOpen,
}: DesktopCommandPaletteOptions): CommandPaletteController {
  const getEntries = (): CommandPaletteEntry[] => {
    const streams = actions.showStream == null ? [] : (getStreams?.() ?? []);
    const shortcutsById = new Map(
      (getShortcuts?.() ?? []).map((entry) => [entry.id, entry]),
    );
    return [
      ...getDesktopCommandMenuEntries(platform).map((entry) =>
        toPaletteEntry(entry, shortcutsById.get(entry.id), platform),
      ),
      ...streams.map(toStreamPaletteEntry),
    ];
  };

  const onExecute = (id: string): boolean | Promise<boolean> =>
    dispatchDesktopPaletteCommand(id, actions);

  // Reactive state: every mutation calls renderTemplate() to keep the DOM in
  // sync. wa-dialog handles modal backdrop, focus trap, escape key, and focus
  // restoration natively, so none of those are managed here.
  let allEntries: CommandPaletteEntry[] = [];
  let visibleEntries: CommandPaletteEntry[] = [];
  let activeIndex = -1;
  let query = '';

  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add('desktop-command-palette');
  dialog.withoutHeader = true;
  dialog.lightDismiss = true;
  dialog.setAttribute('aria-label', 'Command palette');

  const executeActiveCommand = (): void => {
    const entry = visibleEntries[activeIndex];
    if (executeCommandPaletteEntry(entry, onExecute)) close();
  };

  const applyQuery = (nextQuery: string): void => {
    query = nextQuery;
    visibleEntries = filterCommandPaletteEntries(allEntries, query);
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderTemplate();
  };

  const handleFilterInput = (event: Event): void => {
    const target = event.target as WaInput | null;
    applyQuery(target?.value ?? '');
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
        executeActiveCommand();
        break;
      default:
        break;
    }
  };

  const handleItemMouseEnter = (index: number) => (): void => {
    activeIndex = index;
    renderTemplate();
  };

  const handleItemClick = (entry: CommandPaletteEntry) => (): void => {
    if (executeCommandPaletteEntry(entry, onExecute)) close();
  };

  const renderTemplate = (): void => {
    const groups = groupCommandPaletteEntries(visibleEntries);
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
            placeholder="Search commands"
            aria-label="Search commands"
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
              ? html`<div class="desktop-command-palette-empty" role="status">
                  No matching commands
                </div>`
              : nothing
          }
          ${groups.map(
            (group) => html`
              <section
                class="desktop-command-palette-group"
                aria-labelledby=${`command-group-${slugify(group.category)}`}
              >
                <h2
                  id=${`command-group-${slugify(group.category)}`}
                  class="desktop-command-palette-group-label"
                >
                  ${group.category}
                </h2>
                ${repeat(
                  group.entries,
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
                        @click=${handleItemClick(entry)}
                      >
                        <span class="desktop-command-palette-main">
                          <span class="desktop-command-palette-item-icon">
                            ${waIcon(entry.icon)}
                          </span>
                          <span class="desktop-command-palette-copy">
                            <span class="desktop-command-palette-label">
                              ${entry.label}
                            </span>
                            ${
                              entry.description
                                ? html`<span
                                    class="desktop-command-palette-description"
                                    >${entry.description}</span
                                  >`
                                : nothing
                            }
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
          <wa-button
            class="desktop-command-palette-customize"
            appearance="plain"
            size="s"
            @click=${() => {
              close();
              actions.showSettings('shortcuts');
            }}
          >
            ${waIcon('code', { slot: 'start' })} Customize shortcuts
          </wa-button>
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

  const open = (): void => {
    if (canOpen?.() === false) return;
    if (dialog.open) return;
    allEntries = getEntries();
    applyQuery('');
    dialog.open = true;
  };

  const close = (): void => {
    if (!dialog.open) return;
    dialog.open = false;
  };

  // wa-dialog focuses its first focusable child on show. Override that to
  // focus the filter input directly so users can start typing immediately.
  dialog.addEventListener('wa-after-show', () => {
    dialog.querySelector<WaInput>('.desktop-command-palette-input')?.focus();
  });

  renderTemplate();
  return { element: dialog, open, close };
}

function dispatchDesktopPaletteCommand(
  id: string,
  actions: DesktopCommandActions,
): boolean | Promise<boolean> {
  const streamId = parseSwitchStreamCommandId(id);
  if (streamId != null) {
    if (!actions.showStream) return false;
    actions.showStream(streamId);
    return true;
  }
  return dispatchDesktopCommand(id as DesktopCommandMenuEntry['id'], actions);
}

function toStreamPaletteEntry(stream: StreamTabInfo): CommandPaletteEntry {
  return {
    id: buildSwitchStreamCommandId(stream.name),
    label: `Switch to ${stream.label || stream.name}`,
    description:
      stream.description ||
      (stream.identity?.kind === 'multiAgentWorkflow'
        ? stream.identity.workflowName
        : undefined) ||
      (stream.identity?.kind === 'agent'
        ? stream.identity.agent || stream.modelLabel
        : undefined) ||
      (stream.identity?.kind === 'process'
        ? stream.command || stream.identity.tool
        : undefined) ||
      'Stream',
    icon: 'terminal',
    category: 'Streams',
  };
}

function buildSwitchStreamCommandId(streamId: StreamTabId): string {
  return `${DESKTOP_SWITCH_STREAM_COMMAND_PREFIX}${streamId}`;
}

function parseSwitchStreamCommandId(id: string): StreamTabId | undefined {
  if (!id.startsWith(DESKTOP_SWITCH_STREAM_COMMAND_PREFIX)) return undefined;
  const streamId = id.slice(DESKTOP_SWITCH_STREAM_COMMAND_PREFIX.length);
  return streamId || undefined;
}

function toPaletteEntry(
  entry: DesktopCommandMenuEntry,
  shortcut: DesktopShortcutEntry | undefined,
  platform: NodeJS.Platform,
): CommandPaletteEntry {
  return {
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    meta: formatDesktopAccelerator(
      shortcut?.accelerator ?? entry.accelerator,
      platform,
    ),
    category: entry.category,
  };
}

function groupCommandPaletteEntries(
  entries: readonly CommandPaletteEntry[],
): CommandPaletteGroup[] {
  const grouped = groupBy(entries, (entry) => entry.category ?? 'Other');
  return [...grouped].map(([category, groupEntries]) => ({
    category,
    entries: groupEntries,
  }));
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');
}
