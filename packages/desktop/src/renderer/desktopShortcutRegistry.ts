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
import { isTextEntryShortcutTarget } from './desktopCommandPalette';
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
  if (invalidRaw) {
    console.warn(
      'Ignored malformed desktop shortcut preferences; the original value will be backed up before the next update.',
    );
  }
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
    if (!availableEntries.some((entry) => entry.id === id)) {
      if (id !== DESKTOP_COMMAND_PALETTE_ID) return;
    }
    overrides = {
      ...overrides,
      [id]: accelerator ?? null,
    };
    invalidRaw = writeOverrides(view?.localStorage, overrides, invalidRaw);
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
  view?.addEventListener('keydown', handleKeydown, { capture: true });
  return registry;
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
): undefined {
  if (invalidRaw) {
    storage?.setItem(DESKTOP_SHORTCUT_INVALID_BACKUP_KEY, invalidRaw);
  }
  storage?.setItem(DESKTOP_SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
  return undefined;
}
