import { describe, expect, it } from 'vitest';

import {
  TEXRA_APPROVAL_POLICY_OPTIONS,
  decideTexraApproval,
  parseTexraApprovalPolicy,
} from '@shared/approvalPolicy';

describe('TeXRA approval policy', () => {
  it.each([
    ['never', true, true, true, 'deny'],
    ['never', false, false, true, 'deny'],
    ['ask', true, false, true, 'present'],
    ['ask', true, false, false, 'deny'],
    ['ask', true, true, false, 'allow'],
    ['ask', false, false, false, 'allow'],
    ['yolo', true, false, false, 'allow'],
  ] as const)(
    'decides %s with promptRequired=%s, bypass=%s, canPresent=%s as %s',
    (policy, promptRequired, scopedBypass, canPresent, expected) => {
      expect(
        decideTexraApproval({
          policy,
          promptRequired,
          scopedBypass,
          canPresent,
        }),
      ).toBe(expected);
    },
  );

  it('publishes one ordered set of policy choices and accepts only those values', () => {
    expect(TEXRA_APPROVAL_POLICY_OPTIONS.map(({ value }) => value)).toEqual([
      'ask',
      'never',
      'yolo',
    ]);
    expect(parseTexraApprovalPolicy(' Yolo ')).toBe('yolo');
    expect(parseTexraApprovalPolicy('auto')).toBeUndefined();
  });
});
