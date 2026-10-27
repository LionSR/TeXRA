import process from 'node:process';

export function defaultShortcutModifierLabel(): string {
  return process.platform === 'darwin' ? 'Esc' : 'Alt';
}

/** The stream-focus chord (`Alt-1..9` / `Esc 1..9`) shared by help and usage copy. */
export function focusChordLabel(modifierLabel: string): string {
  const separator = modifierLabel === 'Esc' ? ' ' : '-';
  return `${modifierLabel}${separator}1..9`;
}
