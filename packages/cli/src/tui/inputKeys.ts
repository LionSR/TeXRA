export interface ReturnKeyInput {
  readonly return?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly escape?: boolean;
}

export const SYNTHETIC_SHIFT_RETURN_INPUT = '\uE000';
const ESC = String.fromCharCode(27);

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

export function normalizedCtrlInput(
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
  return key.escape === true || input === '\u001B';
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
  return input.startsWith('\u001B') && input.length > 1
    ? input.slice(1)
    : undefined;
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
  if (input === SYNTHETIC_SHIFT_RETURN_INPUT) return true;
  if (key.ctrl || key.meta || key.shift !== true) return false;
  return key.return === true || input === '\r' || input === '\n';
}

/**
 * Text inputs treat Ctrl-J and Shift+Enter as literal newline insertion before
 * the shared Return handler can submit. Raw Ctrl-J arrives from Ink as bare LF
 * with no ctrl flag, while Kitty-capable terminals may surface either Ctrl+J as
 * a ctrl chord or Shift+Enter as a modified return/synthetic token.
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

const KITTY_KEYPAD_ENTER_CODEPOINT = '57414';
const KITTY_SHIFT_MODIFIER_BITS = 1;
const KITTY_NO_MODIFIER_BITS = 0;

// Kitty keyboard protocol: CSI codepoint ; modifiers [: eventType]
// [; text-as-codepoints] u. Some terminals also emit the colon-only spelling
// CSI codepoint : modifiers u for shifted Return, which Ink does not parse.
const KITTY_ENTER_INPUT_RE = new RegExp(
  `${ESC}\\[(13|57414)(?:([;:])(\\d+)(?::(\\d+))?(?:;[\\d:]+)?)?u`,
  'g',
);

interface KittyEnterInput {
  readonly delimiter?: ';' | ':';
  readonly eventType?: number;
  readonly key: 'mainEnter' | 'keypadEnter';
  readonly modifierBits: number;
}

function parseKittyEnterInput(
  codepoint: string,
  delimiter: string | undefined,
  modifier: string | undefined,
  eventType: string | undefined,
): KittyEnterInput {
  const modifierBits =
    modifier == null
      ? KITTY_NO_MODIFIER_BITS
      : Math.max(KITTY_NO_MODIFIER_BITS, Number(modifier) - 1);
  const parsedDelimiter =
    delimiter === ';' || delimiter === ':' ? delimiter : undefined;
  return {
    delimiter: parsedDelimiter,
    eventType: eventType == null ? undefined : Number(eventType),
    key:
      codepoint === KITTY_KEYPAD_ENTER_CODEPOINT ? 'keypadEnter' : 'mainEnter',
    modifierBits,
  };
}

function isInkParsedStandaloneShiftEnterInput(
  data: string,
  sequence: string,
  offset: number,
  input: KittyEnterInput,
): boolean {
  return (
    offset === 0 &&
    sequence.length === data.length &&
    input.delimiter === ';' &&
    input.key === 'mainEnter' &&
    input.modifierBits === KITTY_SHIFT_MODIFIER_BITS
  );
}

function rewriteKittyEnterMatch(
  data: string,
  sequence: string,
  offset: number,
  input: KittyEnterInput,
  shiftEnter: 'newline' | 'preserve',
): string {
  if (input.eventType === 3) return sequence;
  if (
    input.key === 'keypadEnter' &&
    input.modifierBits === KITTY_NO_MODIFIER_BITS
  ) {
    return '\r';
  }
  if (shiftEnter === 'preserve') return sequence;
  if (
    input.key === 'mainEnter' &&
    input.modifierBits === KITTY_SHIFT_MODIFIER_BITS
  ) {
    return isInkParsedStandaloneShiftEnterInput(data, sequence, offset, input)
      ? sequence
      : SYNTHETIC_SHIFT_RETURN_INPUT;
  }
  return sequence;
}

export function rewriteKittyEnterInput(
  data: string,
  options: { readonly shiftEnter: 'newline' | 'preserve' },
): string | undefined {
  const rewritten = data.replaceAll(
    KITTY_ENTER_INPUT_RE,
    (
      sequence,
      codepoint: string,
      delimiter: string | undefined,
      modifier: string | undefined,
      eventType: string | undefined,
      offset: number,
    ) =>
      rewriteKittyEnterMatch(
        data,
        sequence,
        offset,
        parseKittyEnterInput(codepoint, delimiter, modifier, eventType),
        options.shiftEnter,
      ),
  );
  return rewritten === data ? undefined : rewritten;
}
