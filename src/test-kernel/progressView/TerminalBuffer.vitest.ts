// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/terminalBuffer'),
);

const EXPECTED_SCROLLBACK_LINES = 4_000;
const TRUNCATION_MARKER = `[truncated to last ${EXPECTED_SCROLLBACK_LINES} lines]\n`;

let TerminalBuffer: typeof import('@progressView/frontend/components/terminalBuffer').TerminalBuffer;

beforeAll(async () => {
  ({ TerminalBuffer } =
    await import('@progressView/frontend/components/terminalBuffer'));
});

function renderedText(buffer: InstanceType<typeof TerminalBuffer>): string {
  const pre = document.createElement('pre');
  buffer.sync(pre);
  return pre.textContent ?? '';
}

function numberedLines(start: number, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `line ${start + index}\n`,
  ).join('');
}

describe('TerminalBuffer', () => {
  it('preserves committed output below the scrollback limit', () => {
    const buffer = new TerminalBuffer();

    buffer.append('first\nsecond\npartial');

    expect(renderedText(buffer)).toBe('first\nsecond\n');
    expect(buffer.tail).toBe('partial');
  });

  it('evicts the oldest processed lines predictably above the limit', () => {
    const buffer = new TerminalBuffer();
    const pre = document.createElement('pre');
    buffer.append(numberedLines(0, EXPECTED_SCROLLBACK_LINES));
    buffer.sync(pre);

    buffer.append(numberedLines(EXPECTED_SCROLLBACK_LINES, 2));
    buffer.sync(pre);

    const text = pre.textContent ?? '';
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(text).not.toContain('line 0\n');
    expect(text).not.toContain('line 1\n');
    expect(text).toContain('line 2\n');
    expect(text.endsWith(`line ${EXPECTED_SCROLLBACK_LINES + 1}\n`)).toBe(true);
  });

  it('preserves CR overwrite and split ANSI handling when trimming', () => {
    const buffer = new TerminalBuffer();
    buffer.append(numberedLines(0, EXPECTED_SCROLLBACK_LINES - 1));
    buffer.append('\x1b[3');
    buffer.append('1mprogress 10%\x1b[0m\rprogress');
    buffer.append(' done\nlast\n');

    const text = renderedText(buffer);
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(text).not.toContain('line 0\n');
    expect(text).toContain('progress done\nlast\n');
    expect(text).not.toContain('\x1b');
  });

  it('keeps retained committed state bounded after repeated appends', () => {
    const buffer = new TerminalBuffer();

    for (let batch = 0; batch < 20; batch += 1) {
      buffer.append(numberedLines(batch * 500, 500));
    }

    const text = renderedText(buffer);
    const retainedLines = text.slice(TRUNCATION_MARKER.length).split('\n');
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(retainedLines).toHaveLength(EXPECTED_SCROLLBACK_LINES + 1);
    expect(retainedLines[0]).toBe('line 6000');
    expect(retainedLines.at(-2)).toBe('line 9999');
  });

  it('rebuild replaces truncated history and resets the DOM text', () => {
    const buffer = new TerminalBuffer();
    const pre = document.createElement('pre');
    buffer.append(numberedLines(0, EXPECTED_SCROLLBACK_LINES + 1));
    buffer.sync(pre);
    expect(pre.textContent?.startsWith(TRUNCATION_MARKER)).toBe(true);

    buffer.rebuild('replacement\npartial');
    buffer.sync(pre);

    expect(pre.textContent).toBe('replacement\n');
    expect(buffer.tail).toBe('partial');
  });
});
