// Desktop command palette — owns the wa-dialog shell, filter/keyboard wiring,
// and Lit render loop, plus the desktop command surface and accelerator
// formatting. Repatriated from src/shared/wa/commandPalette.ts (#8825): the
// desktop renderer is its only consumer.

import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { html, nothing, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { StreamTabId, StreamTabInfo } from '@shared/schemas';
import { isThenable } from '@utils/core';
import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandMenuEntry,
} from '../desktopCommandSurface';
import { getRendererPlatform } from './rendererPlatform';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

// Single command row. `meta` is the trailing label (an accelerator hint, an
// unavailable reason, a category, etc.). `category` is an optional, separate
// field included in the search haystack without being displayed — useful when
// `meta` is reserved for an accelerator but the row should still match
// category-name queries. `enabled === false` renders the row but disables
// click/Enter dispatch.
interface CommandPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly category?: string;
  readonly enabled: boolean;
}

interface CommandPaletteController {
  element: HTMLElement;
  open(): void;
  close(): void;
}

export interface DesktopCommandPaletteOptions {
  document: Document;
  actions: DesktopCommandActions;
  getStreams?: () => readonly StreamTabInfo[];
  platform?: NodeJS.Platform;
  // Returning false suppresses ALL palette opens — both the global
  // Cmd/Ctrl+K shortcut and any direct `controller.open()` call (e.g. while
  // a first-run walkthrough is visible).
  canOpen?: () => boolean;
}

const COMMAND_PALETTE_SHORTCUT_KEY = 'k';
const DESKTOP_SWITCH_STREAM_COMMAND_PREFIX = 'texra.desktop.switchStream:';

// Pure helpers exported for unit testing (filter/index/dispatch) — the
// test-kernel suite exercises the same source of truth the palette runs.

export function filterCommandPaletteEntries<
  T extends { id: string; label: string; meta?: string; category?: string },
>(entries: readonly T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...entries];

  const queryParts = normalizedQuery.split(/\s+/);
  return entries.filter((entry) => {
    // Include both `category` and `meta` (separated by a space) so rows that
    // reserve `meta` for an accelerator/reason can still surface by
    // category-name match. Empty/undefined fields collapse to '' and don't
    // affect matching.
    const category = entry.category ?? '';
    const meta = entry.meta ?? '';
    const haystack = `${entry.label} ${category} ${meta} ${entry.id}`
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
  if (!entry?.enabled) return false;
  // Sync handlers report their actual result; async handlers (typed-args
  // registry, #3784) return a Promise — treat that as "handled" so the
  // palette closes immediately and the work runs in the background.
  //
  // Bot review (#3818): an async handler that rejects would otherwise
  // surface as an unhandled rejection at the host. Attach a catch that
  // logs but doesn't propagate — sync handler errors still throw
  // synchronously and bubble to the caller.
  const result = onExecute(entry.id);
  if (isThenable(result)) {
    (result as Promise<boolean>).catch((error) => {
      console.error('[command-palette] async dispatch rejected', error);
    });
    return true;
  }
  return result !== false;
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === COMMAND_PALETTE_SHORTCUT_KEY &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function createDesktopCommandPalette({
  document,
  actions,
  getStreams,
  platform = getRendererPlatform(document.defaultView),
  canOpen,
}: DesktopCommandPaletteOptions): CommandPaletteController {
  const view = document.defaultView;

  const getEntries = (): CommandPaletteEntry[] => {
    const streams = actions.showStream == null ? [] : (getStreams?.() ?? []);
    return [
      ...getDesktopCommandMenuEntries(undefined, platform).map(toPaletteEntry),
      ...streams.map(toStreamPaletteEntry),
    ];
  };

  const onExecute = (id: string): boolean | Promise<boolean> =>
    dispatchDesktopPaletteCommand(id, actions);

  // Reactive state — every mutation calls renderTemplate() to keep the DOM
  // in sync. wa-dialog handles modal backdrop, focus trap, escape key, and
  // focus restoration natively, so we no longer manage those by hand.
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

  const handleFilterInput = (event: Event): void => {
    const target = event.target as WaInput | null;
    query = target?.value ?? '';
    visibleEntries = filterCommandPaletteEntries(allEntries, query);
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderTemplate();
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
    render(
      html`
        <wa-input
          class="desktop-command-palette-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Run command"
          aria-label="Run command"
          .value=${query}
          @input=${handleFilterInput}
          @keydown=${handleFilterKeydown}
        ></wa-input>
        <div class="desktop-command-palette-list" role="listbox">
          ${
            visibleEntries.length === 0
              ? html`<div class="desktop-command-palette-empty" role="status">
                  No matching commands
                </div>`
              : nothing
          }
          ${repeat(
            visibleEntries,
            (entry) => entry.id,
            (entry, index) => html`
              <button
                class="desktop-command-palette-item"
                type="button"
                role="option"
                data-command-id=${entry.id}
                ?disabled=${!entry.enabled}
                aria-selected=${index === activeIndex ? 'true' : 'false'}
                @mouseenter=${handleItemMouseEnter(index)}
                @click=${handleItemClick(entry)}
              >
                <span class="desktop-command-palette-label"
                  >${entry.label}</span
                >
                <span class="desktop-command-palette-meta"
                  >${entry.meta ?? ''}</span
                >
              </button>
            `,
          )}
        </div>
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
    query = '';
    visibleEntries = [...allEntries];
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderTemplate();
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

  // Global Cmd/Ctrl+K shortcut — must live on the document so it fires when
  // no palette descendant is focused. canOpen guards against modal dialogs
  // (e.g. the onboarding walkthrough) stealing the shortcut while visible.
  view?.addEventListener('keydown', (event) => {
    if (!isCommandPaletteShortcut(event)) return;
    if (isTextEntryShortcutTarget(view, document, event)) return;
    event.preventDefault();
    open();
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
    meta:
      stream.description ||
      stream.agent ||
      (stream.kind === 'workflowScript' ? stream.workflowName : undefined) ||
      (stream.kind === 'agent' ? stream.modelLabel : undefined) ||
      'Stream',
    category: 'Streams',
    enabled: true,
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

function toPaletteEntry(entry: DesktopCommandMenuEntry): CommandPaletteEntry {
  // Meta-column precedence: unavailableReason > accelerator > category.
  // Disabled entries surface their reason; enabled entries show the
  // keybinding when present, falling back to the catalog category.
  // `category` is always carried separately so the palette filter can match
  // it even when `meta` holds an accelerator or unavailable reason.
  return {
    id: entry.id,
    label: entry.label,
    meta: entry.unavailableReason ?? entry.accelerator ?? entry.category,
    category: entry.category,
    enabled: entry.enabled,
  };
}

function isElement(
  view: Window | null,
  target: EventTarget | null,
): target is Element {
  const elementConstructor =
    view == null
      ? undefined
      : (view as Window & { Element?: typeof Element }).Element;
  return elementConstructor != null && target instanceof elementConstructor;
}

function isTextEntryShortcutTarget(
  view: Window | null,
  document: Document,
  event: KeyboardEvent,
): boolean {
  if (event.composedPath().some((target) => isTextEntryElement(view, target))) {
    return true;
  }
  return isTextEntryElement(view, getDeepActiveElement(document));
}

function isTextEntryElement(
  view: Window | null,
  target: EventTarget | null,
): boolean {
  if (!isElement(view, target)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ) != null
  );
}

function getDeepActiveElement(document: Document): Element | null {
  let activeElement = document.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  return activeElement;
}
