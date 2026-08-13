import process from 'node:process';

export function defaultShortcutModifierLabel(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin' ? 'Esc' : 'Alt';
}

/** Bare modifier chord (`Alt-p` / `Esc p`) shared by status, help, and state copy. */
export function metaChordLabel(modifierLabel: string, key: string): string {
  const separator = modifierLabel === 'Esc' ? ' ' : '-';
  return `${modifierLabel}${separator}${key}`;
}
