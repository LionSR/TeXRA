import { describe, expect, it } from 'vitest';

import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideApproval,
} from '@shared/approvalPolicy';

describe('TeXRA approval policy', () => {
  it.each([
    ['never', true, true, true, 'deny-policy'],
    ['ask', true, false, false, 'deny-unpresentable'],
    ['ask', true, true, false, 'allow'],
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
      { policy: 'ask', canPresent: false, isCredentialFailure: false },
      { deny: 'unpresentable' },
    ],
  ] as const)('decideRetryApproval(%j) → %j', (input, expected) => {
    expect(decideRetryApproval(input)).toEqual(expected);
  });

  it.each([
    [{ policy: 'yolo', canPresent: true }, { deny: 'yolo-no-human' }],
    [{ policy: 'ask', canPresent: false }, { deny: 'unpresentable' }],
  ] as const)('decideHumanInputRequest(%j) → %j', (input, expected) => {
    expect(decideHumanInputRequest(input)).toEqual(expected);
  });
});
