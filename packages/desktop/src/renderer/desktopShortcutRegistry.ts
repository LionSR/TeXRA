import type {
  DesktopShortcutEntry,
  DesktopShortcutState,
  DesktopShortcutUpdate,
} from '@shared/commands/shortcutPreferences';
import {
  DESKTOP_SHORTCUT_EVENTS,
  DESKTOP_SHORTCUT_STORAGE_KEY,
  keyboardEventToAccelerator,
} from '@shared/commands/shortcutPreferences';

import {
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../desktopCommandSurface';
import { isTextEntryShortcutTarget } from './desktopCommandPalette';
import { getRendererPlatform } from './rendererPlatform';

export const DESKTOP_COMMAND_PALETTE_ID = 'texra.desktop.showCommands';

interface DesktopShortcutRegistryOptions {
  readonly document: Document;
  readonly actions: DesktopCommandActions;
  readonly openCommands: () => void;
  readonly platform?: NodeJS.Platform;
}

export interface DesktopShortcutRegistry {
  entries(): readonly DesktopShortcutEntry[];
  subscribe(
    listener: (entries: readonly DesktopShortcutEntry[]) => void,
  ): () => void;
  dispose(): void;
}

type ShortcutOverrides = Record<string, string | null>;

/** Installs the one desktop shortcut dispatcher and settings event bridge. */
export function createDesktopShortcutRegistry(
  options: DesktopShortcutRegistryOptions,
): DesktopShortcutRegistry {
  const view = options.document.defaultView;
  const platform = options.platform ?? getRendererPlatform(view);
  let overrides = readOverrides(view?.localStorage);
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

  function postState(): void {
    if (!view) return;
    const currentEntries = entries();
    const detail: DesktopShortcutState = { entries: currentEntries };
    view.dispatchEvent(
      new CustomEvent(DESKTOP_SHORTCUT_EVENTS.STATE, { detail }),
    );
    for (const listener of listeners) {
      listener(currentEntries);
    }
  }

  function handleRequest(): void {
    postState();
  }

  function handleUpdate(event: Event): void {
    const update = (event as CustomEvent<DesktopShortcutUpdate>).detail;
    if (!availableEntries.some((entry) => entry.id === update.id)) {
      if (update.id !== DESKTOP_COMMAND_PALETTE_ID) return;
    }
    overrides = {
      ...overrides,
      [update.id]: update.accelerator ?? null,
    };
    writeOverrides(view?.localStorage, overrides);
    postState();
  }

  function handleReset(): void {
    overrides = {};
    view?.localStorage.removeItem(DESKTOP_SHORTCUT_STORAGE_KEY);
    postState();
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
      isTextEntryShortcutTarget(view, options.document, event) &&
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

  view?.addEventListener(DESKTOP_SHORTCUT_EVENTS.REQUEST, handleRequest);
  view?.addEventListener(DESKTOP_SHORTCUT_EVENTS.UPDATE, handleUpdate);
  view?.addEventListener(DESKTOP_SHORTCUT_EVENTS.RESET, handleReset);
  view?.addEventListener('keydown', handleKeydown, { capture: true });

  return {
    entries,
    subscribe(
      listener: (entries: readonly DesktopShortcutEntry[]) => void,
    ): () => void {
      listeners.add(listener);
      listener(entries());
      return () => listeners.delete(listener);
    },
    dispose(): void {
      listeners.clear();
      view?.removeEventListener(DESKTOP_SHORTCUT_EVENTS.REQUEST, handleRequest);
      view?.removeEventListener(DESKTOP_SHORTCUT_EVENTS.UPDATE, handleUpdate);
      view?.removeEventListener(DESKTOP_SHORTCUT_EVENTS.RESET, handleReset);
      view?.removeEventListener('keydown', handleKeydown, { capture: true });
    },
  };
}

function isRecordingShortcut(
  view: Window | null | undefined,
  event: KeyboardEvent,
): boolean {
  const ElementConstructor = (
    view as (Window & { Element?: typeof Element }) | null | undefined
  )?.Element;
  if (!ElementConstructor) return false;
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof ElementConstructor &&
        ElementConstructor.prototype.matches.call(
          target,
          '.shortcut-recorder[data-recording="true"]',
        ),
    );
}

function hasPrimaryModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

function readOverrides(storage: Storage | undefined): ShortcutOverrides {
  if (!storage) return {};
  const raw = storage.getItem(DESKTOP_SHORTCUT_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isShortcutOverrides(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeOverrides(
  storage: Storage | undefined,
  overrides: ShortcutOverrides,
): void {
  storage?.setItem(DESKTOP_SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
}

function isShortcutOverrides(value: unknown): value is ShortcutOverrides {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (accelerator) => accelerator === null || typeof accelerator === 'string',
  );
}
