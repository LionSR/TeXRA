// Host-neutral command palette. Both the Electron renderer and (eventually)
// the VS Code webview drive this with their own command surfaces — the helper
// owns the wa-dialog shell, filter/keyboard wiring, and Lit render loop.
//
// Stays inside `src/shared/wa/` per CLAUDE.md "VS Code-free zones": no
// `vscode` imports, no `@commands/catalog`, no Electron / Node-specific APIs.
// Hosts pre-resolve their command list (labels, accelerators, enablement)
// and pass it in alongside an onExecute dispatcher and an optional canOpen
// guard.

import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { html, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

// Single command row. `meta` is the trailing label (host-defined: an
// accelerator hint, an unavailable reason, a category, etc.) so the palette
// stays opinion-free about how hosts format that column. `category` is an
// optional, separate field that hosts can include in the search haystack
// without displaying — useful when `meta` is reserved for an accelerator
// but the row should still match category-name queries. `enabled === false`
// renders the row but disables click/Enter dispatch.
export interface CommandPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly category?: string;
  readonly enabled: boolean;
}

export interface CommandPaletteOptions {
  readonly document: Document;
  readonly entries: readonly CommandPaletteEntry[];
  readonly onExecute: (id: string) => boolean;
  // Returning false suppresses ALL palette opens — both the global
  // Cmd/Ctrl+K shortcut and any direct `controller.open()` call (e.g. while
  // a first-run walkthrough is visible). The guard runs at the entry of
  // open(), so hosts that want shortcut-only suppression should pass a
  // custom `isShortcut` instead.
  readonly canOpen?: () => boolean;
  // Override the host shortcut (defaults to Cmd/Ctrl+K). Hosts that already
  // own a global keybinding manager can pass `null` to disable the helper's
  // window-level listener entirely.
  readonly isShortcut?: ((event: KeyboardEvent) => boolean) | null;
  // Optional CSS hooks. Hosts wire these to their own theming (e.g. the
  // .desktop-command-palette-* classes the desktop renderer already styles).
  readonly classes?: CommandPaletteClassNames;
  readonly ariaLabel?: string;
}

export interface CommandPaletteClassNames {
  readonly dialog?: string;
  readonly input?: string;
  readonly list?: string;
  readonly item?: string;
  readonly label?: string;
  readonly meta?: string;
}

export interface CommandPaletteController {
  element: HTMLElement;
  open(): void;
  close(): void;
}

const COMMAND_PALETTE_SHORTCUT_KEY = 'k';

// Pure helpers exported for unit testing (filter/index/dispatch). Live in the
// shared module so both the host wrappers and the test-kernel suite re-export
// the same source of truth.

export function filterCommandPaletteEntries<
  T extends { id: string; label: string; meta?: string; category?: string },
>(entries: readonly T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...entries];

  const queryParts = normalizedQuery.split(/\s+/);
  return entries.filter((entry) => {
    // Include both `category` and `meta` (separated by a space) so hosts that
    // reserve `meta` for an accelerator/reason can still surface a row by
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
  onExecute: (id: string) => boolean,
): boolean {
  if (!entry?.enabled) return false;
  return onExecute(entry.id);
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === COMMAND_PALETTE_SHORTCUT_KEY &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function createCommandPalette({
  document,
  entries,
  onExecute,
  canOpen,
  isShortcut = isCommandPaletteShortcut,
  classes,
  ariaLabel = 'Command palette',
}: CommandPaletteOptions): CommandPaletteController {
  const view = document.defaultView;

  // Reactive state — every mutation calls renderTemplate() to keep the DOM
  // in sync. wa-dialog handles modal backdrop, focus trap, escape key, and
  // focus restoration natively, so we no longer manage those by hand.
  let visibleEntries: CommandPaletteEntry[] = [...entries];
  let activeIndex = entries.length > 0 ? 0 : -1;
  let query = '';

  const dialog = document.createElement('wa-dialog') as WaDialog;
  if (classes?.dialog) dialog.classList.add(classes.dialog);
  dialog.withoutHeader = true;
  dialog.lightDismiss = true;
  dialog.setAttribute('aria-label', ariaLabel);

  const executeActiveCommand = (): void => {
    const entry = visibleEntries[activeIndex];
    if (executeCommandPaletteEntry(entry, onExecute)) close();
  };

  const handleFilterInput = (event: Event): void => {
    const target = event.target as WaInput | null;
    query = target?.value ?? '';
    visibleEntries = filterCommandPaletteEntries(entries, query);
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderTemplate();
  };

  const handleFilterKeydown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        activeIndex = getNextCommandPaletteIndex(
          activeIndex,
          visibleEntries.length,
          1,
        );
        renderTemplate();
        scrollActiveItemIntoView();
        break;
      case 'ArrowUp':
        event.preventDefault();
        activeIndex = getNextCommandPaletteIndex(
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

  const handleItemClick = (entry: CommandPaletteEntry) => (): void => {
    if (executeCommandPaletteEntry(entry, onExecute)) close();
  };

  const inputClass = classes?.input;
  const listClass = classes?.list;
  const itemClass = classes?.item;
  const labelClass = classes?.label;
  const metaClass = classes?.meta;

  const renderTemplate = (): void => {
    render(
      html`
        <wa-input
          class=${inputClass ?? ''}
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Run command"
          aria-label="Run command"
          .value=${query}
          @input=${handleFilterInput}
          @keydown=${handleFilterKeydown}
        ></wa-input>
        <div class=${listClass ?? ''} role="listbox">
          ${repeat(
            visibleEntries,
            (entry) => entry.id,
            (entry, index) => html`
              <button
                class=${itemClass ?? ''}
                type="button"
                role="option"
                data-command-id=${entry.id}
                ?disabled=${!entry.enabled}
                aria-selected=${index === activeIndex ? 'true' : 'false'}
                @mouseenter=${handleItemMouseEnter(index)}
                @click=${handleItemClick(entry)}
              >
                <span class=${labelClass ?? ''}>${entry.label}</span>
                <span class=${metaClass ?? ''}>${entry.meta ?? ''}</span>
              </button>
            `,
          )}
        </div>
      `,
      dialog,
    );
  };

  const scrollActiveItemIntoView = (): void => {
    // Prefer the host-supplied class selector when provided; otherwise fall
    // back to the role attribute every rendered row carries (`role="option"`)
    // so arrow navigation still scrolls when no `classes.item` was passed.
    const selector = itemClass ? `.${itemClass}` : '[role="option"]';
    const items = dialog.querySelectorAll<HTMLElement>(selector);
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
    const input = inputClass
      ? dialog.querySelector<WaInput>(`.${inputClass}`)
      : dialog.querySelector<WaInput>('wa-input');
    input?.focus();
  });

  // Global Cmd/Ctrl+K shortcut — must live on the document so it fires when
  // no palette descendant is focused. canOpen guards against modal dialogs
  // (e.g. the onboarding walkthrough) stealing the shortcut while visible.
  if (isShortcut) {
    document.defaultView?.addEventListener('keydown', (event) => {
      if (!isShortcut(event)) return;
      if (isTextEntryShortcutTarget(view, document, event)) return;
      event.preventDefault();
      open();
    });
  }

  renderTemplate();
  return { element: dialog, open, close };
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
