/**
 * DOM event contract shared by the desktop shortcut runtime and the settings
 * tab. Persistence stays in the desktop renderer profile; the VS Code host
 * renders the tab as unavailable.
 */

export const DESKTOP_SHORTCUT_EVENTS = {
  REQUEST: 'texra-desktop-shortcuts-request',
  STATE: 'texra-desktop-shortcuts-state',
  UPDATE: 'texra-desktop-shortcuts-update',
  RESET: 'texra-desktop-shortcuts-reset',
} as const;

export interface DesktopShortcutEntry {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly defaultAccelerator?: string;
  readonly accelerator?: string;
}

export interface DesktopShortcutState {
  readonly entries: readonly DesktopShortcutEntry[];
}

export interface DesktopShortcutUpdate {
  readonly id: string;
  readonly accelerator?: string;
}

export const DESKTOP_SHORTCUT_STORAGE_KEY =
  'texra.desktop.shortcutOverrides.v1';

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift', 'AltGraph']);

/** Converts a DOM keyboard chord into the canonical Electron-style form. */
export function keyboardEventToAccelerator(
  event: KeyboardEvent,
  platform: NodeJS.Platform,
): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const key = normalizeKeyboardKey(event.key);
  if (!key) return undefined;

  const parts: string[] = [];
  if (platform === 'darwin' && event.metaKey) parts.push('Command');
  if (platform !== 'darwin' && event.ctrlKey) parts.push('Control');
  if (platform === 'darwin' && event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push(platform === 'darwin' ? 'Option' : 'Alt');
  if (event.shiftKey) parts.push('Shift');
  if (platform !== 'darwin' && event.metaKey) parts.push('Super');
  if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return undefined;
  return [...parts, key].join('+');
}

function normalizeKeyboardKey(key: string): string | undefined {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  const supported: Record<string, string> = {
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
  return supported[key];
}
