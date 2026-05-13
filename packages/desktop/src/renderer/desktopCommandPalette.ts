// Desktop wrapper around shared commandPalette — desktop command surface + accelerator formatting.

import type { StreamTabId, StreamTabInfo } from '@shared/schemas';
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
import { getRendererPlatform } from './rendererPlatform';

export interface DesktopCommandPaletteOptions {
  document: Document;
  actions: DesktopCommandActions;
  getStreams?: () => readonly StreamTabInfo[];
  platform?: NodeJS.Platform;
  canOpen?: () => boolean;
}

export type DesktopCommandPaletteController = CommandPaletteController;

export const DESKTOP_SWITCH_STREAM_COMMAND_PREFIX =
  'texra.desktop.switchStream:';

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
  getStreams,
  platform = getRendererPlatform(document.defaultView),
  canOpen,
}: DesktopCommandPaletteOptions): DesktopCommandPaletteController {
  return createCommandPalette({
    document,
    entries: () =>
      getDesktopCommandPaletteEntries({
        streams: actions.showStream == null ? [] : (getStreams?.() ?? []),
        platform,
      }),
    canOpen,
    onExecute: (id) => dispatchDesktopPaletteCommand(id, actions),
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

export function getDesktopCommandPaletteEntries({
  streams = [],
  platform = getDefaultPlatform(),
}: {
  streams?: readonly StreamTabInfo[];
  platform?: NodeJS.Platform;
} = {}): CommandPaletteEntry[] {
  const desktopEntries = getDesktopCommandMenuEntries(undefined, platform)
    .map(toPaletteEntry)
    .filter((entry): entry is CommandPaletteEntry => entry != null);
  return [...desktopEntries, ...streams.map(toStreamPaletteEntry)];
}

function dispatchDesktopPaletteCommand(
  id: string,
  actions: DesktopCommandActions,
): boolean | Promise<boolean> {
  const streamId = parseSwitchStreamCommandId(id);
  if (streamId != null) {
    if (!actions.showStream) return false;
    actions.showStream(streamId);
    return true;
  }
  return dispatchDesktopCommand(id as DesktopCommandMenuEntry['id'], actions);
}

function toStreamPaletteEntry(stream: StreamTabInfo): CommandPaletteEntry {
  return {
    id: buildSwitchStreamCommandId(stream.name),
    label: `Switch to ${stream.label || stream.name}`,
    meta: stream.description || stream.agent || stream.modelLabel || 'Stream',
    category: 'Streams',
    enabled: true,
  };
}

function buildSwitchStreamCommandId(streamId: StreamTabId): string {
  return `${DESKTOP_SWITCH_STREAM_COMMAND_PREFIX}${streamId}`;
}

function parseSwitchStreamCommandId(id: string): StreamTabId | undefined {
  if (!id.startsWith(DESKTOP_SWITCH_STREAM_COMMAND_PREFIX)) return undefined;
  const streamId = id.slice(DESKTOP_SWITCH_STREAM_COMMAND_PREFIX.length);
  return streamId || undefined;
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

function getDefaultPlatform(): NodeJS.Platform {
  return typeof process === 'undefined' ? 'linux' : process.platform;
}
