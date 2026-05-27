export interface ReturnKeyInput {
  readonly return?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export function metaChordInput(
  input: string,
  key: Pick<ReturnKeyInput, 'ctrl' | 'meta'>,
): string | undefined {
  if (key.ctrl) return undefined;
  if (key.meta && input) return input;
  return input.startsWith('\u001B') && input.length > 1
    ? input.slice(1)
    : undefined;
}

export function metaChordDigit(
  input: string,
  key: Pick<ReturnKeyInput, 'ctrl' | 'meta'>,
): number | undefined {
  const chord = metaChordInput(input, key);
  if (!chord) return undefined;
  const digit = Number(chord);
  return Number.isInteger(digit) && digit >= 1 && digit <= 9
    ? digit
    : undefined;
}

export function isPlainReturnInput(
  input: string,
  key: ReturnKeyInput,
): boolean {
  if (key.ctrl || key.meta || key.shift || metaChordInput(input, key))
    return false;
  return key.return === true || input === '\r' || input === '\n';
}

// Shift+Enter → literal newline, the ergonomic twin of Ctrl-J. Ink only
// reports `key.shift` on Enter when the Kitty keyboard protocol is active
// (enabled in runChatTui for terminals that support it). On terminals without
// it, Shift+Enter is byte-identical to Enter and falls through to submit, so
// Ctrl-J remains the universal fallback.
export function isShiftReturnInput(
  input: string,
  key: ReturnKeyInput,
): boolean {
  if (key.ctrl || key.meta || key.shift !== true) return false;
  return key.return === true || input === '\r' || input === '\n';
}
