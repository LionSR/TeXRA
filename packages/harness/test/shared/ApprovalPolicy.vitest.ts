import { describe, expect, it } from 'vitest';

import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideApproval,
} from '@shared/approvalPolicy';

describe('TeXRA approval policy', () => {
  it.each([
    ['never', true, true, { deny: 'Denied by the approval policy.' }],
    ['ask', false, false, { deny: expect.stringContaining('a prompt') }],
    ['ask', true, false, 'allow'],
  ] as const)(
    'decides %s with bypass=%s, canPresent=%s as %j',
    (policy, scopedBypass, canPresent, expected) => {
      expect(decideApproval({ policy, scopedBypass, canPresent })).toEqual(
        expected,
      );
    },
  );

  it.each([
    [
      { policy: 'yolo', canPresent: true, isCredentialFailure: false },
      'automatic attempts',
    ],
    [
      { policy: 'yolo', canPresent: true, isCredentialFailure: true },
      'credential',
    ],
    [
      { policy: 'ask', canPresent: false, isCredentialFailure: false },
      'a prompt',
    ],
  ] as const)('decideRetryApproval(%j) denies: %s', (input, message) => {
    expect(decideRetryApproval(input)).toEqual({
      deny: expect.stringContaining(message),
    });
  });

  it.each([
    [{ policy: 'yolo', canPresent: true }, 'yolo mode'],
    [{ policy: 'ask', canPresent: false }, 'a prompt'],
  ] as const)('decideHumanInputRequest(%j) denies: %s', (input, message) => {
    expect(decideHumanInputRequest(input)).toEqual({
      deny: expect.stringContaining(message),
    });
  });
});
