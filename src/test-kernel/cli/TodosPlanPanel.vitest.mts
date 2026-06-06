import { describe, expect, it } from 'vitest';

import {
  compactTodosPlanRows,
  todosPlanDisplayRows,
  todosPlanPanelRowCount,
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

  it('shows pending plan steps before completed context rows', () => {
    const display = compactTodosPlanRows({
      maxRows: 2,
      plan: {
        summary: 'Finish the remaining proof obligations.',
        steps: [
          {
            title: 'Check the last lemma',
            description: 'Verify the only unfinished plan item.',
            files: [],
            status: TODO_STATUS.PENDING,
          },
        ],
      },
      todos: [todos[0]],
    });

    expect(display.rows.map(rowKey)).toEqual(['plan:Check the last lemma']);
    expect(display.hiddenCount).toBe(2);
  });

  it('lets todo rows own plan steps with duplicate labels', () => {
    const duplicateTodos: TodoItem[] = [
      {
        content:
          'Replace AnthropicMessageStream duck type with BetaMessageStream',
        activeForm:
          'Replacing AnthropicMessageStream duck type with BetaMessageStream',
        status: TODO_STATUS.COMPLETED,
      },
      {
        content: "Replace ClaudeAgentEffort with SDK's EffortLevel",
        activeForm: "Replacing ClaudeAgentEffort with SDK's EffortLevel",
        status: TODO_STATUS.COMPLETED,
      },
      {
        content: "Replace ClaudeAgentPermissionMode with SDK's PermissionMode",
        activeForm:
          "Replacing ClaudeAgentPermissionMode with SDK's PermissionMode",
        status: TODO_STATUS.COMPLETED,
      },
      {
        content: 'Audit remaining custom types for SDK-native equivalents',
        activeForm:
          'Auditing remaining custom types for SDK-native equivalents',
        status: TODO_STATUS.COMPLETED,
      },
    ];
    const duplicatePlan: Plan = {
      summary: 'Replace local Claude SDK aliases with native types.',
      steps: [
        {
          title:
            'Replace AnthropicMessageStream duck type with BetaMessageStream',
          description: 'Use the SDK stream type directly.',
          files: [],
          status: TODO_STATUS.PENDING,
        },
        {
          title: "Replace ClaudeAgentEffort with SDK's EffortLevel",
          description: 'Use the SDK effort type directly.',
          files: [],
          status: TODO_STATUS.PENDING,
        },
        {
          title: "Replace ClaudeAgentPermissionMode with SDK's PermissionMode",
          description: 'Use the SDK permission type directly.',
          files: [],
          status: TODO_STATUS.PENDING,
        },
        {
          title: 'Audit remaining custom types for SDK-native equivalents',
          description: 'Find any remaining local aliases.',
          files: [],
          status: TODO_STATUS.PENDING,
        },
        {
          title: 'Verify compilation and clean up imports',
          description: 'Run focused checks and remove stale imports.',
          files: [],
          status: TODO_STATUS.PENDING,
        },
      ],
    };

    const rows = todosPlanDisplayRows({
      plan: duplicatePlan,
      todos: duplicateTodos,
    });

    expect(rows.map(rowKey)).toEqual([
      'todo:Replace AnthropicMessageStream duck type with BetaMessageStream',
      "todo:Replace ClaudeAgentEffort with SDK's EffortLevel",
      "todo:Replace ClaudeAgentPermissionMode with SDK's PermissionMode",
      'todo:Audit remaining custom types for SDK-native equivalents',
      'plan:summary',
      'plan:Verify compilation and clean up imports',
    ]);
    expect(todosPlanPanelRowCount(duplicateTodos, duplicatePlan)).toBe(
      rows.length,
    );
  });
});
