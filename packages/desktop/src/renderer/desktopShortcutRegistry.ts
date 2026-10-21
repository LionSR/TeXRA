import type {
  DesktopShortcutEntry,
  DesktopShortcutOverrides,
  DesktopShortcutService,
} from '@texra/shared/commands/shortcutPreferences';
import {
  DESKTOP_SHORTCUT_STORAGE_KEY,
  DesktopShortcutOverridesSchema,
  installDesktopShortcutService,
  keyboardEventToAccelerator,
} from '@texra/shared/commands/shortcutPreferences';

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
export function desktopCommandPaletteShortcut(
  platform: DesktopPlatform,
): DesktopShortcutEntry {
  const entry = commandCatalogById.get(DESKTOP_COMMAND_PALETTE_ID);
  if (!entry?.keybinding) {
    throw new Error(
      `Missing command catalog entry: ${DESKTOP_COMMAND_PALETTE_ID}`,
    );
  }
  return {
    id: DESKTOP_COMMAND_PALETTE_ID,
    label: entry.shortTitle ?? entry.title,
    category: entry.category,
    accelerator: toElectronAccelerator(entry.keybinding, platform),
  };
}

interface DesktopShortcutRegistryOptions {
  readonly document: Document;
  readonly actions: DesktopCommandActions;
  readonly openCommands: () => void;
  readonly platform: DesktopPlatform;
}

export interface DesktopShortcutRegistry extends DesktopShortcutService {
  dispose(): void;
}

/** Installs the one desktop shortcut dispatcher and Settings service. */
export function createDesktopShortcutRegistry(
  options: DesktopShortcutRegistryOptions,
): DesktopShortcutRegistry {
  const view = options.document.defaultView;
  const { platform } = options;
  const stored = readOverrides(view?.localStorage);
  let overrides = stored.ok ? stored.overrides : {};
  // While the stored blob is unreadable it stays untouched: `update` rewrites
  // the whole key, so writing over it would erase every binding it holds.
  // `reset()` is the explicit way to discard it.
  let unreadable = !stored.ok;
  const listeners = new Set<
    (entries: readonly DesktopShortcutEntry[]) => void
  >();
  const menuEntries = getDesktopCommandMenuEntries(platform);

  function entries(): DesktopShortcutEntry[] {
    return [desktopCommandPaletteShortcut(platform), ...menuEntries].map(
      (entry) => {
        const override = overrides[entry.id];
        // `null` overrides (explicitly removed shortcuts) are dropped by the
        // truthy spread below, so they need no explicit normalization.
        const accelerator =
          override === undefined ? entry.accelerator : override;
        return {
          id: entry.id,
          label: entry.label,
          category: entry.category,
          ...(entry.accelerator
            ? { defaultAccelerator: entry.accelerator }
            : {}),
          ...(accelerator ? { accelerator } : {}),
        };
      },
    );
  }

  function notify(): void {
    const currentEntries = entries();
    for (const listener of listeners) {
      listener(currentEntries);
    }
  }

  function update(id: string, accelerator: string | undefined): void {
    if (
      !menuEntries.some((entry) => entry.id === id) &&
      id !== DESKTOP_COMMAND_PALETTE_ID
    ) {
      return;
    }
    if (unreadable) {
      throw new Error(
        'Saved keyboard shortcuts could not be read. Use "Reset all" to discard them before changing a shortcut.',
      );
    }
    overrides = {
      ...overrides,
      [id]: accelerator ?? null,
    };
    view?.localStorage.setItem(
      DESKTOP_SHORTCUT_STORAGE_KEY,
      JSON.stringify(overrides),
    );
    notify();
  }

  function reset(): void {
    overrides = {};
    unreadable = false;
    view?.localStorage.removeItem(DESKTOP_SHORTCUT_STORAGE_KEY);
    notify();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if (isRecordingShortcut(view, event)) return;
    const accelerator = keyboardEventToAccelerator(event, platform);
    if (!accelerator) return;
    const entry = entries().find(
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

  const registry: DesktopShortcutRegistry = {
    entries,
    subscribe(
      listener: (entries: readonly DesktopShortcutEntry[]) => void,
    ): () => void {
      listeners.add(listener);
      try {
        listener(entries());
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      return () => listeners.delete(listener);
    },
    update,
    reset,
    dispose(): void {
      listeners.clear();
      view?.removeEventListener('keydown', handleKeydown);
      uninstallService();
    },
  };
  const uninstallService = installDesktopShortcutService(registry);
  return registry;
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

function isRecordingShortcut(
  view: Window | null | undefined,
  event: KeyboardEvent,
): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        isElementFrom(view, target) &&
        target.matches('.shortcut-recorder[data-recording="true"]'),
    );
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

type StoredOverrides =
  | { readonly ok: true; readonly overrides: DesktopShortcutOverrides }
  | { readonly ok: false };

function readOverrides(storage: Storage | undefined): StoredOverrides {
  const raw = storage?.getItem(DESKTOP_SHORTCUT_STORAGE_KEY);
  if (!raw) return { ok: true, overrides: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = DesktopShortcutOverridesSchema.safeParse(parsed);
    if (result.success) return { ok: true, overrides: result.data };
    console.warn(
      '[desktop] Stored keyboard shortcut overrides failed validation; using defaults and keeping the stored value until "Reset all".',
      result.error,
    );
  } catch (error) {
    console.warn(
      '[desktop] Stored keyboard shortcut overrides are not readable JSON; using defaults and keeping the stored value until "Reset all".',
      error,
    );
  }
  return { ok: false };
}
