// Declarative readline-style keymap for BaseTextInput.
//
// One entry per editing chord: the matcher that recognizes the keypress, the
// pure editing primitive it applies, and the label/action that document it.
// This table is the single source of truth — BaseTextInput dispatches through
// it and `/help` renders the advertised rows from it, so a documented chord
// that doesn't exist (or an implemented chord nobody can discover) is
// structurally impossible.
//
// Order is precedence: earlier entries win, so modified chords
// (Alt-Backspace, Ctrl/Alt-arrows) must precede their unmodified bases. The
// audit in TextInputBindings.vitest.mts probes every chord and fails on
// shadowed or unreachable entries.
//
// Deliberately NOT in this table: stateful interactions that need component
// context — Enter (submit), Ctrl-J/Shift-Enter (newline), Esc (cancel paste),
// ↑/↓ (line motion falling back to history recall), and Ctrl-V (async image
// paste). Those stay explicit in BaseTextInput.

import { isCtrlInput, metaChordInput } from '@cli/tui/inputKeys';
import {
  deleteAtCursor,
  deleteBeforeCursor,
  deleteNextWord,
  deletePreviousWord,
  deleteToEnd,
  deleteToStart,
  lineEndCursor,
  lineStartCursor,
  nextWordCursor,
  previousWordCursor,
  type CursorEdit,
} from './textInputEditing';

/** Structural subset of Ink's `Key` consulted by the keymap matchers. */
export interface TextInputKey {
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

export type TextInputBinding = {
  /** Chord label shown in docs and audits, e.g. `Ctrl-W / Alt-Backspace`. */
  readonly keys: string;
  readonly action: string;
  /** Rendered in the /help keyboard section. Omit for self-evident keys
   *  (plain arrows, Backspace) so the docs stay short. */
  readonly advertise?: boolean;
  readonly matches: (input: string, key: TextInputKey) => boolean;
} & (
  | { readonly edit: CursorEdit }
  | { readonly move: (value: string, cursor: number) => number }
);

const wordModified = (key: TextInputKey): boolean =>
  key.ctrl === true || key.meta === true;

export const TEXT_INPUT_BINDINGS: readonly TextInputBinding[] = [
  {
    keys: 'Ctrl-W / Alt-Backspace',
    action: 'delete word left',
    advertise: true,
    matches: (input, key) => {
      // Terminals surface Alt-Backspace as a meta-flagged backspace/DEL or
      // as the raw ESC+DEL chord.
      const chord = metaChordInput(input, key);
      return (
        isCtrlInput(input, key, 'w') ||
        ((key.backspace === true || key.delete === true) &&
          key.meta === true) ||
        chord === '\u007F' ||
        chord === '\b'
      );
    },
    edit: deletePreviousWord,
  },
  {
    keys: 'Alt-D',
    action: 'delete word right',
    advertise: true,
    matches: (input, key) => metaChordInput(input, key) === 'd',
    edit: deleteNextWord,
  },
  {
    keys: 'Alt-B / Ctrl-←',
    action: 'word left',
    advertise: true,
    matches: (input, key) =>
      metaChordInput(input, key) === 'b' ||
      (key.leftArrow === true && wordModified(key)),
    move: previousWordCursor,
  },
  {
    keys: 'Alt-F / Ctrl-→',
    action: 'word right',
    advertise: true,
    matches: (input, key) =>
      metaChordInput(input, key) === 'f' ||
      (key.rightArrow === true && wordModified(key)),
    move: nextWordCursor,
  },
  {
    keys: 'Backspace',
    action: 'delete left',
    matches: (_input, key) => key.backspace === true,
    edit: deleteBeforeCursor,
  },
  {
    keys: 'Delete',
    action: 'delete right',
    matches: (_input, key) => key.delete === true,
    edit: deleteAtCursor,
  },
  {
    keys: '←',
    action: 'left',
    matches: (_input, key) => key.leftArrow === true,
    move: (_value, cursor) => cursor - 1,
  },
  {
    keys: '→',
    action: 'right',
    matches: (_input, key) => key.rightArrow === true,
    move: (_value, cursor) => cursor + 1,
  },
  {
    keys: 'Home / Ctrl-A',
    action: 'line start',
    matches: (input, key) => key.home === true || isCtrlInput(input, key, 'a'),
    move: lineStartCursor,
  },
  {
    keys: 'End / Ctrl-E',
    action: 'line end',
    matches: (input, key) => key.end === true || isCtrlInput(input, key, 'e'),
    move: lineEndCursor,
  },
  {
    keys: 'Ctrl-U',
    action: 'delete to line start',
    advertise: true,
    matches: (input, key) => isCtrlInput(input, key, 'u'),
    edit: deleteToStart,
  },
  {
    keys: 'Ctrl-K',
    action: 'delete to line end',
    advertise: true,
    matches: (input, key) => isCtrlInput(input, key, 'k'),
    edit: deleteToEnd,
  },
];

export function matchTextInputBinding(
  input: string,
  key: TextInputKey,
): TextInputBinding | undefined {
  return TEXT_INPUT_BINDINGS.find((binding) => binding.matches(input, key));
}

/** `/help` row for the advertised editing chords — generated from the keymap
 *  so the docs can never drift from the implemented bindings. */
export function textInputEditingHelp(): string {
  return TEXT_INPUT_BINDINGS.filter((binding) => binding.advertise)
    .map((binding) => `\`${binding.keys}\` ${binding.action}`)
    .join(' · ');
}
