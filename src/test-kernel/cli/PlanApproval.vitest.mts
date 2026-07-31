import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  PLAN_APPROVAL_FEEDBACK_PLACEHOLDER,
  isCompactPlanApprovalRows,
  isPlanApprovalGoalActionVisible,
  planApprovalCompactBodyRowsBudget,
  planApprovalGoalNoticeLine,
} from '@cli/chat/tui/modals/PlanApproval';
import { confirmCardFeedbackRows } from '@cli/chat/tui/modals/confirmCardRowsBudget';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import { PLAN_GOAL_COPY } from '@shared/copy/delegationApproval';

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

  it('includes the pulse prefix at compact chrome boundaries', () => {
    for (const columns of [49, 50]) {
      expect(
        planApprovalCompactBodyRowsBudget({
          availableRows: 9,
          columns,
          goalEnabled: false,
        }),
      ).toBe(7);
    }
    expect(
      planApprovalCompactBodyRowsBudget({
        availableRows: 9,
        columns: 51,
        goalEnabled: false,
      }),
    ).toBe(8);

    for (const columns of [65, 66]) {
      expect(
        planApprovalCompactBodyRowsBudget({
          availableRows: 9,
          columns,
          goalEnabled: true,
        }),
      ).toBe(7);
    }
    expect(
      planApprovalCompactBodyRowsBudget({
        availableRows: 9,
        columns: 67,
        goalEnabled: true,
      }),
    ).toBe(8);
  });

  it('hides run-as-goal when compact mode cannot show its scope notice', () => {
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
    ).toBe(false);
    expect(
      isPlanApprovalGoalActionVisible({
        compact: true,
        goalEnabled: true,
        visibleBodyRows: 2,
      }),
    ).toBe(true);
  });

  it('budgets feedback input rows by visible input width', () => {
    expect(
      confirmCardFeedbackRows({
        columns: 80,
        placeholder: PLAN_APPROVAL_FEEDBACK_PLACEHOLDER,
        value: '',
      }),
    ).toBe(2);
    expect(
      confirmCardFeedbackRows({
        columns: 44,
        placeholder: PLAN_APPROVAL_FEEDBACK_PLACEHOLDER,
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
