import { describe, expect, it } from 'vitest';

import { ReflectionFlowStateSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import { parseToolUseShared } from '@agent/implementations/flows/tooluse/nodes/types';
import {
  PersistedRetryErrorInfoSchema,
  RetryErrorInfoSchema,
} from '@shared/schemas';
import { reflectionFlowShared } from './progressTestUtils';

const legacyRelayError = {
  message: 'legacy relay error',
  userRetryable: true,
  isCredentialExhausted: true,
  isRelayError: true,
};

function expectNormalizedRelayError(value: unknown): void {
  expect(value).toStrictEqual({
    message: 'legacy relay error',
    userRetryable: true,
    classification: { kind: 'relay-limit' },
  });
}

describe('persisted retry error readers', () => {
  it('accepts canonical retry errors without compatibility fields', () => {
    const current = {
      message: 'current provider error',
      userRetryable: true,
      classification: { kind: 'upstream-credit' as const },
    };

    expect(PersistedRetryErrorInfoSchema.parse(current)).toStrictEqual(current);
  });

  it('strips isRelayError when reflection state normalizes a legacy retry error', () => {
    const parsed = ReflectionFlowStateSchema.parse({
      ...reflectionFlowShared(),
      lastError: legacyRelayError,
    });

    expectNormalizedRelayError(parsed.lastError);
  });

  it('strips isRelayError when tool-use state normalizes a legacy retry error', () => {
    const parsed = parseToolUseShared({
      messages: [],
      continuationGenerationId: '00000000-0000-4000-8000-000000000000',
      shouldSkipCycle: false,
      stateSlices: null,
      lastError: legacyRelayError,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expectNormalizedRelayError(parsed.data.lastError);
  });

  it('keeps live and mixed current records strict', () => {
    expect(RetryErrorInfoSchema.safeParse(legacyRelayError).success).toBe(
      false,
    );
    expect(
      PersistedRetryErrorInfoSchema.safeParse({
        message: 'mixed current and legacy classifications',
        userRetryable: true,
        classification: { kind: 'upstream-credit' },
        exhaustionReason: 'upstream-credit',
      }).success,
    ).toBe(false);
    expect(
      PersistedRetryErrorInfoSchema.safeParse({
        ...legacyRelayError,
        isRelayError: 'yes',
      }).success,
    ).toBe(false);
  });
});
