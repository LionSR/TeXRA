// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component under test
import {
  TERMINAL_BUFFER_MAX_LINES,
  TerminalBuffer,
} from '@progressView/frontend/components/terminalBuffer';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/terminalBuffer'),
);

const TRUNCATION_MARKER = '[... earlier terminal output truncated ...]\n';
const RETAINED_AFTER_COMPACTION = 3_600;

function renderedText(buffer: TerminalBuffer): string {
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

function retainedLines(text: string): string[] {
  const content = text.startsWith(TRUNCATION_MARKER)
    ? text.slice(TRUNCATION_MARKER.length)
    : text;
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : [content];
}

describe('TerminalBuffer', () => {
  it('preserves committed output below the complete-line limit', () => {
    const buffer = new TerminalBuffer();
    buffer.append(numberedLines(0, TERMINAL_BUFFER_MAX_LINES - 1));

    const text = renderedText(buffer);
    const lines = retainedLines(text);
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(false);
    expect(lines).toHaveLength(TERMINAL_BUFFER_MAX_LINES - 1);
    expect(lines[0]).toBe('line 0');
  });

  it('preserves committed output exactly at the complete-line limit', () => {
    const buffer = new TerminalBuffer();
    buffer.append(numberedLines(0, TERMINAL_BUFFER_MAX_LINES));

    const text = renderedText(buffer);
    const lines = retainedLines(text);
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(false);
    expect(lines).toHaveLength(TERMINAL_BUFFER_MAX_LINES);
    expect(lines.at(-1)).toBe(`line ${TERMINAL_BUFFER_MAX_LINES - 1}`);
  });

  it('compacts to the lower watermark immediately above the limit', () => {
    const buffer = new TerminalBuffer();
    buffer.append(numberedLines(0, TERMINAL_BUFFER_MAX_LINES + 1));

    const text = renderedText(buffer);
    const lines = retainedLines(text);
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(lines).toHaveLength(RETAINED_AFTER_COMPACTION);
    expect(lines[0]).toBe(
      `line ${TERMINAL_BUFFER_MAX_LINES + 1 - RETAINED_AFTER_COMPACTION}`,
    );
    expect(lines.at(-1)).toBe(`line ${TERMINAL_BUFFER_MAX_LINES}`);
  });

  it('keeps only the lower-watermark suffix when one chunk is far over the limit', () => {
    const buffer = new TerminalBuffer();
    const totalLines = TERMINAL_BUFFER_MAX_LINES + 2_000;
    buffer.append(numberedLines(0, totalLines));

    const lines = retainedLines(renderedText(buffer));
    expect(lines).toHaveLength(RETAINED_AFTER_COMPACTION);
    expect(lines[0]).toBe(`line ${totalLines - RETAINED_AFTER_COMPACTION}`);
    expect(lines.at(-1)).toBe(`line ${totalLines - 1}`);
  });

  it('amortizes compaction across repeated line-at-a-time appends', () => {
    const buffer = new TerminalBuffer();
    const pre = document.createElement('pre');
    buffer.append(numberedLines(0, TERMINAL_BUFFER_MAX_LINES + 1));
    buffer.sync(pre);
    const nodeAfterFirstCompaction = pre.firstChild;

    for (
      let line = TERMINAL_BUFFER_MAX_LINES + 1;
      line <= TERMINAL_BUFFER_MAX_LINES + 400;
      line += 1
    ) {
      buffer.append(`line ${line}\n`);
      buffer.sync(pre);
      expect(pre.firstChild).toBe(nodeAfterFirstCompaction);
    }

    expect(retainedLines(pre.textContent ?? '')[0]).toBe('line 401');

    buffer.append(`line ${TERMINAL_BUFFER_MAX_LINES + 401}\n`);
    buffer.sync(pre);
    expect(pre.firstChild).not.toBe(nodeAfterFirstCompaction);
    expect(retainedLines(pre.textContent ?? '')[0]).toBe('line 802');
  });

  it('preserves CR overwrite and split ANSI handling across compaction', () => {
    const buffer = new TerminalBuffer();
    buffer.append(numberedLines(0, TERMINAL_BUFFER_MAX_LINES));
    buffer.append('\x1b[3');
    buffer.append('1mprogress 10%\x1b[0m\rprogress');
    buffer.append(' done\n');

    const text = renderedText(buffer);
    expect(text.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(retainedLines(text)[0]).toBe('line 401');
    expect(text.endsWith('progress done\n')).toBe(true);
    expect(text).not.toContain('\x1b');
  });

  it('caps an oversized partial tail that follows complete lines', () => {
    const buffer = new TerminalBuffer();
    const oversizedTail = `discard${'x'.repeat(70_000)}`;

    buffer.append(`complete\n${oversizedTail}`);

    expect(renderedText(buffer)).toBe('complete\n');
    expect(buffer.tail).toHaveLength(65_536);
    expect(buffer.tail).toBe('x'.repeat(65_536));
  });

  it('rebuild replaces truncated history and resets line and tail state', () => {
    const buffer = new TerminalBuffer();
    const pre = document.createElement('pre');
    buffer.append(numberedLines(0, TERMINAL_BUFFER_MAX_LINES + 1));
    buffer.sync(pre);
    expect(pre.textContent?.startsWith(TRUNCATION_MARKER)).toBe(true);

    buffer.rebuild('replacement\npartial');
    buffer.sync(pre);

    expect(pre.textContent).toBe('replacement\n');
    expect(buffer.tail).toBe('partial');
  });
});
