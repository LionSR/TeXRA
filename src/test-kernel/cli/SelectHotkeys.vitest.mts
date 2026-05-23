import { describe, expect, it } from 'vitest';

import {
  hotkeyIndex,
  selectHotkeyHint,
  selectIndexLabel,
} from '../../../packages/cli/src/chat/tui/ui/Select';

describe('CLI Select hotkey ergonomics', () => {
  it('maps 1-9 to indices 0-8', () => {
    expect(hotkeyIndex('1')).toBe(0);
    expect(hotkeyIndex('9')).toBe(8);
  });

  it('maps a-z to indices 9-34 so items past 9 stay one-key reachable', () => {
    expect(hotkeyIndex('a')).toBe(9);
    expect(hotkeyIndex('z')).toBe(9 + 25);
  });

  it('rejects keystrokes that do not bind a hotkey', () => {
    expect(hotkeyIndex('0')).toBeUndefined();
    expect(hotkeyIndex('A')).toBeUndefined(); // uppercase reserved for shifted shortcuts elsewhere
    expect(hotkeyIndex('!')).toBeUndefined();
    expect(hotkeyIndex('')).toBeUndefined();
    expect(hotkeyIndex('ab')).toBeUndefined();
  });

  it('renders the leading slot consistently with the bound keystroke', () => {
    expect(selectIndexLabel(0)).toBe('1.');
    expect(selectIndexLabel(8)).toBe('9.');
    expect(selectIndexLabel(9)).toBe('a.');
    expect(selectIndexLabel(34)).toBe('z.');
    expect(selectIndexLabel(35)).toBe('  '); // beyond a-z: arrow-key only
  });

  it('hints just `1-9` for small pickers and `1-9 a-z` once items overflow', () => {
    expect(selectHotkeyHint(0)).toBe('');
    expect(selectHotkeyHint(1)).toBe('1-9');
    expect(selectHotkeyHint(9)).toBe('1-9');
    expect(selectHotkeyHint(10)).toBe('1-9 a-z');
    expect(selectHotkeyHint(35)).toBe('1-9 a-z');
  });
});
