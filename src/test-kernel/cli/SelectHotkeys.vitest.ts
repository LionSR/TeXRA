import { describe, expect, it } from 'vitest';

import { selectIndexForHotkeyInput } from '@cli/tui/ui/Select';

describe('Select hotkeys (packages/cli/src/tui/ui/Select.tsx)', () => {
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
});
