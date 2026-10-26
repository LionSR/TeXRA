import { describe, expect, it } from 'vitest';

import { selectIndexForHotkeyInput } from '@cli/tui/ui/Select';

describe('Select hotkeys (packages/cli/src/tui/ui/Select.tsx)', () => {
  it('does not treat command-like buffered text as a row hotkey', () => {
    expect(selectIndexForHotkeyInput('model')).toBeUndefined();
    expect(selectIndexForHotkeyInput('/model')).toBeUndefined();
    expect(selectIndexForHotkeyInput('\u001Bm')).toBeUndefined();
  });
});
