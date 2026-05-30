import { describe, expect, it } from 'vitest';

import {
  bashApprovalCommandRowsBudget,
  bashCommandDisplayLines,
  boundedBashCommandDisplayLines,
  maxBashCommandScrollOffset,
} from '@cli/chat/tui/modals/BashApproval';

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

describe('CLI bash approval layout', () => {
  it('caps long commands so the approval footer stays visible', () => {
    const budget = bashApprovalCommandRowsBudget({
      availableRows: 16,
      columns: 80,
    });
    const allRows = bashCommandDisplayLines({
      command: HEREDOC_COMMAND,
      width: 76,
    });

    expect(budget).toBe(8);
    expect(allRows.length).toBeGreaterThan(budget);

    const visible = boundedBashCommandDisplayLines({
      command: HEREDOC_COMMAND,
      maxDisplayLines: budget,
      width: 76,
    });

    expect(visible).toHaveLength(budget);
    expect(visible.at(-1)).toEqual({
      kind: 'overflow',
      text: '... 6 more rows',
    });
    expect(visible.map((line) => line.text)).not.toContain(
      '  print(solutions)',
    );
  });

  it('lets users scroll to the hidden command tail', () => {
    const budget = 8;
    const allRows = bashCommandDisplayLines({
      command: HEREDOC_COMMAND,
      width: 76,
    });
    const offset = maxBashCommandScrollOffset(allRows.length, budget);
    const visible = boundedBashCommandDisplayLines({
      command: HEREDOC_COMMAND,
      maxDisplayLines: budget,
      scrollOffset: offset,
      width: 76,
    });

    expect(visible.at(0)).toEqual({
      kind: 'overflow',
      text: `... ${offset} previous rows`,
    });
    expect(visible.map((line) => line.text)).toContain('  print(solutions)');
    expect(visible.map((line) => line.text)).toContain('  EOF');
  });

  it('keeps one-row compact previews within their row budget', () => {
    const visible = boundedBashCommandDisplayLines({
      command: HEREDOC_COMMAND,
      maxDisplayLines: 1,
      width: 76,
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.text).toContain("$ python3 << 'EOF'");
    expect(visible[0]?.text).toContain('rows hidden');
    expect(visible[0]?.text.length).toBeLessThanOrEqual(76);
  });
});
