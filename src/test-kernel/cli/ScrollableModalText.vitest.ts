import { describe, expect, it } from 'vitest';

import {
  boundedModalTextLines,
  modalTextDisplayLines,
  modalTextMaxScrollOffset,
  scrollableModalTextRowsBudget,
} from '@cli/chat/tui/modals/ScrollableModalText';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';

const HEREDOC_COMMAND = [
  "python3 << 'EOF'",
  'solutions = []',
  'for y in range(1, 100):',
  '    x2 = 1 + 2 * y * y',
  '    x = int(x2 ** 0.5)',
  '    if x * x == x2:',
  '        solutions.append((x, y))',
  '        if x != 0:',
  '            solutions.append((-x, y))',
  'solutions.sort()',
  'print("All integer pairs (x,y) with 0<y<100:")',
  'print(solutions)',
  'EOF',
].join('\n');

const BASH_PREFIXES = {
  firstLinePrefix: '$ ',
  continuationPrefix: '  ',
} as const;

function bashLines() {
  return modalTextDisplayLines({
    ...BASH_PREFIXES,
    text: HEREDOC_COMMAND,
    width: 76,
  });
}

function lineTexts(lines: readonly { text: string }[]): string[] {
  return lines.map((line) => line.text);
}

describe('CLI scrollable modal text section', () => {
  it('counts fixed extra rows before clamping the content budget', () => {
    const withoutExtra = scrollableModalTextRowsBudget({
      availableRows: 8,
      columns: 80,
      title: 'Run command?',
    });
    const withExtra = scrollableModalTextRowsBudget({
      availableRows: 8,
      columns: 80,
      extraFixedRows: 1,
      title: 'Run command?',
    });

    expect(withoutExtra).toBe(2);
    expect(withExtra).toBe(1);
  });

  it('caps long bodies so the approval footer stays visible', () => {
    const budget = scrollableModalTextRowsBudget({
      availableRows: 16,
      columns: 80,
      title: 'Run command?',
    });
    const allRows = bashLines();

    expect(budget).toBe(8);
    expect(allRows.length).toBeGreaterThan(budget);

    const visible = boundedModalTextLines({
      lines: allRows,
      maxRows: budget,
      width: 76,
    });

    expect(visible).toHaveLength(budget);
    expect(visible.at(-1)).toEqual({
      kind: 'overflow',
      text: '… 6 more rows',
    });
    expect(lineTexts(visible)).not.toContain('  print(solutions)');
  });

  it('lets users scroll to the hidden body tail', () => {
    const budget = 8;
    const allRows = bashLines();
    const offset = modalTextMaxScrollOffset({
      maxRows: budget,
      totalLines: allRows.length,
    });
    const visible = boundedModalTextLines({
      lines: allRows,
      maxRows: budget,
      scrollOffset: offset,
      width: 76,
    });

    expect(visible.at(0)).toEqual({
      kind: 'overflow',
      text: `… ${offset} previous rows`,
    });
    expect(lineTexts(visible)).toContain('  print(solutions)');
    expect(lineTexts(visible)).toContain('  EOF');
  });

  it('lets users scroll compact previews', () => {
    const budget = 3;
    const allRows = bashLines();
    const offset = modalTextMaxScrollOffset({
      maxRows: budget,
      totalLines: allRows.length,
    });
    const visible = boundedModalTextLines({
      lines: allRows,
      maxRows: budget,
      scrollOffset: 3,
      width: 76,
    });

    expect(offset).toBeGreaterThan(0);
    expect(visible).toHaveLength(budget);
    expect(lineTexts(visible)).toContain('      x2 = 1 + 2 * y * y');
    expect(visible.at(-1)).toEqual({
      kind: 'overflow',
      text: '… 3 previous, 8 more rows',
    });
  });

  it('lets users scroll one-row compact previews', () => {
    const visible = boundedModalTextLines({
      lines: bashLines(),
      maxRows: 1,
      scrollOffset: 2,
      width: 76,
    });

    expect(modalTextMaxScrollOffset({ maxRows: 1, totalLines: 13 })).toBe(12);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.text).toContain('for y in range(1, 100):');
    expect(visible[0]?.text).toContain('rows hidden');
  });

  it('keeps one-row compact previews within their row budget', () => {
    const visible = boundedModalTextLines({
      lines: bashLines(),
      maxRows: 1,
      width: 76,
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.text).toContain("$ python3 << 'EOF'");
    expect(visible[0]?.text).toContain('rows hidden');
    expect(visible[0]?.text.length).toBeLessThanOrEqual(76);
  });

  it('clips one-row compact previews by terminal column width', () => {
    const visible = boundedModalTextLines({
      lines: modalTextDisplayLines({
        ...BASH_PREFIXES,
        text: `echo ${'界'.repeat(20)}`,
        width: 24,
      }),
      maxRows: 1,
      width: 24,
    });

    expect(visible).toHaveLength(1);
    expect(textDisplayWidth(visible[0]?.text ?? '')).toBeLessThanOrEqual(24);
  });

  it('qualifies one-row overflow markers with the hidden noun', () => {
    const visible = boundedModalTextLines({
      hiddenNoun: 'prompt rows',
      lines: modalTextDisplayLines({ text: 'a\nb\nc', width: 40 }),
      maxRows: 1,
      width: 40,
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.text).toContain('prompt rows hidden');
  });

  it('preserves empty source lines when wrapping', () => {
    const lines = modalTextDisplayLines({
      text: 'first\n\nthird',
      width: 40,
    });

    expect(lineTexts(lines)).toEqual(['first', '', 'third']);
  });

  it('strips wrap-artifact leading whitespace only when asked', () => {
    const lines = modalTextDisplayLines({
      text: '**Approach:** Keep a running mental log of friction points as tasks progress. At natural stopping points, call `todo_write` to record specific observations. Do not edit any files — only observe and report.',
      trimWrappedLeadingWhitespace: true,
      width: 77,
    });

    expect(lines.some((line) => line.text.startsWith(' At natural'))).toBe(
      false,
    );
    expect(
      lines.some((line) => line.text.includes('observations. Do not edit')),
    ).toBe(true);
  });

  it('preserves continuation whitespace for commands by default', () => {
    const quoted = `echo "${'x'.repeat(30)}    spaced argument"`;
    const lines = modalTextDisplayLines({
      ...BASH_PREFIXES,
      text: quoted,
      width: 36,
    });

    expect(lineTexts(lines).join('')).toContain('    spaced argument');
  });
});
