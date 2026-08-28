import type { DesktopShortcutEntry } from '@shared/commands/shortcutPreferences';

import type { CommandPaletteController } from './desktopCommandPalette';
import type { DesktopShortcutRegistry } from './desktopShortcutRegistry';

interface DesktopShortcutBootstrapOptions {
  readonly createRegistry: (
    openCommands: () => void,
  ) => DesktopShortcutRegistry;
  readonly createPalette: (
    registry: DesktopShortcutRegistry,
  ) => CommandPaletteController;
  readonly appendPalette: (element: HTMLElement) => void;
  readonly onShortcutsChanged: (
    entries: readonly DesktopShortcutEntry[],
  ) => void;
}

/** Owns retry-safe installation and disposal of the desktop command shortcuts. */
export function createDesktopShortcutBootstrap(
  options: DesktopShortcutBootstrapOptions,
): {
  ensure(): void;
  entries(): readonly DesktopShortcutEntry[] | undefined;
  open(): void;
  dispose(): void;
} {
  let registry: DesktopShortcutRegistry | undefined;
  let palette: CommandPaletteController | undefined;
  let disposeHints: (() => void) | undefined;
  let installed = false;
  let disposed = false;

  return {
    ensure(): void {
      if (installed || disposed) return;
      registry ??= options.createRegistry(() => palette?.open());
      palette ??= options.createPalette(registry);
      if (!palette.element.isConnected) {
        options.appendPalette(palette.element);
      }
      disposeHints = registry.subscribe(options.onShortcutsChanged);
      installed = true;
    },
    entries(): readonly DesktopShortcutEntry[] | undefined {
      return registry?.entries();
    },
    open(): void {
      palette?.open();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeHints?.();
      registry?.dispose();
      palette?.element.remove();
    },
  };
}
