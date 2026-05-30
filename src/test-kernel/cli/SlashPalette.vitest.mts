import { describe, expect, it } from 'vitest';

import {
  nextSlashPaletteHighlight,
  slashPaletteWindow,
} from '@cli/chat/tui/commands/SlashPalette';

describe('SlashPalette navigation', () => {
  it('continues down into commands hidden behind the overflow marker', () => {
    const itemCount = 14;
    expect(
      slashPaletteWindow({
        highlight: 7,
        itemCount,
        maxVisibleCommands: 8,
      }),
    ).toEqual({
      start: 0,
      end: 8,
      hiddenBefore: 0,
      hiddenAfter: 6,
    });

    const next = nextSlashPaletteHighlight({
      direction: 1,
      highlight: 7,
      itemCount,
    });

    expect(next).toBe(8);
    expect(
      slashPaletteWindow({
        highlight: next,
        itemCount,
        maxVisibleCommands: 8,
      }),
    ).toEqual({
      start: 6,
      end: 14,
      hiddenBefore: 6,
      hiddenAfter: 0,
    });
  });

  it('wraps navigation across the full match list', () => {
    expect(
      nextSlashPaletteHighlight({
        direction: 1,
        highlight: 13,
        itemCount: 14,
      }),
    ).toBe(0);
    expect(
      nextSlashPaletteHighlight({
        direction: -1,
        highlight: 0,
        itemCount: 14,
      }),
    ).toBe(13);
  });
});
