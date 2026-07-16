import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  PLAN_APPROVAL_GOAL_NOTICE,
  isCompactPlanApprovalRows,
  isPlanApprovalGoalActionVisible,
  planApprovalCompactBodyRowsBudget,
  planApprovalFeedbackRows,
  planApprovalGoalNoticeLine,
} from '@cli/chat/tui/modals/PlanApproval';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';

describe('CLI plan approval layout', () => {
  it('switches to compact rendering before the bordered card clips plan text', () => {
    expect(COMPACT_PLAN_APPROVAL_MAX_ROWS).toBe(7);
    expect(isCompactPlanApprovalRows(7)).toBe(true);
    expect(isCompactPlanApprovalRows(8)).toBe(false);
    expect(isCompactPlanApprovalRows(9, true)).toBe(true);
    expect(isCompactPlanApprovalRows(10, true)).toBe(false);
  });

  it('reserves compact rows when goal approval hints stack below the title', () => {
    expect(
      planApprovalCompactBodyRowsBudget({
        availableRows: 9,
        columns: 60,
        goalEnabled: true,
      }),
    ).toBe(7);
    expect(
      planApprovalCompactBodyRowsBudget({
        availableRows: 9,
        columns: 100,
        goalEnabled: true,
      }),
    ).toBe(8);
    expect(
      planApprovalCompactBodyRowsBudget({
        availableRows: 2,
        columns: 60,
        goalEnabled: true,
      }),
    ).toBe(0);
    expect(
      planApprovalCompactBodyRowsBudget({
        availableRows: 2,
        columns: 60,
        goalEnabled: false,
      }),
    ).toBe(1);
  });

  it('hides approve-and-run when compact mode cannot show its scope notice', () => {
    expect(
      isPlanApprovalGoalActionVisible({
        compact: true,
        goalEnabled: true,
        visibleBodyRows: 0,
      }),
    ).toBe(false);
    expect(
      isPlanApprovalGoalActionVisible({
        compact: true,
        goalEnabled: true,
        visibleBodyRows: 1,
      }),
    ).toBe(true);
  });

  it('budgets feedback input rows by visible input width', () => {
    expect(planApprovalFeedbackRows({ columns: 80, value: '' })).toBe(2);
    expect(
      planApprovalFeedbackRows({
        columns: 44,
        value:
          'This rejection note is intentionally long enough to wrap on a narrow card.',
      }),
    ).toBeGreaterThan(2);
  });

  it('keeps the autonomous warning concise enough for the approval card', () => {
    expect(PLAN_APPROVAL_GOAL_NOTICE).toContain('Approve & run only');
    expect(PLAN_APPROVAL_GOAL_NOTICE).toContain('auto-approves bash');
    expect(PLAN_APPROVAL_GOAL_NOTICE.length).toBeLessThanOrEqual(40);
  });

  it('keeps the autonomous warning to one display row on narrow cards', () => {
    const notice = planApprovalGoalNoticeLine(40);

    expect(textDisplayWidth(notice)).toBe(40);
    expect(notice).toContain('Approve & run only');
    expect(notice).toContain('auto-approves bash');
    expect(notice).not.toContain('…');
  });
});
