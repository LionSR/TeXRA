import { describe, expect, it } from 'vitest';

import {
  isRawSelectEscChordInput,
  isRawSelectNavigationInput,
  rawSelectArrowDirection,
  selectHotkeyForIndex,
  selectIndexForHotkey,
  selectIndexForHotkeyInput,
} from '@cli/tui/ui/Select';

describe('Select hotkeys', () => {
  it('numbers the first nine rows 1-9, then letters a-z for 10-35', () => {
    expect(selectHotkeyForIndex(0)).toBe('1');
    expect(selectHotkeyForIndex(8)).toBe('9');
    expect(selectHotkeyForIndex(9)).toBe('a');
    expect(selectHotkeyForIndex(10)).toBe('b');
    expect(selectHotkeyForIndex(34)).toBe('z');
  });

  it('has no shortcut for rows beyond z or below zero', () => {
    expect(selectHotkeyForIndex(35)).toBeUndefined();
    expect(selectHotkeyForIndex(-1)).toBeUndefined();
  });

  it('maps a typed key back to its row index (round-trip)', () => {
    for (const index of [0, 8, 9, 10, 34]) {
      const key = selectHotkeyForIndex(index);
      expect(key).toBeDefined();
      expect(selectIndexForHotkey(key as string)).toBe(index);
    }
  });

  it('accepts uppercase letters and rejects non-shortcut input', () => {
    expect(selectIndexForHotkey('A')).toBe(9);
    expect(selectIndexForHotkey('0')).toBeUndefined();
    expect(selectIndexForHotkey('')).toBeUndefined();
    expect(selectIndexForHotkey('ab')).toBeUndefined();
  });

  it('uses the first shortcut from buffered terminal input', () => {
    expect(selectIndexForHotkeyInput('21')).toBe(1);
    expect(selectIndexForHotkeyInput('A1')).toBe(9);
    expect(selectIndexForHotkeyInput('m\r')).toBe(21);
    expect(selectIndexForHotkeyInput('0a')).toBeUndefined();
    expect(selectIndexForHotkeyInput('')).toBeUndefined();
  });

  it('does not treat command-like buffered text as a row hotkey', () => {
    expect(selectIndexForHotkeyInput('model')).toBeUndefined();
    expect(selectIndexForHotkeyInput('/model')).toBeUndefined();
    expect(selectIndexForHotkeyInput('\u001Bm')).toBeUndefined();
  });

  it('separates raw escape chords from terminal navigation prefixes', () => {
    expect(isRawSelectEscChordInput('\u001Bm')).toBe(true);
    expect(isRawSelectEscChordInput('\u001B[')).toBe(false);
    expect(isRawSelectEscChordInput('\u001BO')).toBe(false);
    expect(isRawSelectNavigationInput('\u001B[')).toBe(true);
    expect(isRawSelectNavigationInput('\u001B[A')).toBe(true);
    expect(isRawSelectNavigationInput('\u001BO')).toBe(true);
    expect(isRawSelectNavigationInput('\u001BOA')).toBe(true);
  });

  it('recognizes raw arrow inputs when Ink misses key flags', () => {
    expect(rawSelectArrowDirection('\u001B[A')).toBe(-1);
    expect(rawSelectArrowDirection('\u001B[B')).toBe(1);
    expect(rawSelectArrowDirection('\u001BOA')).toBe(-1);
    expect(rawSelectArrowDirection('\u001BOB')).toBe(1);
    expect(rawSelectArrowDirection('\u001B[6~')).toBeUndefined();
  });
});
