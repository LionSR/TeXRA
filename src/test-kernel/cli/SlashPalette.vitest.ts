import { describe, expect, it } from 'vitest';

import {
  slashPaletteCommandLabelWidth,
  slashPaletteEnterHintAction,
  slashPaletteOwnsArrows,
  slashPaletteWindow,
} from '@cli/chat/tui/commands/SlashPalette';
import { nextWrappingHighlightIndex } from '@cli/tui/ui/Select';

describe('SlashPalette navigation', () => {
  it('continues down into commands hidden behind the overflow marker', () => {
    const itemCount = 15;
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
      hiddenAfter: 7,
    });

    const next = nextWrappingHighlightIndex({
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
      start: 7,
      end: 15,
      hiddenBefore: 7,
      hiddenAfter: 0,
    });
  });

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

  it('describes what Enter does for the highlighted slash command', () => {
    expect(
      slashPaletteEnterHintAction({
        name: 'help',
        description: 'show help',
      }),
    ).toBe('run');
    expect(
      slashPaletteEnterHintAction({
        name: 'model',
        description: 'choose model',
        formComponent: () => null,
      }),
    ).toBe('open');
  });

  it('reserves enough row width for full slash command names', () => {
    expect(
      slashPaletteCommandLabelWidth([
        { name: 'api', description: 'Switch API mode' },
        { name: 'yolo', description: 'Approve automatically' },
      ]),
    ).toBe('  /yolo  '.length);
  });
});
