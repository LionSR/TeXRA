import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  isCompactPlanApprovalRows,
  planApprovalDisplayLines,
  renderCompactPlanLine,
} from '@cli/chat/tui/modals/PlanApproval';

describe('CLI plan approval layout', () => {
  it('switches to compact rendering before the bordered card clips plan text', () => {
    expect(COMPACT_PLAN_APPROVAL_MAX_ROWS).toBe(7);
    expect(isCompactPlanApprovalRows(7)).toBe(true);
    expect(isCompactPlanApprovalRows(8)).toBe(false);
  });

  it('uses a clear overflow label when compact clipping lands on a blank line', () => {
    expect(renderCompactPlanLine('', true, 3)).toBe('… 3 more lines');
  });

  it('keeps the visible line when compact clipping lands on content', () => {
    expect(renderCompactPlanLine('Verify typecheck', true, 2)).toBe(
      'Verify typecheck · … 2 more',
    );
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
});
