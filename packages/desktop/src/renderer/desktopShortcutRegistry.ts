import type {
  DesktopShortcutEntry,
  DesktopShortcutOverrides,
  DesktopShortcutService,
} from '@shared/commands/shortcutPreferences';
import {
  DESKTOP_SHORTCUT_INVALID_BACKUP_KEY,
  DESKTOP_SHORTCUT_STORAGE_KEY,
  DesktopShortcutOverridesSchema,
  installDesktopShortcutService,
  keyboardEventToAccelerator,
} from '@shared/commands/shortcutPreferences';

import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../desktopCommandSurface';
import { getRendererPlatform } from './rendererPlatform';

export const DESKTOP_COMMAND_PALETTE_ID = 'texra.desktop.showCommands';

interface DesktopShortcutRegistryOptions {
  readonly document: Document;
  readonly actions: DesktopCommandActions;
  readonly openCommands: () => void;
  readonly platform?: NodeJS.Platform;
}

export interface DesktopShortcutRegistry extends DesktopShortcutService {
  dispose(): void;
}

interface StoredShortcutOverrides {
  readonly overrides: DesktopShortcutOverrides;
  readonly invalidRaw?: string;
}

/** Installs the one desktop shortcut dispatcher and Settings service. */
export function createDesktopShortcutRegistry(
  options: DesktopShortcutRegistryOptions,
): DesktopShortcutRegistry {
  const view = options.document.defaultView;
  const platform = options.platform ?? getRendererPlatform(view);
  const stored = readOverrides(view?.localStorage);
  let overrides = stored.overrides;
  let invalidRaw = stored.invalidRaw;
  const listeners = new Set<
    (entries: readonly DesktopShortcutEntry[]) => void
  >();
  const availableEntries = getDesktopCommandMenuEntries(
    undefined,
    platform,
  ).filter((entry) => entry.enabled);

  function entries(): DesktopShortcutEntry[] {
    return [
      {
        id: DESKTOP_COMMAND_PALETTE_ID,
        label: 'Show Commands',
        category: 'TeXRA',
        accelerator: platform === 'darwin' ? 'Command+K' : 'Control+K',
      },
      ...availableEntries,
    ].map((entry) => {
      const override = overrides[entry.id];
      const accelerator =
        override === undefined ? entry.accelerator : (override ?? undefined);
      return {
        id: entry.id,
        label: entry.label,
        category: entry.category,
        ...(entry.accelerator ? { defaultAccelerator: entry.accelerator } : {}),
        ...(accelerator ? { accelerator } : {}),
      };
    });
  }

  function notify(): void {
    const currentEntries = entries();
    for (const listener of listeners) {
      listener(currentEntries);
    }
  }

  function update(id: string, accelerator: string | undefined): void {
    if (
      !availableEntries.some((entry) => entry.id === id) &&
      id !== DESKTOP_COMMAND_PALETTE_ID
    ) {
      return;
    }
    overrides = {
      ...overrides,
      [id]: accelerator ?? null,
    };
    writeOverrides(view?.localStorage, overrides, invalidRaw);
    invalidRaw = undefined;
    notify();
  }

  function reset(): void {
    overrides = {};
    invalidRaw = undefined;
    view?.localStorage.removeItem(DESKTOP_SHORTCUT_STORAGE_KEY);
    view?.localStorage.removeItem(DESKTOP_SHORTCUT_INVALID_BACKUP_KEY);
    notify();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.repeat) return;
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

  view?.addEventListener('keydown', handleKeydown, { capture: true });

  let uninstallService = (): void => {};
  const registry: DesktopShortcutRegistry = {
    entries,
    subscribe(
      listener: (entries: readonly DesktopShortcutEntry[]) => void,
    ): () => void {
      listeners.add(listener);
      listener(entries());
      return () => listeners.delete(listener);
    },
    update,
    reset,
    dispose(): void {
      listeners.clear();
      view?.removeEventListener('keydown', handleKeydown, { capture: true });
      uninstallService();
    },
  };
  uninstallService = installDesktopShortcutService(registry);
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

function readOverrides(storage: Storage | undefined): StoredShortcutOverrides {
  if (!storage) return { overrides: {} };
  const raw = storage.getItem(DESKTOP_SHORTCUT_STORAGE_KEY);
  if (!raw) return { overrides: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = DesktopShortcutOverridesSchema.safeParse(parsed);
    if (result.success) return { overrides: result.data };
  } catch {
    // The invalid value is retained and backed up on the next explicit write.
  }
  return { overrides: {}, invalidRaw: raw };
}

function writeOverrides(
  storage: Storage | undefined,
  overrides: DesktopShortcutOverrides,
  invalidRaw: string | undefined,
): void {
  if (invalidRaw) {
    storage?.setItem(DESKTOP_SHORTCUT_INVALID_BACKUP_KEY, invalidRaw);
  }
  storage?.setItem(DESKTOP_SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
}
