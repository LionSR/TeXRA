import { describe, expect, it } from 'vitest';

import { clipToWidth, truncateToWidth } from '@cli/runtime/terminalText';

describe('terminal text width limits', () => {
  describe('clipToWidth', () => {
    it('hard-clips plain text at widths 0, 1, and 2', () => {
      expect([
        clipToWidth('ab', 0),
        clipToWidth('ab', 1),
        clipToWidth('ab', 2),
      ]).toEqual(['', 'a', 'ab']);
    });

    it('does not split wide or multi-code-point graphemes', () => {
      expect(clipToWidth('界a', 1)).toBe('');
      expect(clipToWidth('界a', 2)).toBe('界');
      expect(clipToWidth('e\u0301x', 1)).toBe('e\u0301');
      expect(clipToWidth('👨‍👩‍👧‍👦x', 1)).toBe('');
      expect(clipToWidth('👨‍👩‍👧‍👦x', 2)).toBe('👨‍👩‍👧‍👦');
    });

    it('closes ANSI styles when clipping styled text', () => {
      expect(clipToWidth('\u001B[31mab\u001B[39m', 1)).toBe(
        '\u001B[31ma\u001B[39m',
      );
    });
  });

  describe('truncateToWidth', () => {
    it('uses the default Unicode ellipsis when truncating', () => {
      expect([
        truncateToWidth('abc', 0),
        truncateToWidth('abc', 1),
        truncateToWidth('abc', 2),
      ]).toEqual(['', '…', 'a…']);
    });
  });
});
