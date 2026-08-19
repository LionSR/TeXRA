// Third-party imports
import { z } from 'zod';

import type { DesktopPlatform } from './accelerators';

/**
 * In-process contract shared by the desktop shortcut runtime and Settings.
 *
 * Shortcuts are renderer behavior, so routing them through Electron IPC would
 * add a second owner without adding a trust boundary. The desktop installs one
 * service instance; the VS Code host does not install it and hides the tab.
 */

export interface DesktopShortcutEntry {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly defaultAccelerator?: string;
  readonly accelerator?: string;
}

export interface DesktopShortcutService {
  entries(): readonly DesktopShortcutEntry[];
  subscribe(
    listener: (entries: readonly DesktopShortcutEntry[]) => void,
  ): () => void;
  update(id: string, accelerator: string | undefined): void;
  reset(): void;
}

export const DESKTOP_SHORTCUT_STORAGE_KEY =
  'texra.desktop.shortcutOverrides.v1';

export const DesktopShortcutOverridesSchema = z.record(
  z.string(),
  z.string().min(1).max(128).nullable(),
);
export type DesktopShortcutOverrides = z.infer<
  typeof DesktopShortcutOverridesSchema
>;

let installedService: DesktopShortcutService | undefined;

/** Installs the desktop shortcut service and returns its exact disposer. */
export function installDesktopShortcutService(
  service: DesktopShortcutService,
): () => void {
  if (installedService && installedService !== service) {
    throw new Error('A desktop shortcut service is already installed.');
  }
  installedService = service;
  return () => {
    if (installedService === service) installedService = undefined;
  };
}

/** Returns the desktop service, or undefined in non-desktop hosts. */
export function getDesktopShortcutService():
  DesktopShortcutService | undefined {
  return installedService;
}

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift', 'AltGraph']);

const FUNCTION_KEY_PATTERN = /^F\d{1,2}$/i;

/** Converts a DOM keyboard chord into the canonical Electron-style form. */
export function keyboardEventToAccelerator(
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
  if (key.length === 1) return key.toUpperCase();
  if (FUNCTION_KEY_PATTERN.test(key)) return key.toUpperCase();
  return SUPPORTED_NAMED_KEYS[key];
}
