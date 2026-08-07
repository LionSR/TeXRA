// Tests for the CLI TUI's ANSI-aware line wrapper (wrapAnsiToWidth).
//
// We don't snapshot the exact ANSI bytes — that locks the layout in too hard.
// Instead, verify the wrapper keeps every visible line within the requested
// display width while preserving escape sequences (charset switches, C1
// controls, OSC hyperlinks) across wrap boundaries.

import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';

import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';

const ESC = String.fromCharCode(27);

const WIDE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0x1f300, 0x1faff],
];

function displayWidthForTest(line: string): number {
  let width = 0;
  for (const char of line) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += WIDE_CODE_POINT_RANGES.some(
      ([low, high]) => codePoint >= low && codePoint <= high,
    )
      ? 2
      : 1;
  }
  return width;
}

/** Strips ANSI, asserts every line fits `width`, and returns the plain lines. */
function plainLinesWithinWidth(rendered: string, width: number): string[] {
  const lines = stripAnsi(rendered).split('\n');
  for (const line of lines) {
    expect(displayWidthForTest(line)).toBeLessThanOrEqual(width);
  }
  return lines;
}

describe('wrapAnsiToWidth', () => {
  it.each([
    {
      name: 'ANSI charset escapes',
      input: `${ESC}(0│ ${ESC}(B  • abcdef ghijkl mnopqr`,
      absent: ['0│', 'B  •'],
    },
    {
      name: 'C1-ST OSC hyperlinks',
      input: `${ESC}]8;;https://example.test${String.fromCharCode(
        0x9c,
      )}│   • abcdef ghijkl mnopqr`,
      absent: [],
    },
    {
      name: 'C1 CSI styles',
      input: `${String.fromCharCode(0x9b)}31m│ ${String.fromCharCode(
        0x9b,
      )}39m  • abcdef ghijkl mnopqr`,
      absent: ['31m', '39m'],
    },
  ])('keeps quoted list prefixes aligned across $name', ({ input, absent }) => {
    const lines = plainLinesWithinWidth(wrapAnsiToWidth(input, 10, true), 10);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe('│   • abcd');
    expect(lines.slice(1).every((line) => line.startsWith('│     '))).toBe(
      true,
    );
    for (const marker of absent) {
      expect(lines.join('\n')).not.toContain(marker);
    }
  });

  it('keeps OSC hyperlinks balanced when wrapping ANSI text', () => {
    const bel = String.fromCharCode(7);
    const open = `${ESC}]8;;https://example.com${ESC}\\`;
    const close = `${ESC}]8;;${ESC}\\`;
    const closeWithBel = `${ESC}]8;;${bel}`;
    const out = wrapAnsiToWidth(`${open}hello world${close}`, 5);
    const lines = plainLinesWithinWidth(out, 5);
    expect(lines.join('')).toBe('hello world');
    const openCount = out.split(`${ESC}]8;;https://example.com`).length - 1;
    const closeCount =
      out.split(close).length - 1 + (out.split(closeWithBel).length - 1);
    expect(openCount).toBe(closeCount);
    expect(out).toContain(open);
    expect(out).toContain(close);
  });

  it('wraps diff lines with the same ANSI-aware width helper', () => {
    const lines = plainLinesWithinWidth(wrapAnsiToWidth('+你好🙂abcdef', 6), 6);
    expect(lines.length).toBeGreaterThan(1);
  });
});
