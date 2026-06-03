import { describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICY_ITEMS,
  formatApprovalPolicyForCli,
} from '@cli/chat/tui/forms/ApprovalPolicyForm';

describe('ApprovalPolicyForm', () => {
  it('describes approval policies consistently', () => {
    const expectedItems = [
      {
        value: 'ask',
        label: 'Ask',
        description: 'ask before privileged actions',
      },
      {
        value: 'never',
        label: 'Never',
        description: 'deny privileged actions',
      },
      {
        value: 'yolo',
        label: 'Auto-approve',
        description: 'auto-approve privileged actions',
      },
    ] as const;

    expect(APPROVAL_POLICY_ITEMS).toEqual(expectedItems);
    for (const item of expectedItems) {
      expect(formatApprovalPolicyForCli(item.value)).toBe(item.description);
    }
  });
});
