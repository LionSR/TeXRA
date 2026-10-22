import type { CommandKeybinding } from './catalog';

/**
 * Pure string transformations for keyboard accelerators. The catalog stores
 * keybindings using VS Code-style tokens (`cmd`, `ctrl`, `alt`, `shift`,
 * etc.); these helpers translate those tokens into the Electron and
 * display formats the desktop shell needs without pulling in any
 * host-specific dependencies. Keeping the logic here lets future hosts
 * (CLI palette, web) share the same normalization rules.
 */

/**
 * The three platform ids the accelerator rules distinguish. Declared here
 * rather than reused from `NodeJS.Platform` because every consumer of these
 * helpers also runs in a browser context — the desktop renderer and the two
 * webview frontends — whose TypeScript projects carry no Node types. Callers
 * on the Node side narrow `process.platform` into this union at their own
 * boundary; browser callers derive it from `navigator`.
 */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

export function toElectronAccelerator(
  keybinding: CommandKeybinding,
  platform: DesktopPlatform,
): string {
  const key =
    platform === 'darwin' && keybinding.mac ? keybinding.mac : keybinding.key;
  return key.split('+').map(toElectronAcceleratorPart).join('+');
}

export function formatDesktopAccelerator(
  accelerator: string | undefined,
  platform: DesktopPlatform,
): string | undefined {
  if (!accelerator) return undefined;
  const isMac = platform === 'darwin';
  const parts = accelerator
    .split('+')
    .map((part) => toDisplayAcceleratorPart(part, platform));
  return parts.join(isMac ? '' : '+');
}

const ELECTRON_ACCELERATOR_PARTS: Record<string, string> = {
  cmd: 'Command',
  ctrl: 'Control',
  option: 'Option',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
};

function toElectronAcceleratorPart(part: string): string {
  const normalized = part.trim().toLowerCase();
  const mapped = ELECTRON_ACCELERATOR_PARTS[normalized];
  if (mapped) return mapped;
  return normalized.length === 1 || /^f\d{1,2}$/.test(normalized)
    ? normalized.toUpperCase()
    : normalized;
}

// Each entry maps a token to its [mac symbol, non-mac label] display forms.
const DISPLAY_ACCELERATOR_PARTS: Record<
  string,
  readonly [mac: string, nonMac: string]
> = {
  cmd: ['⌘', 'Cmd'],
  command: ['⌘', 'Cmd'],
  ctrl: ['⌃', 'Ctrl'],
  control: ['⌃', 'Ctrl'],
  alt: ['⌥', 'Alt'],
  option: ['⌥', 'Alt'],
  shift: ['⇧', 'Shift'],
};

function toDisplayAcceleratorPart(
  part: string,
  platform: DesktopPlatform,
): string {
  const trimmed = part.trim();
  const mapped = DISPLAY_ACCELERATOR_PARTS[trimmed.toLowerCase()];
  if (mapped) return platform === 'darwin' ? mapped[0] : mapped[1];
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
}
