import {
  toElectronAccelerator,
  type DesktopPlatform,
} from '@texra/shared/commands/accelerators';
import { commandCatalogById } from '@texra/shared/commands/catalog';
import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../shared/desktopCommandSurface';

export const DESKTOP_COMMAND_PALETTE_ID = 'texra.desktop.showCommands';

/**
 * The command palette has no menu entry, so its catalog row is read here
 * rather than coming from `getDesktopCommandMenuEntries`. Sole owner of that
 * read: the shell's accelerator hints call it too, before this registry
 * exists (a bootstrap failure leaves no registry at all).
 */
export function desktopCommandPaletteShortcut(platform: DesktopPlatform): {
  readonly id: typeof DESKTOP_COMMAND_PALETTE_ID;
  readonly label: string;
  readonly accelerator: string;
} {
  const entry = commandCatalogById.get(DESKTOP_COMMAND_PALETTE_ID);
  if (!entry?.keybinding) {
    throw new Error(
      `Missing command catalog entry: ${DESKTOP_COMMAND_PALETTE_ID}`,
    );
  }
  return {
    id: DESKTOP_COMMAND_PALETTE_ID,
    label: entry.shortTitle ?? entry.title,
    accelerator: toElectronAccelerator(entry.keybinding, platform),
  };
}

interface DesktopShortcutRegistryOptions {
  readonly document: Document;
  readonly actions: DesktopCommandActions;
  readonly openCommands: () => void;
  readonly platform: DesktopPlatform;
}

/** Installs the one desktop shortcut dispatcher over the catalog's fixed
 *  accelerators. */
export function createDesktopShortcutRegistry(
  options: DesktopShortcutRegistryOptions,
): { dispose(): void } {
  const view = options.document.defaultView;
  const { platform } = options;
  const entries = [
    desktopCommandPaletteShortcut(platform),
    ...getDesktopCommandMenuEntries(platform),
  ];

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const accelerator = keyboardEventToAccelerator(event, platform);
    if (!accelerator) return;
    const entry = entries.find(
      (candidate) =>
        candidate.accelerator?.toLowerCase() === accelerator.toLowerCase(),
    );
    if (!entry) return;
    if (
      isTextEntryTarget(view, options.document, event) &&
      !hasPrimaryModifier(event)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (entry.id === DESKTOP_COMMAND_PALETTE_ID) {
      options.openCommands();
      return;
    }
    dispatchDesktopCommand(entry.id as DesktopCommandId, options.actions);
  }

  // Let the focused editor, terminal, or form handle its own keys first.
  // In particular, Cmd/Ctrl+K can begin an editor chord and Ctrl+J is terminal
  // input; a capturing application listener used to steal both.
  view?.addEventListener('keydown', handleKeydown);

  return {
    dispose(): void {
      view?.removeEventListener('keydown', handleKeydown);
    },
  };
}

/**
 * Cross-realm element check. The registry is handed the renderer's `Document`,
 * whose `Element` constructor need not be this module's global (tests install a
 * separate DOM), so `instanceof` has to go through that view.
 */
function isElementFrom(
  view: Window | null | undefined,
  target: EventTarget | null,
): target is Element {
  const ElementConstructor = (
    view as (Window & { Element?: typeof Element }) | null | undefined
  )?.Element;
  return ElementConstructor != null && target instanceof ElementConstructor;
}

/**
 * True when the keystroke is ordinary typing: it either travels through a text
 * entry control or one is focused, possibly inside a shadow root.
 */
function isTextEntryTarget(
  view: Window | null | undefined,
  document: Document,
  event: KeyboardEvent,
): boolean {
  if (event.composedPath().some((target) => isTextEntryElement(view, target))) {
    return true;
  }
  return isTextEntryElement(view, getDeepActiveElement(document));
}

function isTextEntryElement(
  view: Window | null | undefined,
  target: EventTarget | null,
): boolean {
  if (!isElementFrom(view, target)) return false;
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

function hasPrimaryModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift', 'AltGraph']);

const FUNCTION_KEY_PATTERN = /^F\d{1,2}$/i;

/** Converts a DOM keyboard chord into the canonical Electron-style form. */
function keyboardEventToAccelerator(
  event: KeyboardEvent,
  platform: DesktopPlatform,
): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const key = normalizeKeyboardKey(event.key);
  if (!key) return undefined;

  const parts: string[] = [];
  if (platform === 'darwin' && event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push(platform === 'darwin' ? 'Option' : 'Alt');
  if (event.shiftKey) parts.push('Shift');
  if (platform !== 'darwin' && event.metaKey) parts.push('Super');
  if (parts.length === 0 && !FUNCTION_KEY_PATTERN.test(key)) return undefined;
  return [...parts, key].join('+');
}

const SUPPORTED_NAMED_KEYS: Record<string, string> = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  Backspace: 'Backspace',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Escape: 'Escape',
  Home: 'Home',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Tab: 'Tab',
};

function normalizeKeyboardKey(key: string): string | undefined {
  if (key === ' ') return 'Space';
  if (key.length === 1 || FUNCTION_KEY_PATTERN.test(key)) {
    return key.toUpperCase();
  }
  return SUPPORTED_NAMED_KEYS[key];
}
