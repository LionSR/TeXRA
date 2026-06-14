import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  PLAN_APPROVAL_GOAL_NOTICE,
  isCompactPlanApprovalRows,
  isPlanApprovalGoalActionVisible,
  planApprovalBodyRowsBudget,
  planApprovalCompactBodyRowsBudget,
  planApprovalDisplayLines,
  planApprovalFeedbackRows,
  planApprovalGoalNoticeLine,
  renderCompactPlanLine,
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

  it('reserves non-compact rows for the autonomous warning and controls', () => {
    expect(
      planApprovalBodyRowsBudget({ availableRows: 10, goalEnabled: true }),
    ).toBe(1);
    expect(
      planApprovalBodyRowsBudget({ availableRows: 10, goalEnabled: false }),
    ).toBe(3);
    expect(
      planApprovalBodyRowsBudget({
        availableRows: undefined,
        goalEnabled: true,
      }),
    ).toBeUndefined();
    expect(
      planApprovalBodyRowsBudget({
        availableRows: 10,
        goalEnabled: false,
        feedbackRows: 2,
      }),
    ).toBe(1);
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

  it('uses a clear overflow label when compact clipping lands on a blank line', () => {
    expect(renderCompactPlanLine('', true, 3)).toBe('… 3 more lines');
  });

  it('keeps the visible line when compact clipping lands on content', () => {
    expect(renderCompactPlanLine('Verify typecheck', true, 2)).toBe(
      'Verify typecheck · … 2 more',
    );
  });

  it('shows the non-compact hidden-row marker before final padding', () => {
    const line = renderCompactPlanLine(
      'Verify typecheck before committing'.padEnd(40),
      true,
      12,
      40,
    );

    expect(textDisplayWidth(line)).toBe(40);
    expect(line).toContain('12 more');
  });

  it('keeps the autonomous warning concise enough for the approval card', () => {
    expect(PLAN_APPROVAL_GOAL_NOTICE).toContain('edits still ask');
    expect(PLAN_APPROVAL_GOAL_NOTICE.length).toBeLessThanOrEqual(56);
  });

  it('keeps the autonomous warning to one display row on narrow cards', () => {
    const notice = planApprovalGoalNoticeLine(40);

    expect(textDisplayWidth(notice)).toBe(40);
    expect(notice).toContain('edits still ask');
    expect(notice).not.toContain('…');
  });

  it('wraps body lines before Ink renders the bordered card', () => {
    const lines = planApprovalDisplayLines({
      objective:
        '**Approach:** Keep a running mental log of friction points as tasks progress. At natural stopping points, call `todo_write` to record specific observations. Do not edit any files — only observe and report.',
      width: 77,
    });

    expect(lines.some((line) => line.startsWith(' At natural'))).toBe(false);
    expect(
      lines.some((line) => line.includes('observations. Do not edit')),
    ).toBe(true);
  });

  it('pads non-compact wrapped lines so shorter repaint rows clear stale tails', () => {
    const lines = planApprovalDisplayLines({
      objective: [
        '## Objective',
        'Prove that $\\sqrt{2} + \\sqrt{3}$ is irrational.',
        '',
        '## Approach',
        '1. Assume, for contradiction, that $\\sqrt{2} + \\sqrt{3}$ is rational, i.e. $x = \\sqrt{2} + \\sqrt{3} \\in \\mathbb{Q}$.',
        '2. Square both sides and isolate terms to derive a contradiction about $\\sqrt{6}$.',
        '3. Conclude that the original number is irrational.',
        "4. Delegate a brief independent verification to the `review` subagent to check the derivation's correctness.",
      ].join('\n'),
      width: 76,
      padLines: true,
    });

    expect(
      lines.some(
        (line) =>
          line.trim() ===
          '4. Delegate a brief independent verification to the `review` subagent to',
      ),
    ).toBe(true);
    const continuation = lines.find((line) =>
      line.trim().startsWith("check the derivation's correctness."),
    );
    expect(continuation).toBeDefined();
    expect(continuation).not.toContain('ification to the `review`');
    expect(continuation?.length).toBe(76);
  });
});
