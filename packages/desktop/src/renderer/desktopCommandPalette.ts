// Desktop wrapper around shared commandPalette — desktop command surface + accelerator formatting.

import type { StreamTabId, StreamTabInfo } from '@shared/schemas';
import {
  createCommandPalette,
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

const DESKTOP_SWITCH_STREAM_COMMAND_PREFIX = 'texra.desktop.switchStream:';

export function createDesktopCommandPalette({
  document,
  actions,
  getStreams,
  platform = getRendererPlatform(document.defaultView),
  canOpen,
}: DesktopCommandPaletteOptions): DesktopCommandPaletteController {
  return createCommandPalette({
    document,
    entries: () => {
      const streams = actions.showStream == null ? [] : (getStreams?.() ?? []);
      return [
        ...getDesktopCommandMenuEntries(undefined, platform).map(
          toPaletteEntry,
        ),
        ...streams.map(toStreamPaletteEntry),
      ];
    },
    canOpen,
    onExecute: (id) => dispatchDesktopPaletteCommand(id, actions),
    classes: {
      dialog: 'desktop-command-palette',
      input: 'desktop-command-palette-input',
      list: 'desktop-command-palette-list',
      item: 'desktop-command-palette-item',
      label: 'desktop-command-palette-label',
      meta: 'desktop-command-palette-meta',
      empty: 'desktop-command-palette-empty',
    },
  });
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
    meta:
      stream.description ||
      stream.agent ||
      (stream.kind === 'agent' ? stream.modelLabel : undefined) ||
      'Stream',
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

function toPaletteEntry(entry: DesktopCommandMenuEntry): CommandPaletteEntry {
  // Meta-column precedence: unavailableReason > accelerator > category.
  // Disabled entries surface their reason; enabled entries show the
  // keybinding when present, falling back to the catalog category.
  // `category` is always carried separately so the palette filter can match
  // it even when `meta` holds an accelerator or unavailable reason.
  return {
    id: entry.id,
    label: entry.label,
    meta: entry.unavailableReason ?? entry.accelerator ?? entry.category,
    category: entry.category,
    enabled: entry.enabled,
  };
}
