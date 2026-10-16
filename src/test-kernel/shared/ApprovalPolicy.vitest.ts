import { describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICIES,
  decideHumanInputRequest,
  decideRetryApproval,
  decideApproval,
  parseApprovalPolicy,
} from '@shared/approvalPolicy';
import { APPROVAL_POLICY_OPTIONS } from '@ui/copy/approvalPolicy';

describe('TeXRA approval policy', () => {
  it.each([
    ['never', true, true, true, 'deny-policy'],
    ['never', false, false, true, 'deny-policy'],
    ['ask', true, false, true, 'present'],
    ['ask', true, false, false, 'deny-unpresentable'],
    ['ask', true, true, false, 'allow'],
    ['ask', false, false, false, 'allow'],
    ['yolo', true, false, false, 'allow'],
  ] as const)(
    'decides %s with promptRequired=%s, bypass=%s, canPresent=%s as %s',
    (policy, promptRequired, scopedBypass, canPresent, expected) => {
      expect(
        decideApproval({
          policy,
          promptRequired,
          scopedBypass,
          canPresent,
        }),
      ).toBe(expected);
    },
  );

  it('publishes one ordered set of policy choices and accepts only those values', () => {
    const optionValues = APPROVAL_POLICY_OPTIONS.map(({ value }) => value);
    expect(optionValues).toEqual(['ask', 'never', 'yolo']);
    expect(new Set(optionValues)).toEqual(new Set(APPROVAL_POLICIES));
    expect(optionValues).toHaveLength(APPROVAL_POLICIES.length);
    expect(parseApprovalPolicy(' Yolo ')).toBe('yolo');
    expect(parseApprovalPolicy('auto')).toBeUndefined();
  });

  it.each([
    [
      { policy: 'yolo', canPresent: true, isCredentialFailure: false },
      { deny: 'yolo-retry' },
    ],
    [
      { policy: 'yolo', canPresent: true, isCredentialFailure: true },
      { deny: 'credential' },
    ],
    [
      { policy: 'never', canPresent: true, isCredentialFailure: false },
      { deny: 'policy' },
    ],
    [
      { policy: 'never', canPresent: false, isCredentialFailure: true },
      { deny: 'credential' },
    ],
    [
      { policy: 'ask', canPresent: true, isCredentialFailure: false },
      'present',
    ],
    [
      { policy: 'ask', canPresent: false, isCredentialFailure: true },
      { deny: 'credential' },
    ],
    [
      { policy: 'ask', canPresent: false, isCredentialFailure: false },
      { deny: 'unpresentable' },
    ],
  ] as const)('decideRetryApproval(%j) → %j', (input, expected) => {
    expect(decideRetryApproval(input)).toEqual(expected);
  });

  it.each([
    [{ policy: 'yolo', canPresent: true }, { deny: 'yolo-no-human' }],
    [{ policy: 'never', canPresent: true }, { deny: 'policy' }],
    [{ policy: 'ask', canPresent: true }, 'present'],
    [{ policy: 'ask', canPresent: false }, { deny: 'unpresentable' }],
  ] as const)('decideHumanInputRequest(%j) → %j', (input, expected) => {
    expect(decideHumanInputRequest(input)).toEqual(expected);
  });
});
