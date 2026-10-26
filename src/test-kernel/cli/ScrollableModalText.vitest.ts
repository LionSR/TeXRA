import { describe, expect, it } from 'vitest';

import {
  modalTextDisplayLines,
  scrollableModalTextRowsBudget,
} from '@cli/chat/tui/modals/ScrollableModalText';
import {
  boundedScrollableLines,
  compactAwareMaxScrollOffset,
} from '@cli/chat/tui/render/scrollBounds';

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
  it('caps long bodies so the approval footer stays visible', () => {
    const budget = scrollableModalTextRowsBudget({
      availableRows: 16,
      columns: 80,
      title: 'Run command?',
    });
    const allRows = bashLines();

    expect(budget).toBe(8);
    expect(allRows.length).toBeGreaterThan(budget);

    const visible = boundedScrollableLines({
      lines: allRows,
      maxDisplayLines: budget,
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
    const offset = compactAwareMaxScrollOffset({
      maxDisplayLines: budget,
      totalLines: allRows.length,
    });
    const visible = boundedScrollableLines({
      lines: allRows,
      maxDisplayLines: budget,
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
});
