import type { CommandKeybinding } from './catalog';

/**
 * Pure string transformations for keyboard accelerators. The catalog stores
 * keybindings using VS Code-style tokens (`cmd`, `ctrl`, `alt`, `shift`,
 * etc.); these helpers translate those tokens into the Electron and
 * display formats the desktop shell needs without pulling in any
 * host-specific dependencies. Keeping the logic here lets future hosts
 * (CLI palette, web) share the same normalization rules.
 */

export function toElectronAccelerator(
  keybinding: CommandKeybinding,
  platform: NodeJS.Platform = process.platform,
): string {
  const key =
    platform === 'darwin' && keybinding.mac ? keybinding.mac : keybinding.key;
  return key.split('+').map(toElectronAcceleratorPart).join('+');
}

export function toPlatformAccelerator(
  accelerator: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!accelerator) return undefined;
  if (platform !== 'darwin') return accelerator;
  return accelerator.replaceAll('CommandOrControl', 'Command');
}

export function formatDesktopAccelerator(
  accelerator: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!accelerator) return undefined;
  const isMac = platform === 'darwin';
  const parts = accelerator
    .replaceAll('CommandOrControl', isMac ? 'Command' : 'Control')
    .split('+')
    .map((part) => toDisplayAcceleratorPart(part, platform));
  return parts.join(isMac ? '' : '+');
}

function toElectronAcceleratorPart(part: string): string {
  const normalized = part.trim().toLowerCase();
  switch (normalized) {
    case 'cmd':
      return 'Command';
    case 'ctrl':
      return 'Control';
    case 'option':
      return 'Option';
    case 'alt':
      return 'Alt';
    case 'shift':
      return 'Shift';
    case 'enter':
      return 'Enter';
    case 'escape':
      return 'Escape';
    case 'space':
      return 'Space';
    case 'tab':
      return 'Tab';
    default:
      if (/^f\d{1,2}$/.test(normalized)) return normalized.toUpperCase();
      return normalized.length === 1 ? normalized.toUpperCase() : normalized;
  }
}

function toDisplayAcceleratorPart(
  part: string,
  platform: NodeJS.Platform,
): string {
  const normalized = part.trim().toLowerCase();
  const isMac = platform === 'darwin';
  switch (normalized) {
    case 'cmd':
    case 'command':
      return isMac ? '⌘' : 'Cmd';
    case 'ctrl':
    case 'control':
      return isMac ? '⌃' : 'Ctrl';
    case 'alt':
    case 'option':
      return isMac ? '⌥' : 'Alt';
    case 'shift':
      return isMac ? '⇧' : 'Shift';
    default: {
      const trimmed = part.trim();
      return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
    }
  }
}
