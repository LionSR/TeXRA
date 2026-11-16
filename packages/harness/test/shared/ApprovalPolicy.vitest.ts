import { describe, expect, it } from 'vitest';

import { decideApproval } from '@shared/approvalPolicy';

const POLICY_DENIED = 'Denied by the approval policy.';
const UNPRESENTABLE =
  'Interactive approval requires a prompt; this run cannot present one.';

describe('TeXRA approval policy', () => {
  it.each([
    ['never', true, true, { action: 'deny', reason: POLICY_DENIED }],
    ['ask', false, false, { action: 'deny', reason: UNPRESENTABLE }],
    ['ask', true, false, 'allow'],
  ] as const)(
    'decides an operation under %s with granted=%s, canPresent=%s as %j',
    (policy, granted, canPresent, expected) => {
      expect(
        decideApproval({
          policy,
          canPresent,
          ask: { kind: 'operation', granted, hook: undefined },
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    [
      { policy: 'yolo', canPresent: true, credentialFailure: false },
      'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
    ],
    [
      { policy: 'yolo', canPresent: true, credentialFailure: true },
      'Retry skipped: credential exhausted or unauthorized.',
    ],
    [
      { policy: 'ask', canPresent: false, credentialFailure: false },
      UNPRESENTABLE,
    ],
  ] as const)(
    'denies a retry (%j) with %j',
    ({ policy, canPresent, credentialFailure }, reason) => {
      expect(
        decideApproval({
          policy,
          canPresent,
          ask: { kind: 'retry', credentialFailure },
        }),
      ).toEqual({ action: 'deny', reason });
    },
  );

  it.each([
    [
      { policy: 'yolo', canPresent: true },
      'User question requires human input; yolo mode cannot synthesize an answer.',
    ],
    [{ policy: 'ask', canPresent: false }, UNPRESENTABLE],
  ] as const)('denies a question (%j) with %j', (input, reason) => {
    expect(decideApproval({ ...input, ask: { kind: 'question' } })).toEqual({
      action: 'deny',
      reason,
    });
  });
});
