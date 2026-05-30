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
    case 'planStep':
      return `plan:${row.step.title}`;
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
    summary: 'Coordinate a small math proof through nested CLI work.',
    steps: [
      {
        title: 'Route proof obligations',
        description: 'Choose the right specialist for each proof branch.',
        files: [],
        status: TODO_STATUS.COMPLETED,
      },
      {
        title: 'Check formalizable parts',
        description: 'Have a subagent inspect the Lean-style finite case.',
        files: [],
        status: TODO_STATUS.IN_PROGRESS,
      },
    ],
  };

  it('keeps active todo rows visible in a constrained mixed panel', () => {
    const display = compactTodosPlanRows({ maxRows: 4, plan, todos });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Ask leanSolver to verify the finite case',
      'todo:Merge subagent conclusions into final answer',
      'plan:Check formalizable parts',
    ]);
    expect(display.hiddenCount).toBe(3);
  });

  it('uses all rows when the todo and plan content fits', () => {
    const display = compactTodosPlanRows({ maxRows: 6, plan, todos });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Split theorem into algebraic and analytic checks',
      'todo:Ask leanSolver to verify the finite case',
      'todo:Merge subagent conclusions into final answer',
      'plan:summary',
      'plan:Route proof obligations',
      'plan:Check formalizable parts',
    ]);
    expect(display.hiddenCount).toBe(0);
  });

  it('uses the single available row for the highest-signal item', () => {
    const display = compactTodosPlanRows({ maxRows: 1, plan, todos });

    expect(display.rows.map(rowKey)).toEqual([
      'todo:Ask leanSolver to verify the finite case',
    ]);
    expect(display.hiddenCount).toBe(5);
  });
});
