import { describe, expect, it } from 'vitest';

import {
  deleteAtCursor,
  deleteBeforeCursor,
  deletePreviousWord,
  deleteToEnd,
  deleteToStart,
  insertText,
} from '../../../packages/cli/src/chat/tui/input/textInputEditing';
import { isPlainReturnInput } from '../../../packages/cli/src/chat/tui/input/inputKeys';

describe('CLI TUI text input editing', () => {
  it('recognizes normalized and raw Enter without stealing Ctrl-J', () => {
    expect(isPlainReturnInput('', { return: true })).toBe(true);
    expect(isPlainReturnInput('\r', {})).toBe(true);
    expect(isPlainReturnInput('\n', {})).toBe(true);
    expect(isPlainReturnInput('j', { ctrl: true })).toBe(false);
    expect(isPlainReturnInput('\n', { ctrl: true })).toBe(false);
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
});
