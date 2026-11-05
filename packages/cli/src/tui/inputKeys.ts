export interface ReturnKeyInput {
  readonly return?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly escape?: boolean;
}

const ESC = '\u001B';

const RAW_CONTROL_INPUTS = new Map<number, string>([
  [1, 'a'],
  [5, 'e'],
  [7, 'g'],
  [11, 'k'],
  [18, 'r'],
  [21, 'u'],
  [22, 'v'],
  [23, 'w'],
]);

function normalizedCtrlInput(
  input: string,
  key: Pick<ReturnKeyInput, 'ctrl' | 'meta'>,
): string | undefined {
  if (key.meta) return undefined;
  if (input.length !== 1) return undefined;
  return (
    RAW_CONTROL_INPUTS.get(input.charCodeAt(0)) ??
    (key.ctrl ? input.toLowerCase() : undefined)
  );
}

export function isCtrlInput(
  input: string,
  key: Pick<ReturnKeyInput, 'ctrl' | 'meta'>,
  expected: string,
): boolean {
  return normalizedCtrlInput(input, key) === expected.toLowerCase();
}

export function isEscapeInput(
  input: string,
  key: Pick<ReturnKeyInput, 'escape'>,
): boolean {
  return key.escape === true || input === ESC;
}

export function isUnhandledControlInput(input: string): boolean {
  if (input.length !== 1) return false;
  const code = input.charCodeAt(0);
  if (input === '\r' || input === '\n' || input === '\t') return false;
  return code < 32 || code === 127;
}

export function metaChordInput(
  input: string,
  key: Pick<ReturnKeyInput, 'ctrl' | 'meta'>,
): string | undefined {
  if (key.ctrl) return undefined;
  if (key.meta && input) return input;
  return input.startsWith(ESC) && input.length > 1 ? input.slice(1) : undefined;
}

// A return keypress that should act as Enter (submit / confirm / select).
// Deliberately shift-agnostic: in modals, Select, and the child-control picker
// Shift+Enter has no newline meaning and must still confirm. The text editor is
// the only place Shift+Enter differs (→ newline), and it discriminates by
// testing `isTextInputNewlineInput` *before* this — so accepting shift here can't
// make Shift+Enter also submit in the editor.
export function isPlainReturnInput(
  input: string,
  key: ReturnKeyInput,
): boolean {
  if (key.ctrl || key.meta || metaChordInput(input, key)) return false;
  return key.return === true || input === '\r' || input === '\n';
}

// Shift+Enter → literal newline, the ergonomic twin of Ctrl-J. Ink only
// reports `key.shift` on Enter when the Kitty keyboard protocol is active
// (enabled in runChatTui for terminals that support it). On terminals without
// it, Shift+Enter is byte-identical to Enter and falls through to submit, so
// Ctrl-J remains the universal fallback.
function isShiftReturnInput(input: string, key: ReturnKeyInput): boolean {
  if (key.ctrl || key.meta || key.shift !== true) return false;
  return key.return === true || input === '\r' || input === '\n';
}

/**
 * Text inputs treat Ctrl-J and Shift+Enter as literal newline insertion before
 * the shared Return handler can submit. Raw Ctrl-J arrives from Ink as bare LF
 * with no ctrl flag, while Kitty-capable terminals may surface either Ctrl+J as
 * a ctrl chord or Shift+Enter as a modified return.
 */
export function isTextInputNewlineInput(
  input: string,
  key: ReturnKeyInput,
): boolean {
  return (
    (input === '\n' && !key.meta) ||
    isCtrlInput(input, key, 'j') ||
    isShiftReturnInput(input, key)
  );
}
