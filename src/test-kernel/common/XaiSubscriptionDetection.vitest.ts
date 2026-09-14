import { describe, expect, it } from 'vitest';

import { attachSdkUsageRoute } from '@common/errors/sdkError/errorMetadata';
import { formatProviderHttpError } from '@common/errors/sdkError/providerErrorFormat';
import { parseXaiSubscriptionLimit } from '@common/errors/sdkError/xaiSubscriptionDetection';
import { type UsageRoute } from '@shared/schemas';

const USAGE_LIMIT_BODY = {
  message: "You've reached your weekly usage limit.",
  resets_in_seconds: 3600,
} as const;

const RATE_LIMIT_BODY = {
  message: 'Rate limit reached. Too many requests.',
} as const;

/** Build an xAI error stamped with the credential route the run bound the
 *  attempt to, the way `classifyModelFailure` stamps it. SuperGrok and a
 *  direct xAI key share `api.x.ai`, so the stamp is the only route signal. */
function xaiError(
  message: string,
  body?: unknown,
  usageRoute: UsageRoute = 'xai-subscription',
): Error & { error?: unknown; status?: number } {
  const error = new Error(message) as Error & {
    error?: unknown;
    status?: number;
  };
  if (body !== undefined) error.error = body;
  attachSdkUsageRoute(error, usageRoute);
  return error;
}

describe('parseXaiSubscriptionLimit', () => {
  it('ignores quota wording on an error with no route stamp', () => {
    expect(
      parseXaiSubscriptionLimit(new Error(USAGE_LIMIT_BODY.message), {
        error: USAGE_LIMIT_BODY,
      }),
    ).toBeNull();
  });

  it('returns null when the attempt was bound to the API-key route', () => {
    expect(
      parseXaiSubscriptionLimit(
        xaiError('rejected', USAGE_LIMIT_BODY, 'api-key'),
        { error: USAGE_LIMIT_BODY },
      ),
    ).toBeNull();
  });

  it('parses a SuperGrok usage-limit body on the subscription route', () => {
    expect(
      parseXaiSubscriptionLimit(xaiError('rejected'), {
        error: USAGE_LIMIT_BODY,
      }),
    ).toEqual({ resetsInSeconds: 3600 });
  });

  it('parses the unenveloped body shape too', () => {
    expect(
      parseXaiSubscriptionLimit(xaiError('rejected'), USAGE_LIMIT_BODY),
    ).toEqual({ resetsInSeconds: 3600 });
  });

  it('ignores a transient rate limit on the subscription route', () => {
    expect(
      parseXaiSubscriptionLimit(xaiError('rate limited'), {
        error: RATE_LIMIT_BODY,
      }),
    ).toBeNull();
  });
});

describe('formatProviderHttpError for Grok subscription limits', () => {
  it('classifies a subscription-route usage limit as switchable exhaustion', () => {
    const providerError = formatProviderHttpError(
      xaiError('xAI rejected the request', USAGE_LIMIT_BODY),
    );

    expect(providerError.classification?.kind).toBe('xai-subscription');
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('Grok subscription usage limit');
    // The affordance names the same fallback the preference switch offers.
    expect(providerError.message).toContain(
      'Resets in 1h. Switch to your own xAI API key',
    );
  });

  it('does not classify the same body on the API-key route as exhaustion', () => {
    const error = xaiError(
      'xAI rejected the request',
      USAGE_LIMIT_BODY,
      'api-key',
    );
    error.status = 429;

    const providerError = formatProviderHttpError(error);

    expect(providerError.classification?.kind).not.toBe('xai-subscription');
    expect(providerError.message).not.toContain('Switch to your own xAI');
  });
});
