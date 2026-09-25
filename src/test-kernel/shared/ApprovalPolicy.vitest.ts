import { describe, expect, it } from 'vitest';

import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
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
