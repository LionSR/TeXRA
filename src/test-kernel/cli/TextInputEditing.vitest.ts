import { describe, expect, it } from 'vitest';

import {
  applyTerminalInputChunk,
  deleteAtCursor,
  deleteBeforeCursor,
  deleteNextWord,
  deletePreviousWord,
  deleteToEnd,
  deleteToStart,
  insertText,
  lineEndCursor,
  lineStartCursor,
  nextWordCursor,
  previousWordCursor,
  verticalCursorMove,
} from '@cli/chat/tui/input/textInputEditing';
import {
  textInputCappedRowCount,
  textInputDisplayRowCount,
  textInputDisplayWindow,
} from '@cli/chat/tui/input/BaseTextInput';
import {
  isCtrlInput,
  isEscapeInput,
  isUnhandledControlInput,
  isPlainReturnInput,
  isTextInputNewlineInput,
  metaChordInput,
  normalizedCtrlInput,
  rewriteKittyEnterInput,
  SYNTHETIC_SHIFT_RETURN_INPUT,
} from '@cli/tui/inputKeys';

const ESC = '\u001B';
const NEWLINE_MODE = { shiftEnter: 'newline' } as const;
const PRESERVE_MODE = { shiftEnter: 'preserve' } as const;

describe('CLI TUI text input editing', () => {
  it('recognizes normalized and raw Enter without stealing Ctrl-J', () => {
    expect(isPlainReturnInput('', { return: true })).toBe(true);
    expect(isPlainReturnInput('\r', {})).toBe(true);
    expect(isPlainReturnInput('\n', {})).toBe(true);
    expect(isPlainReturnInput('j', { ctrl: true })).toBe(false);
    // Shift-agnostic: Shift+Enter still confirms in modals/Select. The editor
    // routes it to a newline by testing isShiftReturnInput first.
    expect(isPlainReturnInput('', { return: true, shift: true })).toBe(true);
    expect(isPlainReturnInput('\n', { ctrl: true })).toBe(false);
    expect(isPlainReturnInput('\u001Bp', {})).toBe(false);
  });

  it('treats Ctrl-J and Shift+Enter as literal newlines in text input', () => {
    expect(isTextInputNewlineInput('\n', {})).toBe(true);
    expect(isTextInputNewlineInput('j', { ctrl: true })).toBe(true);
    expect(isTextInputNewlineInput(SYNTHETIC_SHIFT_RETURN_INPUT, {})).toBe(
      true,
    );
    expect(isTextInputNewlineInput('', { return: true, shift: true })).toBe(
      true,
    );
    expect(isTextInputNewlineInput('\n', { meta: true })).toBe(false);
    expect(isTextInputNewlineInput('', { return: true, meta: true })).toBe(
      false,
    );
    expect(isTextInputNewlineInput('\r', {})).toBe(false);
    expect(isTextInputNewlineInput('', { return: true })).toBe(false);
  });

  it('recognizes Kitty Enter sequences for raw re-dispatch', () => {
    expect(rewriteKittyEnterInput(`${ESC}[57414u`, NEWLINE_MODE)).toBe('\r');
    expect(rewriteKittyEnterInput(`${ESC}[57414;1u`, NEWLINE_MODE)).toBe('\r');
    // Ink reports the semicolon CSI-u spelling as shifted Return, so the raw
    // shim must not emit a second synthetic newline for that exact chunk.
    expect(
      rewriteKittyEnterInput(`${ESC}[13;2u`, NEWLINE_MODE),
    ).toBeUndefined();
    // The colon spelling is not parsed by Ink; normalize it at the raw-event
    // layer so Shift+Enter still inserts a newline.
    expect(rewriteKittyEnterInput(`${ESC}[13:2u`, NEWLINE_MODE)).toBe(
      SYNTHETIC_SHIFT_RETURN_INPUT,
    );
    // Main Enter, plain CR, and modified keypad Enter must not match.
    expect(rewriteKittyEnterInput('\r', NEWLINE_MODE)).toBeUndefined();
    expect(rewriteKittyEnterInput(`${ESC}[13u`, NEWLINE_MODE)).toBeUndefined();
    expect(
      rewriteKittyEnterInput(`${ESC}[57414;5u`, NEWLINE_MODE),
    ).toBeUndefined();
    expect(
      rewriteKittyEnterInput(`${ESC}[13;5u`, NEWLINE_MODE),
    ).toBeUndefined();
  });

  it('rewrites batched Kitty Shift+Enter chunks before text editing', () => {
    const batched = `alpha${SYNTHETIC_SHIFT_RETURN_INPUT}beta`;
    const insertedNewline = {
      value: 'alpha\nbeta',
      cursor: 10,
      submit: false,
    };

    for (const chunk of [
      `alpha${ESC}[13;2ubeta`,
      `alpha${ESC}[13:2ubeta`,
      `alpha${ESC}[13;2;13ubeta`,
    ]) {
      const rewritten = rewriteKittyEnterInput(chunk, NEWLINE_MODE);
      expect(rewritten).toBe(batched);
      expect(applyTerminalInputChunk('', 0, rewritten ?? '')).toEqual(
        insertedNewline,
      );
    }

    const pressEventRewritten = rewriteKittyEnterInput(
      `alpha${ESC}[13;2:1ubeta`,
      NEWLINE_MODE,
    );

    expect(pressEventRewritten).toBe(batched);
  });

  it('preserves Shift+Enter while still rewriting keypad Enter', () => {
    expect(
      rewriteKittyEnterInput(`${ESC}[13:2u`, PRESERVE_MODE),
    ).toBeUndefined();
    expect(rewriteKittyEnterInput(`pick${ESC}[57414;1u`, PRESERVE_MODE)).toBe(
      'pick\r',
    );
  });

  it('does not rewrite Kitty Enter forms that Ink can handle or should ignore', () => {
    expect(
      rewriteKittyEnterInput(`${ESC}[13;2;13u`, NEWLINE_MODE),
    ).toBeUndefined();
    expect(
      rewriteKittyEnterInput(`alpha${ESC}[13;2:3ubeta`, NEWLINE_MODE),
    ).toBeUndefined();
    expect(
      rewriteKittyEnterInput(`alpha${ESC}[13;6ubeta`, NEWLINE_MODE),
    ).toBeUndefined();
    expect(
      rewriteKittyEnterInput(`alpha${ESC}[57414;5ubeta`, NEWLINE_MODE),
    ).toBeUndefined();
    expect(
      rewriteKittyEnterInput(`alpha${ESC}[57414;1:3ubeta`, NEWLINE_MODE),
    ).toBeUndefined();
  });

  it('recognizes Option/Alt chords from normalized meta and ESC-prefixed input', () => {
    expect(metaChordInput('p', { meta: true })).toBe('p');
    expect(metaChordInput('\u001Bp', {})).toBe('p');
    expect(metaChordInput('\u001B3', {})).toBe('3');
    expect(metaChordInput('p', { ctrl: true, meta: true })).toBeUndefined();
  });

  it('normalizes raw terminal control bytes for readline-style shortcuts', () => {
    expect(normalizedCtrlInput('\u0015', {})).toBe('u');
    expect(isCtrlInput('\u0015', {}, 'u')).toBe(true);
    expect(isCtrlInput('u', { ctrl: true }, 'u')).toBe(true);
    expect(isCtrlInput('\u0015', { meta: true }, 'u')).toBe(false);
    expect(normalizedCtrlInput('\u0016', {})).toBe('v');
    expect(isCtrlInput('\u0016', {}, 'v')).toBe(true);
    expect(isCtrlInput('\u0016', { meta: true }, 'v')).toBe(false);
    expect(isEscapeInput('\u001B', {})).toBe(true);
    expect(isUnhandledControlInput('\u0006')).toBe(true);
    expect(isUnhandledControlInput('\t')).toBe(false);
  });

  it('applies batched terminal input without leaking raw control bytes', () => {
    expect(applyTerminalInputChunk('/', 1, '\u0015/model\r')).toEqual({
      value: '/model',
      cursor: 6,
      submit: true,
    });
    expect(applyTerminalInputChunk('one two three', 8, '\u0017X')).toEqual({
      value: 'one Xthree',
      cursor: 5,
      submit: false,
    });
  });

  it('keeps LF and embedded CRLF as newlines inside raw text chunks', () => {
    expect(applyTerminalInputChunk('', 0, 'alpha\nbeta')).toEqual({
      value: 'alpha\nbeta',
      cursor: 10,
      submit: false,
    });
    expect(applyTerminalInputChunk('', 0, 'alpha\nbeta\r')).toEqual({
      value: 'alpha\nbeta',
      cursor: 10,
      submit: true,
    });
    expect(applyTerminalInputChunk('', 0, 'alpha\r\nbeta\r')).toEqual({
      value: 'alpha\nbeta',
      cursor: 10,
      submit: true,
    });
  });

  it('inserts pasted multi-line text without submitting embedded newlines', () => {
    expect(insertText('ab', 1, 'x\ny')).toEqual({
      value: 'ax\nyb',
      cursor: 4,
    });
  });

  it('uses Ctrl-J semantics as literal newline insertion', () => {
    expect(insertText('alpha beta', 5, '\n')).toEqual({
      value: 'alpha\n beta',
      cursor: 6,
    });
  });

  it('handles backspace and delete at buffer edges', () => {
    expect(deleteBeforeCursor('abc', 0)).toEqual({
      value: 'abc',
      cursor: 0,
    });
    expect(deleteBeforeCursor('abc', 2)).toEqual({
      value: 'ac',
      cursor: 1,
    });
    expect(deleteAtCursor('abc', 3)).toEqual({
      value: 'abc',
      cursor: 3,
    });
    expect(deleteAtCursor('abc', 1)).toEqual({
      value: 'ac',
      cursor: 1,
    });
  });

  it('implements Ctrl-U, Ctrl-K, and Ctrl-W editing', () => {
    expect(deleteToStart('one two three', 8)).toEqual({
      value: 'three',
      cursor: 0,
    });
    expect(deleteToEnd('one two three', 7)).toEqual({
      value: 'one two',
      cursor: 7,
    });
    expect(deletePreviousWord('one two three', 8)).toEqual({
      value: 'one three',
      cursor: 4,
    });
  });

  it('scopes Ctrl-U and Ctrl-K to the current line in multiline drafts', () => {
    expect(deleteToStart('alpha\nbeta gamma\ndelta', 10)).toEqual({
      value: 'alpha\n gamma\ndelta',
      cursor: 6,
    });
    expect(deleteToEnd('alpha\nbeta gamma\ndelta', 10)).toEqual({
      value: 'alpha\nbeta\ndelta',
      cursor: 10,
    });
    // Ctrl-K at the end of a line kills the newline (joins the next line).
    expect(deleteToEnd('alpha\nbeta', 5)).toEqual({
      value: 'alphabeta',
      cursor: 5,
    });
  });

  it('moves Home/End (Ctrl-A/E) to the current line boundaries', () => {
    expect(lineStartCursor('one two', 4)).toBe(0);
    expect(lineEndCursor('one two', 4)).toBe(7);
    expect(lineStartCursor('alpha\nbeta gamma', 10)).toBe(6);
    expect(lineEndCursor('alpha\nbeta gamma\ndelta', 10)).toBe(16);
  });

  it('implements word-wise movement for Alt-B/F and Ctrl-arrows', () => {
    expect(previousWordCursor('one two three', 8)).toBe(4);
    expect(previousWordCursor('one two three', 6)).toBe(4);
    expect(previousWordCursor('one two three', 0)).toBe(0);
    expect(nextWordCursor('one two three', 8)).toBe(13);
    expect(nextWordCursor('one two three', 3)).toBe(7);
    expect(nextWordCursor('one two three', 13)).toBe(13);
  });

  it('implements Alt-D forward word kill', () => {
    expect(deleteNextWord('one two three', 4)).toEqual({
      value: 'one  three',
      cursor: 4,
    });
    expect(deleteNextWord('one two three', 3)).toEqual({
      value: 'one three',
      cursor: 3,
    });
    expect(deleteNextWord('one', 3)).toEqual({ value: 'one', cursor: 3 });
  });

  it('moves the caret between logical lines on ↑/↓, preserving the column', () => {
    // "alpha\nbe\ngamma": ↓ from column 3 of line 0 clamps to line 1's end.
    expect(verticalCursorMove('alpha\nbe\ngamma', 3, 1)).toBe(8);
    expect(verticalCursorMove('alpha\nbe\ngamma', 7, 1)).toBe(10);
    expect(verticalCursorMove('alpha\nbe\ngamma', 10, -1)).toBe(7);
    // Boundary lines yield undefined so the caller can recall history.
    expect(verticalCursorMove('alpha\nbe', 2, -1)).toBeUndefined();
    expect(verticalCursorMove('alpha\nbe', 7, 1)).toBeUndefined();
    expect(verticalCursorMove('single line', 4, -1)).toBeUndefined();
    expect(verticalCursorMove('single line', 4, 1)).toBeUndefined();
  });
});

