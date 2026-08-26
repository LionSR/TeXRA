import { describe, expect, it } from 'vitest';

import {
  TEXRA_APPROVAL_POLICIES,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
  parseTexraApprovalPolicy,
  texraApprovalDenialMessage,
  texraHumanInputDenialMessage,
  texraRetryDenialMessage,
} from '@shared/approvalPolicy';

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
    const optionValues = TEXRA_APPROVAL_POLICY_OPTIONS.map(
      ({ value }) => value,
    );
    expect(optionValues).toEqual(['ask', 'never', 'yolo']);
    expect(new Set(optionValues)).toEqual(new Set(TEXRA_APPROVAL_POLICIES));
    expect(optionValues).toHaveLength(TEXRA_APPROVAL_POLICIES.length);
    expect(parseTexraApprovalPolicy(' Yolo ')).toBe('yolo');
    expect(parseTexraApprovalPolicy('auto')).toBeUndefined();
  });

  it('maps deny reasons to distinct user-facing messages', () => {
    expect(texraApprovalDenialMessage('deny-policy')).toBe(
      'Denied by TeXRA approval policy.',
    );
    expect(texraApprovalDenialMessage('deny-unpresentable')).toBe(
      'Interactive approval requires a prompt; this run cannot present one.',
    );
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

  it('publishes retry denial copy beside the evaluator', () => {
    expect(texraRetryDenialMessage('yolo-retry')).toBe(
      'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
    );
  });

  it.each([
    [{ policy: 'yolo', canPresent: true }, { deny: 'yolo-no-human' }],
    [{ policy: 'never', canPresent: true }, { deny: 'policy' }],
    [{ policy: 'ask', canPresent: true }, 'present'],
    [{ policy: 'ask', canPresent: false }, { deny: 'unpresentable' }],
  ] as const)('decideHumanInputRequest(%j) → %j', (input, expected) => {
    expect(decideHumanInputRequest(input)).toEqual(expected);
  });

  it('publishes human-input denial copy beside the evaluator', () => {
    expect(texraHumanInputDenialMessage('yolo-no-human')).toBe(
      'User question requires human input; yolo mode cannot synthesize an answer.',
    );
  });
});
