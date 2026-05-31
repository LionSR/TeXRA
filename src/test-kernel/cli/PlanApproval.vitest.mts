import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  isCompactPlanApprovalRows,
} from '@cli/chat/tui/modals/PlanApproval';

describe('CLI plan approval layout', () => {
  it('switches to compact rendering before the bordered card clips plan text', () => {
    expect(COMPACT_PLAN_APPROVAL_MAX_ROWS).toBe(6);
    expect(isCompactPlanApprovalRows(6)).toBe(true);
    expect(isCompactPlanApprovalRows(7)).toBe(false);
  });
});
