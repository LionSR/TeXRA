import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandMenuEntry,
} from '../desktopCommandSurface';

export interface DesktopCommandPaletteOptions {
  document: Document;
  actions: DesktopCommandActions;
  platform?: NodeJS.Platform;
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

export function createDesktopCommandPalette({
  document,
  actions,
  platform = getRendererPlatform(document.defaultView),
}: DesktopCommandPaletteOptions): DesktopCommandPaletteController {
  const view = document.defaultView;
  const entries = getDesktopCommandMenuEntries(undefined, platform);
  let visibleEntries = entries;
  let activeIndex = entries.length > 0 ? 0 : -1;
  let previouslyFocusedElement: HTMLElement | null = null;

  const element = document.createElement('div');
  element.className = 'desktop-command-palette';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');

  const panel = document.createElement('div');
  panel.className = 'desktop-command-palette-panel';

  const input = document.createElement('input');
  input.className = 'desktop-command-palette-input';
  input.type = 'search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Run command';
  input.setAttribute('aria-label', 'Run command');

  const list = document.createElement('div');
  list.className = 'desktop-command-palette-list';
  list.setAttribute('role', 'listbox');

  panel.append(input, list);
  element.append(panel);

  const executeActiveCommand = (): void => {
    const entry = visibleEntries[activeIndex];
    if (!entry) return;
    if (dispatchDesktopCommand(entry.id, actions)) close();
  };

  const renderEntries = (): void => {
    list.replaceChildren();
    visibleEntries.forEach((entry, index) => {
      const item = document.createElement('button');
      item.className = 'desktop-command-palette-item';
      item.type = 'button';
      item.dataset.commandId = entry.id;
      item.setAttribute('role', 'option');
      item.setAttribute(
        'aria-selected',
        index === activeIndex ? 'true' : 'false',
      );

      const label = document.createElement('span');
      label.className = 'desktop-command-palette-label';
      label.textContent = entry.label;

      const meta = document.createElement('span');
      meta.className = 'desktop-command-palette-meta';
      meta.textContent = entry.accelerator ?? entry.category;

      item.append(label, meta);
      item.addEventListener('mouseenter', () => {
        activeIndex = index;
        syncActiveItem();
      });
      item.addEventListener('click', () => {
        if (dispatchDesktopCommand(entry.id, actions)) close();
      });
      list.append(item);
    });
  };

  const syncActiveItem = (): void => {
    const items = list.querySelectorAll<HTMLButtonElement>(
      '.desktop-command-palette-item',
    );
    items.forEach((item, index) => {
      item.setAttribute(
        'aria-selected',
        index === activeIndex ? 'true' : 'false',
      );
      if (index === activeIndex) item.scrollIntoView({ block: 'nearest' });
    });
  };

  const refreshFilter = (): void => {
    visibleEntries = filterDesktopCommandPaletteEntries(entries, input.value);
    activeIndex = visibleEntries.length > 0 ? 0 : -1;
    renderEntries();
  };

  const open = (): void => {
    if (element.hidden) {
      previouslyFocusedElement = isHTMLElement(view, document.activeElement)
        ? document.activeElement
        : null;
    }
    element.hidden = false;
    input.value = '';
    refreshFilter();
    input.focus();
  };

  const close = (): void => {
    element.hidden = true;
    if (previouslyFocusedElement?.isConnected) {
      previouslyFocusedElement.focus();
    }
    previouslyFocusedElement = null;
  };

  element.addEventListener('click', (event) => {
    if (event.target === element) close();
  });
  input.addEventListener('input', refreshFilter);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      trapPaletteFocus(event, panel);
    }
  });
  input.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        activeIndex = getNextDesktopCommandPaletteIndex(
          activeIndex,
          visibleEntries.length,
          1,
        );
        syncActiveItem();
        break;
      case 'ArrowUp':
        event.preventDefault();
        activeIndex = getNextDesktopCommandPaletteIndex(
          activeIndex,
          visibleEntries.length,
          -1,
        );
        syncActiveItem();
        break;
      case 'Enter':
        event.preventDefault();
        executeActiveCommand();
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  });

  document.defaultView?.addEventListener('keydown', (event) => {
    if (!isCommandPaletteShortcut(event)) return;
    if (isTextEntryShortcutTarget(view, document, event)) return;
    event.preventDefault();
    open();
  });

  renderEntries();
  return { element, open, close };
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

function trapPaletteFocus(event: KeyboardEvent, panel: HTMLElement): void {
  const focusableElements = getFocusableElements(panel);
  if (focusableElements.length === 0) return;

  const activeElement = panel.ownerDocument.activeElement;
  const firstElement = focusableElements[0];
  const lastElement = focusableElements.at(-1);
  if (!firstElement || !lastElement) return;

  if (event.shiftKey && activeElement === firstElement) {
    event.preventDefault();
    lastElement.focus();
    return;
  }
  if (!event.shiftKey && activeElement === lastElement) {
    event.preventDefault();
    firstElement.focus();
  }
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      [
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  ].filter((element) => !element.hidden);
}

function isHTMLElement(
  view: Window | null,
  element: Element | null,
): element is HTMLElement {
  const htmlElementConstructor =
    view == null
      ? undefined
      : (view as Window & { HTMLElement?: typeof HTMLElement }).HTMLElement;
  return (
    htmlElementConstructor != null && element instanceof htmlElementConstructor
  );
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
