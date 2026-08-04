import { describe, expect, it } from 'vitest';

import {
  compactTodosPlanRows,
  type CompactTodosPlanRow,
} from '@cli/chat/tui/panes/TodosPlanPanel';
import { TODO_STATUS, type Plan, type TodoItem } from '@shared/schemas';

function rowKey(row: CompactTodosPlanRow): string {
  switch (row.kind) {
    case 'todo':
      return `todo:${row.todo.content}`;
    case 'planSummary':
      return 'plan:summary';
  }
}

describe('CLI TodosPlanPanel display model', () => {
  const todos: TodoItem[] = [
    {
      content: 'Split theorem into algebraic and analytic checks',
      activeForm: 'Splitting theorem into checks',
      status: TODO_STATUS.COMPLETED,
    },
    {
      content: 'Ask leanSolver to verify the finite case',
      activeForm: 'Waiting for leanSolver',
      status: TODO_STATUS.IN_PROGRESS,
    },
    {
      content: 'Merge subagent conclusions into final answer',
      activeForm: 'Merging subagent conclusions',
      status: TODO_STATUS.PENDING,
    },
  ];
  const plan: Plan = {
    objective: [
      'Coordinate a small math proof through nested CLI work.',
      '',
      'Route proof obligations to the right specialist and merge results.',
    ].join('\n'),
  };

  it('keeps active todo rows visible in a constrained mixed panel', () => {
    const display = compactTodosPlanRows({ maxRows: 3, plan, todos });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Ask leanSolver to verify the finite case',
      'todo:Merge subagent conclusions into final answer',
    ]);
    expect(display.hiddenCount).toBe(2);
  });

  it('uses all rows when the todo and plan content fits', () => {
    const display = compactTodosPlanRows({ maxRows: 4, plan, todos });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Split theorem into algebraic and analytic checks',
      'todo:Ask leanSolver to verify the finite case',
      'todo:Merge subagent conclusions into final answer',
      'plan:summary',
    ]);
    expect(display.hiddenCount).toBe(0);

    // The plan row shows the document's first non-empty line.
    const summaryRow = display.rows.find((row) => row.kind === 'planSummary');
    expect(summaryRow?.summary).toBe(
      'Coordinate a small math proof through nested CLI work.',
    );
  });

  it('uses the single available row for the highest-signal item', () => {
    const display = compactTodosPlanRows({ maxRows: 1, plan, todos });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Ask leanSolver to verify the finite case',
    ]);
    expect(display.hiddenCount).toBe(3);
  });

  it('drops the plan summary before todo rows under pressure', () => {
    const display = compactTodosPlanRows({
      maxRows: 1,
      plan,
      todos: [todos[0]],
    });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Split theorem into algebraic and analytic checks',
    ]);
    expect(display.hiddenCount).toBe(1);
  });
});
