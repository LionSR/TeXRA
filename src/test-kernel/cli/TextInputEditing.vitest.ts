import { describe, expect, it } from 'vitest';

import { applyTerminalInputChunk } from '@cli/chat/tui/input/textInputBindings';
import {
  deletePreviousWord,
  deleteToEnd,
  deleteToStart,
  insertText,
  verticalCursorMove,
} from '@cli/chat/tui/input/textInputEditing';
import {
  textInputCappedRowCount,
  textInputDisplayWindow,
} from '@cli/chat/tui/input/textInputDisplay';
import {
  isPlainReturnInput,
  isTextInputNewlineInput,
  rewriteKittyEnterInput,
  SYNTHETIC_SHIFT_RETURN_INPUT,
} from '@cli/tui/inputKeys';

const ESC = '\u001B';
const NEWLINE_MODE = { shiftEnter: 'newline' } as const;

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

  it('inserts pasted multi-line text without submitting embedded newlines', () => {
    expect(insertText('ab', 1, 'x\ny')).toEqual({
      value: 'ax\nyb',
      cursor: 4,
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

describe('textInputDisplayWindow', () => {
  it('reserves a height-capped row for the end-of-value caret on a full last line', () => {
    // Five full rows of content (width 4 → 4 chars each). Caret at EOF wants a
    // sixth visual row; with maxDisplayRows=5 the window must drop one content
    // row so the caret wrap fits inside the budget instead of clipping.
    const value = 'aaaa\nbbbb\ncccc\ndddd\neeee';
    const width = 4;
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
