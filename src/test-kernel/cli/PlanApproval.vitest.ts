import { describe, expect, it } from 'vitest';

import { CONFIRM_CARD_FEEDBACK_PLACEHOLDER } from '@cli/chat/tui/modals/ConfirmCard';
import {
  isCompactPlanApprovalRows,
  isPlanApprovalGoalActionVisible,
  planApprovalCompactBodyRowsBudget,
  planApprovalGoalNoticeLine,
} from '@cli/chat/tui/modals/PlanApproval';
import { confirmCardFeedbackRows } from '@cli/chat/tui/modals/confirmCardRowsBudget';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import { PLAN_GOAL_COPY } from '@shared/copy/delegationApproval';

function compactBudget(
  availableRows: number,
  columns: number,
  goalEnabled: boolean,
): number | undefined {
  return planApprovalCompactBodyRowsBudget({
    availableRows,
    columns,
    goalEnabled,
  });
}

describe('CLI plan approval layout', () => {
  it('switches to compact rendering before the bordered card clips plan text', () => {
    expect(isCompactPlanApprovalRows(7)).toBe(true);
    expect(isCompactPlanApprovalRows(8)).toBe(false);
    expect(isCompactPlanApprovalRows(9, true)).toBe(true);
    expect(isCompactPlanApprovalRows(10, true)).toBe(false);
  });

  it.each([
    { availableRows: 9, columns: 60, goalEnabled: true, expected: 7 },
    { availableRows: 9, columns: 100, goalEnabled: true, expected: 8 },
    { availableRows: 2, columns: 60, goalEnabled: true, expected: 0 },
    { availableRows: 2, columns: 60, goalEnabled: false, expected: 1 },
  ])(
    'reserves compact rows when goal approval hints stack below the title ($availableRows rows, $columns cols, goal=$goalEnabled)',
    ({ availableRows, columns, goalEnabled, expected }) => {
      expect(compactBudget(availableRows, columns, goalEnabled)).toBe(expected);
    },
  );

  it.each([
    { columns: 49, goalEnabled: false, expected: 7 },
    { columns: 50, goalEnabled: false, expected: 7 },
    { columns: 51, goalEnabled: false, expected: 8 },
    { columns: 65, goalEnabled: true, expected: 7 },
    { columns: 66, goalEnabled: true, expected: 7 },
    { columns: 67, goalEnabled: true, expected: 8 },
  ])(
    'includes the pulse prefix at compact chrome boundaries ($columns cols, goal=$goalEnabled)',
    ({ columns, goalEnabled, expected }) => {
      expect(compactBudget(9, columns, goalEnabled)).toBe(expected);
    },
  );

  it.each([
    { visibleBodyRows: 0, expected: false },
    { visibleBodyRows: 1, expected: false },
    { visibleBodyRows: 2, expected: true },
  ])(
    'hides run-as-goal when compact mode cannot show its scope notice ($visibleBodyRows rows)',
    ({ visibleBodyRows, expected }) => {
      expect(
        isPlanApprovalGoalActionVisible({
          compact: true,
          goalEnabled: true,
          visibleBodyRows,
        }),
      ).toBe(expected);
    },
  );

  it('budgets feedback input rows by visible input width', () => {
    expect(
      confirmCardFeedbackRows({
        columns: 80,
        placeholder: CONFIRM_CARD_FEEDBACK_PLACEHOLDER,
        value: '',
      }),
    ).toBe(2);
    expect(
      confirmCardFeedbackRows({
        columns: 44,
        placeholder: CONFIRM_CARD_FEEDBACK_PLACEHOLDER,
        value:
          'This rejection note is intentionally long enough to wrap on a narrow card.',
      }),
    ).toBeGreaterThan(2);
  });

  it('explains goal continuation and approval scope concisely', () => {
    expect(PLAN_GOAL_COPY.cliNotice).toContain('until done');
    expect(PLAN_GOAL_COPY.cliNotice).toContain('only Bash');
    expect(PLAN_GOAL_COPY.cliNotice.length).toBeLessThanOrEqual(40);
  });

  it('keeps the goal explanation to one display row on narrow cards', () => {
    const notice = planApprovalGoalNoticeLine(40);

    expect(textDisplayWidth(notice)).toBe(40);
    expect(notice).toContain('until done');
    expect(notice).toContain('only Bash');
    expect(notice).not.toContain('…');
  });
});
