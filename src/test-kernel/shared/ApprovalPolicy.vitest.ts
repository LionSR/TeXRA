import { beforeEach, describe, expect, it, vi } from 'vitest';

import { warn } from '@logger/logUtils';
import {
  TEXRA_APPROVAL_POLICIES,
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  TEXRA_APPROVAL_POLICY_DENIED_MESSAGE,
  TEXRA_APPROVAL_POLICY_DISPLAY_ORDER,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE,
  TEXRA_APPROVAL_YOLO_NO_HUMAN_MESSAGE,
  TEXRA_APPROVAL_YOLO_RETRY_MESSAGE,
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
  parseTexraApprovalPolicy,
  readPersistedTexraApprovalPolicy,
  texraApprovalDenialMessage,
  texraHumanInputDenialMessage,
  texraRetryDenialMessage,
} from '@shared/approvalPolicy';

vi.mock('@logger/logUtils', () => ({
  warn: vi.fn(),
}));

describe('TeXRA approval policy', () => {
  beforeEach(() => {
    vi.mocked(warn).mockClear();
  });

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
    expect(TEXRA_APPROVAL_POLICY_OPTIONS.map(({ value }) => value)).toEqual([
      'ask',
      'never',
      'yolo',
    ]);
    expect(new Set(TEXRA_APPROVAL_POLICY_DISPLAY_ORDER)).toEqual(
      new Set(TEXRA_APPROVAL_POLICIES),
    );
    expect(TEXRA_APPROVAL_POLICY_DISPLAY_ORDER).toHaveLength(
      TEXRA_APPROVAL_POLICIES.length,
    );
    expect(parseTexraApprovalPolicy(' Yolo ')).toBe('yolo');
    expect(parseTexraApprovalPolicy('auto')).toBeUndefined();
  });

  it('reads a valid persisted policy without warning', () => {
    expect(
      readPersistedTexraApprovalPolicy((key, fallback) => {
        expect(key).toBe(TEXRA_APPROVAL_POLICY_CONFIG_KEY);
        return 'never' as typeof fallback;
      }),
    ).toBe('never');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'auto',
      `Ignoring invalid ${TEXRA_APPROVAL_POLICY_CONFIG_KEY} "auto"; using "${TEXRA_APPROVAL_POLICY_DEFAULT}".`,
    ],
    [
      42,
      `Ignoring invalid ${TEXRA_APPROVAL_POLICY_CONFIG_KEY} value 42; using "${TEXRA_APPROVAL_POLICY_DEFAULT}".`,
    ],
  ] as const)(
    'warns and falls back when the persisted policy value is invalid: %j',
    (stored, expectedWarning) => {
      expect(readPersistedTexraApprovalPolicy(() => stored as never)).toBe(
        TEXRA_APPROVAL_POLICY_DEFAULT,
      );
      expect(warn).toHaveBeenCalledWith('approval-policy', expectedWarning);
    },
  );

  it('maps deny reasons to distinct user-facing messages', () => {
    expect(texraApprovalDenialMessage('deny-policy')).toBe(
      TEXRA_APPROVAL_POLICY_DENIED_MESSAGE,
    );
    expect(texraApprovalDenialMessage('deny-unpresentable')).toBe(
      TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE,
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
      TEXRA_APPROVAL_YOLO_RETRY_MESSAGE,
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
      TEXRA_APPROVAL_YOLO_NO_HUMAN_MESSAGE,
    );
  });
});
