import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  isCompactPlanApprovalRows,
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
});
