import { describe, expect, it } from 'vitest';

import { formatCliApprovalPolicy } from '@cli/runtime/approvalPolicyText';
import { APPROVAL_POLICY_ITEMS } from '@cli/chat/tui/forms/ApprovalPolicyForm';

describe('ApprovalPolicyForm', () => {
  it('offers every policy in ask/never/auto-approve order, described by the shared formatter', () => {
    expect(APPROVAL_POLICY_ITEMS).toEqual([
      {
        value: 'ask',
        label: 'Ask',
        description: formatCliApprovalPolicy('ask'),
      },
      {
        value: 'never',
        label: 'Never',
        description: formatCliApprovalPolicy('never'),
      },
      {
        value: 'yolo',
        label: 'Auto-approve',
        description: formatCliApprovalPolicy('yolo'),
      },
    ]);
  });
});
