import { describe, expect, it } from 'vitest';

import {
  selectHotkeyForIndex,
  selectIndexForHotkey,
} from '@cli/chat/tui/ui/Select';

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
});
