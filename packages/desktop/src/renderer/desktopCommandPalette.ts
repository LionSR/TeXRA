// Desktop wrapper around the host-neutral command palette in
// `src/shared/wa/commandPalette.ts`. Owns desktop-specific concerns:
//
//   * Pulls the command list from `desktopCommandSurface` (which depends on
//     the VS Code-coupled `@commands/catalog` and Electron accelerator
//     formatting — both still desktop-only).
//   * Maps each entry's accelerator/category/unavailableReason into the
//     palette's neutral `meta` column.
//   * Forwards the `.desktop-command-palette-*` class hooks the desktop
//     stylesheet already targets so the visual treatment is unchanged.
//
// The shared module owns the wa-dialog shell, filter input, keyboard
// handling, and the global Cmd/Ctrl+K shortcut.

import {
  createCommandPalette,
  executeCommandPaletteEntry,
  filterCommandPaletteEntries,
  getNextCommandPaletteIndex,
  isCommandPaletteShortcut,
  type CommandPaletteController,
  type CommandPaletteEntry,
} from '@shared/wa/commandPalette';

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
  canOpen?: () => boolean;
}

export type DesktopCommandPaletteController = CommandPaletteController;

export function filterDesktopCommandPaletteEntries(
  entries: readonly DesktopCommandMenuEntry[],
  query: string,
): DesktopCommandMenuEntry[] {
  // Desktop entries carry `category` (used in the haystack alongside id and
  // label). The shared helper consults `category` first, then `meta`, so the
  // existing search behaviour (label + category + id) is preserved.
  return filterCommandPaletteEntries(entries, query);
}

export function getNextDesktopCommandPaletteIndex(
  currentIndex: number,
  itemCount: number,
  delta: number,
): number {
  return getNextCommandPaletteIndex(currentIndex, itemCount, delta);
}

export function executeDesktopCommandPaletteEntry(
  entry: DesktopCommandMenuEntry | undefined,
  actions: DesktopCommandActions,
): boolean {
  return executeCommandPaletteEntry(toPaletteEntry(entry), (id) =>
    dispatchDesktopCommand(id as DesktopCommandMenuEntry['id'], actions),
  );
}

export { isCommandPaletteShortcut };

export function createDesktopCommandPalette({
  document,
  actions,
  platform = getRendererPlatform(document.defaultView),
  canOpen,
}: DesktopCommandPaletteOptions): DesktopCommandPaletteController {
  const desktopEntries = getDesktopCommandMenuEntries(undefined, platform);
  const paletteEntries = desktopEntries
    .map(toPaletteEntry)
    .filter((entry): entry is CommandPaletteEntry => entry != null);

  return createCommandPalette({
    document,
    entries: paletteEntries,
    canOpen,
    onExecute: (id) =>
      dispatchDesktopCommand(id as DesktopCommandMenuEntry['id'], actions),
    classes: {
      dialog: 'desktop-command-palette',
      input: 'desktop-command-palette-input',
      list: 'desktop-command-palette-list',
      item: 'desktop-command-palette-item',
      label: 'desktop-command-palette-label',
      meta: 'desktop-command-palette-meta',
    },
  });
}

function toPaletteEntry(
  entry: DesktopCommandMenuEntry | undefined,
): CommandPaletteEntry | undefined {
  if (!entry) return undefined;
  // Match the original meta-column precedence: unavailableReason > accelerator
  // > category. Disabled entries surface their reason; enabled entries show
  // the keybinding when present, falling back to the catalog category.
  const meta = entry.unavailableReason ?? entry.accelerator ?? entry.category;
  return {
    id: entry.id,
    label: entry.label,
    meta,
    // Always include `category` so the palette filter can match it even when
    // `meta` is occupied by an accelerator or unavailable-reason — restoring
    // the original imperative haystack which always carried `category`.
    category: entry.category,
    enabled: entry.enabled,
  };
}

function getRendererPlatform(view: Window | null): NodeJS.Platform {
  const platform = view?.navigator.platform.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  return 'linux';
}
