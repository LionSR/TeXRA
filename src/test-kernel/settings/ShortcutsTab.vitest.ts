import { describe, expect, it } from 'vitest';

import { keyboardEventToAccelerator } from '@shared/commands/shortcutPreferences';

describe('shortcuts-tab', () => {
  it('normalizes customizable desktop key chords', () => {
    expect(
      keyboardEventToAccelerator(
        {
          key: 'k',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        } as KeyboardEvent,
        'darwin',
      ),
    ).toBe('Command+Shift+K');
    expect(
      keyboardEventToAccelerator(
        {
          key: 'F8',
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        } as KeyboardEvent,
        'linux',
      ),
    ).toBe('F8');
  });
});
