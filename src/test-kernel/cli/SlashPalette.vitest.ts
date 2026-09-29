import { describe, expect, it } from 'vitest';

import { slashPaletteOwnsArrows } from '@cli/chat/tui/commands/SlashPalette';
import { nextWrappingHighlightIndex } from '@cli/tui/ui/Select';

describe('SlashPalette navigation', () => {
  it('wraps navigation across the full match list', () => {
    expect(
      nextWrappingHighlightIndex({
        direction: 1,
        highlight: 14,
        itemCount: 15,
      }),
    ).toBe(0);
    expect(
      nextWrappingHighlightIndex({
        direction: -1,
        highlight: 0,
        itemCount: 15,
      }),
    ).toBe(14);
  });

  it('owns ↑/↓ only when there is a real choice to make', () => {
    // With 0 or 1 matches the arrows stay with the text input for history
    // recall — a fully typed command name must not block recalling drafts.
    expect(slashPaletteOwnsArrows(0)).toBe(false);
    expect(slashPaletteOwnsArrows(1)).toBe(false);
    expect(slashPaletteOwnsArrows(2)).toBe(true);
  });
});
