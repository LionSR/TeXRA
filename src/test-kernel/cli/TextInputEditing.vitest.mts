import { describe, expect, it } from 'vitest';

import {
  applyTerminalInputChunk,
  deleteAtCursor,
  deleteBeforeCursor,
  deletePreviousWord,
  deleteToEnd,
  deleteToStart,
  insertText,
} from '@cli/chat/tui/input/textInputEditing';
import {
  isCtrlInput,
  isEscapeInput,
  isUnhandledControlInput,
  isKittyKeypadEnter,
  isPlainReturnInput,
  isShiftReturnInput,
  metaChordDigit,
  metaChordInput,
  normalizedCtrlInput,
} from '@cli/chat/tui/input/inputKeys';

const ESC = String.fromCharCode(27);

describe('CLI TUI text input editing', () => {
  it('recognizes normalized and raw Enter without stealing Ctrl-J', () => {
    expect(isPlainReturnInput('', { return: true })).toBe(true);
    expect(isPlainReturnInput('\r', {})).toBe(true);
    expect(isPlainReturnInput('\n', {})).toBe(true);
    expect(isPlainReturnInput('j', { ctrl: true })).toBe(false);
    // Shift-agnostic: Shift+Enter still confirms in modals/Select. The editor
    // routes it to a newline by testing isShiftReturnInput first (see below).
    expect(isPlainReturnInput('', { return: true, shift: true })).toBe(true);
    expect(isPlainReturnInput('\n', { ctrl: true })).toBe(false);
    expect(isPlainReturnInput('\u001Bp', {})).toBe(false);
  });

  it('treats Shift+Enter as a newline, distinct from plain Enter and Ctrl-J', () => {
    expect(isShiftReturnInput('', { return: true, shift: true })).toBe(true);
    // Plain Enter, Ctrl-J, and Option+Enter are not Shift+Enter.
    expect(isShiftReturnInput('', { return: true })).toBe(false);
    expect(isShiftReturnInput('j', { ctrl: true })).toBe(false);
    expect(isShiftReturnInput('', { return: true, meta: true })).toBe(false);
  });

  it('recognizes the Kitty keypad-Enter sequence for re-dispatch as Enter', () => {
    expect(isKittyKeypadEnter(`${ESC}[57414u`)).toBe(true);
    expect(isKittyKeypadEnter(`${ESC}[57414;1u`)).toBe(true);
    // Main Enter, plain CR, and modified keypad Enter must not match.
    expect(isKittyKeypadEnter('\r')).toBe(false);
    expect(isKittyKeypadEnter(`${ESC}[13u`)).toBe(false);
    expect(isKittyKeypadEnter(`${ESC}[57414;5u`)).toBe(false);
  });

  it('recognizes Option/Alt chords from normalized meta and ESC-prefixed input', () => {
    expect(metaChordInput('p', { meta: true })).toBe('p');
    expect(metaChordInput('\u001Bp', {})).toBe('p');
    expect(metaChordInput('\u001B3', {})).toBe('3');
    expect(metaChordInput('p', { ctrl: true, meta: true })).toBeUndefined();
  });

  it('parses Option/Alt digit shortcuts after chord normalization', () => {
    expect(metaChordDigit('3', { meta: true })).toBe(3);
    expect(metaChordDigit('\u001B3', {})).toBe(3);
    expect(metaChordDigit('\u001Bp', {})).toBeUndefined();
    expect(metaChordDigit('\u001B0', {})).toBeUndefined();
  });

  it('normalizes raw terminal control bytes for readline-style shortcuts', () => {
    expect(normalizedCtrlInput('\u0015', {})).toBe('u');
    expect(isCtrlInput('\u0015', {}, 'u')).toBe(true);
    expect(isCtrlInput('u', { ctrl: true }, 'u')).toBe(true);
    expect(isCtrlInput('\u0015', { meta: true }, 'u')).toBe(false);
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
