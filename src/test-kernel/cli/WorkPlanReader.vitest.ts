import { describe, expect, it } from 'vitest';

import {
  formatWorkPlanReaderText,
  workPlanReaderLayout,
  workPlanReaderTitle,
} from '@cli/chat/tui/panes/WorkPlanReader';
import { TODO_STATUS, type TodoItem } from '@shared/schemas';

describe('WorkPlanReader display model', () => {
  it('shows the full objective and every todo with its status', () => {
    const todos: TodoItem[] = [
      {
        content: 'Inspect the boundary case',
        activeForm: 'Inspecting the boundary case',
        status: TODO_STATUS.IN_PROGRESS,
      },
      {
        content: 'Write the final argument',
        activeForm: 'Writing the final argument',
        status: TODO_STATUS.PENDING,
      },
      {
        content: 'Run the proof checker',
        activeForm: 'Running the proof checker',
        status: TODO_STATUS.COMPLETED,
      },
    ];

    expect(
      formatWorkPlanReaderText(
        {
          objective:
            'Prove the boundary lemma.\n\nRetain the second paragraph in full.',
        },
        todos,
      ),
    ).toBe(
      [
        'Objective',
        'Prove the boundary lemma.',
        '',
        'Retain the second paragraph in full.',
        '',
        'Todos',
        '1. [in progress] Inspect the boundary case',
        '2. [pending] Write the final argument',
        '3. [completed] Run the proof checker',
      ].join('\n'),
    );
  });

  it('keeps plan-only and todo-only readers explicit', () => {
    expect(formatWorkPlanReaderText({ objective: 'Plan only.' }, [])).toContain(
      '(no todos)',
    );
    expect(
      formatWorkPlanReaderText(null, [
        {
          content: 'Todo only',
          activeForm: 'Working on todo only',
          status: TODO_STATUS.PENDING,
        },
      ]),
    ).toContain('(no objective)');
  });

  it('uses a concise title in narrow or unlabeled contexts', () => {
    expect(workPlanReaderTitle(undefined)).toBe('Work plan');
    expect(workPlanReaderTitle('proof')).toBe('Work plan: proof');
  });

  it('counts a wrapped narrow footer in the available row budget', () => {
    expect(
      workPlanReaderLayout({
        availableRows: 12,
        contentWidth: 16,
        title: 'Work plan: proof',
      }),
    ).toEqual({ bodyRows: 5, showFooter: true, showTitle: true });
  });

  it('drops chrome before exceeding a very short row budget', () => {
    expect(
      workPlanReaderLayout({
        availableRows: 4,
        contentWidth: 1,
        title: 'Work plan',
      }),
    ).toEqual({ bodyRows: 2, showFooter: false, showTitle: false });
  });
});
