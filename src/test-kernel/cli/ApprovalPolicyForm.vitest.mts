import { describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICY_ITEMS,
  formatApprovalPolicyForCli,
} from '@cli/chat/tui/forms/ApprovalPolicyForm';

describe('ApprovalPolicyForm', () => {
  it('describes the yolo policy as auto-approval', () => {
    expect(formatApprovalPolicyForCli('yolo')).toBe(
      'auto-approve privileged actions',
    );
    expect(APPROVAL_POLICY_ITEMS.find((item) => item.value === 'yolo')).toEqual(
      {
        value: 'yolo',
        label: 'Auto-approve',
        description: 'auto-approve privileged actions',
      },
    );
  });
});