describe('textInputDisplayRowCount', () => {
  it('matches the component soft-break rows and reserves the caret row', () => {
    // Fits with room to spare: one row.
    expect(textInputDisplayRowCount('short', 38)).toBe(1);
    // Word-boundary soft wrap: two rows, last row not full — no caret row.
    expect(
      textInputDisplayRowCount('draft survives resize and accepts input', 38),
    ).toBe(2);
    // Exactly-full single row: the end-of-value caret wraps to its own row.
    expect(textInputDisplayRowCount('a'.repeat(38), 38)).toBe(2);
    // Hard newlines count as rows.
    expect(textInputDisplayRowCount('one\ntwo', 38)).toBe(2);
    expect(textInputDisplayRowCount('', 38)).toBe(1);
  });
});

describe('textInputDisplayWindow', () => {
  it('reserves a height-capped row for the end-of-value caret on a full last line', () => {
    // Five full rows of content (width 4 → 4 chars each). Caret at EOF wants a
    // sixth visual row; with maxDisplayRows=5 the window must drop one content
    // row so the caret wrap fits inside the budget instead of clipping.
    const value = 'aaaa\nbbbb\ncccc\ndddd\neeee';
    const width = 4;
    expect(textInputDisplayRowCount(value, width)).toBe(6);
    // InputBar pairs this height with maxDisplayRows so the window and Box
    // share one budget (the caret row is not discarded by the ceiling).
    expect(textInputCappedRowCount(value, width, 5)).toBe(5);
    const windowed = textInputDisplayWindow({
      cursor: value.length,
      maxDisplayRows: textInputCappedRowCount(value, width, 5),
      value,
      width,
    });
    // Four content rows + room for the caret row; leading content is clipped.
    expect(windowed.clipped).toBe(true);
    expect(windowed.value.split('\n')).toHaveLength(4);
    expect(windowed.cursor).toBe(windowed.value.length);
  });
});
