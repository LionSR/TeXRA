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

  it('distinguishes absent work-plan fields from fields that were not loaded', () => {
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
    expect(
      formatWorkPlanReaderText({ objective: 'Plan only.' }, [], {
        plan: true,
        todos: false,
      }),
    ).toContain('(todos unavailable)');
    expect(
      formatWorkPlanReaderText(null, [], { plan: false, todos: true }),
    ).toContain('(objective unavailable)');
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
    ).toEqual({
      bodyRows: 5,
      showBorder: true,
      showFooter: true,
      showTitle: true,
    });
  });

  it('drops chrome before exceeding a very short row budget', () => {
    expect(
      workPlanReaderLayout({
        availableRows: 4,
        contentWidth: 1,
        title: 'Work plan',
      }),
    ).toEqual({
      bodyRows: 2,
      showBorder: true,
      showFooter: false,
      showTitle: false,
    });
  });

  it.each([
    { availableRows: 1, bodyRows: 0 },
    { availableRows: 2, bodyRows: 1 },
    { availableRows: 3, bodyRows: 2 },
  ])(
    'uses a borderless title and $bodyRows body rows in a $availableRows-row viewport',
    ({ availableRows, bodyRows }) => {
      expect(
        workPlanReaderLayout({
          availableRows,
          contentWidth: 1,
          title: 'Work plan: a narrow stream',
        }),
      ).toEqual({
        bodyRows,
        showBorder: false,
        showFooter: false,
        showTitle: true,
      });
    },
  );
});
