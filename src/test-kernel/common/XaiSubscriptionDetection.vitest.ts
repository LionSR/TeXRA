import { describe, expect, it } from 'vitest';

import { formatProviderHttpError } from '@common/errors/sdkError/providerErrorFormat';
import {
  attachSdkCredentialRoute,
  detectSdkCredentialRoute,
} from '@common/errors/sdkError/sdkRequestEndpoint';
import {
  describeXaiSubscriptionLimit,
  parseXaiSubscriptionLimit,
} from '@common/errors/sdkError/xaiSubscriptionDetection';

const USAGE_LIMIT_BODY = {
  message: "You've reached your weekly usage limit.",
  resets_in_seconds: 3600,
} as const;

function stampedError(message: string, body?: unknown): Error {
  const error = new Error(message) as Error & { error?: unknown };
  if (body !== undefined) error.error = body;
  attachSdkCredentialRoute(error, 'xai-subscription');
  return error;
}

describe('parseXaiSubscriptionLimit', () => {
  it('ignores quota wording without the subscription route stamp', () => {
    expect(
      parseXaiSubscriptionLimit(new Error(USAGE_LIMIT_BODY.message), {
        error: USAGE_LIMIT_BODY,
      }),
    ).toBeNull();
  });

  it('parses a stamped SuperGrok usage-limit body', () => {
    const error = stampedError('rejected');
    expect(detectSdkCredentialRoute(error)).toBe('xai-subscription');
    expect(
      parseXaiSubscriptionLimit(error, { error: USAGE_LIMIT_BODY }),
    ).toEqual({ resetsInSeconds: 3600 });
  });

  it('ignores a stamped transient rate limit', () => {
    const error = stampedError('rate limited');
    expect(
      parseXaiSubscriptionLimit(error, {
        error: { message: 'Rate limit reached. Too many requests.' },
      }),
    ).toBeNull();
  });

  it('formats a human-readable reset hint', () => {
    expect(describeXaiSubscriptionLimit({ resetsInSeconds: 3600 })).toContain(
      'Resets in 1h',
    );
  });
});

describe('formatProviderHttpError for Grok subscription limits', () => {
  it('classifies a stamped usage-limit error as switchable exhaustion', () => {
    const error = stampedError('xAI rejected the request', USAGE_LIMIT_BODY);
    const providerError = formatProviderHttpError(error);
    expect(providerError.exhaustionReason).toBe('xai-subscription');
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('Grok subscription usage limit');
  });
});
