import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { html, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandMenuEntry,
} from '../desktopCommandSurface';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

export interface DesktopCommandPaletteOptions {
  document: Document;
  actions: DesktopCommandActions;
  platform?: NodeJS.Platform;
  canOpen?: () => boolean;
}

export interface DesktopCommandPaletteController {
  element: HTMLElement;
  open(): void;
  close(): void;
}

const COMMAND_PALETTE_SHORTCUT_KEY = 'k';

export function filterDesktopCommandPaletteEntries(
  entries: readonly DesktopCommandMenuEntry[],
  query: string,
): DesktopCommandMenuEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...entries];

  const queryParts = normalizedQuery.split(/\s+/);
  return entries.filter((entry) => {
    const searchable = `${entry.label} ${entry.category} ${entry.id}`
      .replaceAll('.', ' ')
      .toLowerCase();
    return queryParts.every((part) => searchable.includes(part));
  });
}

export function getNextDesktopCommandPaletteIndex(
  currentIndex: number,
  itemCount: number,
  delta: number,
): number {
  if (itemCount <= 0) return -1;
  return (currentIndex + delta + itemCount) % itemCount;
}

export function executeDesktopCommandPaletteEntry(
  entry: DesktopCommandMenuEntry | undefined,
  actions: DesktopCommandActions,
): boolean {
  if (!entry?.enabled) return false;
  return dispatchDesktopCommand(entry.id, actions);
}

export function createDesktopCommandPalette({
  document,
  actions,
  platform = getRendererPlatform(document.defaultView),
  canOpen,
}: DesktopCommandPaletteOptions): DesktopCommandPaletteController {
  const view = document.defaultView;
  const entries = getDesktopCommandMenuEntries(undefined, platform);

  // Reactive state — every mutation calls renderTemplate() to keep the DOM
  // in sync. wa-dialog handles modal backdrop, focus trap, escape key, and
  // focus restoration natively, so we no longer manage those by hand.
  let visibleEntries: DesktopCommandMenuEntry[] = [...entries];
  let activeIndex = entries.length > 0 ? 0 : -1;
  let query = '';

  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add('desktop-command-palette');
  dialog.withoutHeader = true;
  dialog.lightDismiss = true;
  dialog.setAttribute('aria-label', 'Command palette');

  const executeActiveCommand = (): void => {
    const entry = visibleEntries[activeIndex];
    if (executeDesktopCommandPaletteEntry(entry, actions)) close();
  };

  const handleFilterInput = (event: Event): void => {
    const target = event.target as WaInput | null;
    query = target?.value ?? '';
    visibleEntries = filterDesktopCommandPaletteEntries(entries, query);
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderTemplate();
  };

  const handleFilterKeydown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        activeIndex = getNextDesktopCommandPaletteIndex(
          activeIndex,
          visibleEntries.length,
          1,
        );
        renderTemplate();
        scrollActiveItemIntoView();
        break;
      case 'ArrowUp':
        event.preventDefault();
        activeIndex = getNextDesktopCommandPaletteIndex(
          activeIndex,
          visibleEntries.length,
          -1,
        );
        renderTemplate();
        scrollActiveItemIntoView();
        break;
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

  const handleItemClick = (entry: DesktopCommandMenuEntry) => (): void => {
    if (executeDesktopCommandPaletteEntry(entry, actions)) close();
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
                <span class="desktop-command-palette-meta">
                  ${entry.unavailableReason ??
                  entry.accelerator ??
                  entry.category}
                </span>
              </button>
            `,
          )}
        </div>
      `,
      dialog,
    );
  };

  const scrollActiveItemIntoView = (): void => {
    const items = dialog.querySelectorAll<HTMLButtonElement>(
      '.desktop-command-palette-item',
    );
    items.item(activeIndex)?.scrollIntoView({ block: 'nearest' });
  };

  const open = (): void => {
    if (canOpen?.() === false) return;
    if (dialog.open) return;
    query = '';
    visibleEntries = [...entries];
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
    const input = dialog.querySelector<WaInput>(
      '.desktop-command-palette-input',
    );
    input?.focus();
  });

  // Global Cmd/Ctrl+K shortcut — must live on the document so it fires when
  // no palette descendant is focused. canOpen guards against the onboarding
  // dialog stealing the shortcut while it's visible.
  document.defaultView?.addEventListener('keydown', (event) => {
    if (!isCommandPaletteShortcut(event)) return;
    if (isTextEntryShortcutTarget(view, document, event)) return;
    event.preventDefault();
    open();
  });

  renderTemplate();
  return { element: dialog, open, close };
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === COMMAND_PALETTE_SHORTCUT_KEY &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

function getRendererPlatform(view: Window | null): NodeJS.Platform {
  const platform = view?.navigator.platform.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  return 'linux';
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
