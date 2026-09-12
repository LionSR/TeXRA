import { describe, expect, it } from 'vitest';

import { attachSdkUsageRoute } from '@common/errors/sdkError/errorMetadata';
import { parseKimiCodeSubscriptionLimit } from '@common/errors/sdkError/kimiCodeSubscriptionDetection';
import { formatProviderHttpError } from '@common/errors/sdkError/providerErrorFormat';
import { type UsageRoute } from '@shared/schemas';

const USAGE_LIMIT_MESSAGE =
  "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing";

const USAGE_LIMIT_BODY = {
  error: {
    message: USAGE_LIMIT_MESSAGE,
    type: 'invalid_request_error',
    code: 'usage_limit_reached',
  },
} as const;

/** Build an OpenAI-SDK-style error stamped with the credential route the run
 *  bound the attempt to, the way `classifyModelFailure` stamps it. */
function kimiCodeError(
  message: string,
  body: unknown,
  status = 403,
  usageRoute: UsageRoute = 'kimi-code-subscription',
): Error & {
  status: number;
  error: unknown;
  provider?: string;
} {
  const error = new Error(message) as Error & {
    status: number;
    error: unknown;
    provider?: string;
  };
  error.status = status;
  error.error = body;
  attachSdkUsageRoute(error, usageRoute);
  return error;
}

describe('parseKimiCodeSubscriptionLimit', () => {
  it('parses a Kimi Code usage-limit error on the coding endpoint', () => {
    const limit = parseKimiCodeSubscriptionLimit(
      kimiCodeError(USAGE_LIMIT_MESSAGE, USAGE_LIMIT_BODY),
      USAGE_LIMIT_BODY,
    );
    expect(limit).not.toBeNull();
  });

  it('returns null when the attempt was bound to the API-key route', () => {
    const error = kimiCodeError(
      USAGE_LIMIT_MESSAGE,
      USAGE_LIMIT_BODY,
      403,
      'api-key',
    );
    expect(parseKimiCodeSubscriptionLimit(error, USAGE_LIMIT_BODY)).toBeNull();
  });

  it('returns null when the body does not carry the distinctive usage-limit message', () => {
    const rateLimitBody = {
      error: { message: 'Rate limit reached, slow down', type: 'rate_limit' },
    };
    expect(
      parseKimiCodeSubscriptionLimit(
        kimiCodeError('Rate limit reached, slow down', rateLimitBody),
        rateLimitBody,
      ),
    ).toBeNull();
  });

  it('returns null for unrelated bodies', () => {
    expect(
      parseKimiCodeSubscriptionLimit(
        kimiCodeError('nope', { message: 'nope' }),
        { message: 'nope' },
      ),
    ).toBeNull();
  });
});

describe('formatProviderHttpError for Kimi Code subscription limits', () => {
  it('classifies a Kimi Code usage-limit error as a switchable credential exhaustion', () => {
    const error = kimiCodeError(USAGE_LIMIT_MESSAGE, USAGE_LIMIT_BODY);
    error.provider = 'moonshot';

    const providerError = formatProviderHttpError(error);

    expect(providerError.classification?.kind).toBe('kimi-code-subscription');
    // The stored Moonshot key is NOT the broken credential, so no key change
    // is forced (that reason is reserved for upstream credit depletion).
    expect(providerError.userRetryable).toBe(true);
    // Copy comes from the quota-fallback catalog, so the sentence names the
    // same fallback the preference switch offers ("Moonshot API keys").
    expect(providerError.message).toContain(
      'Kimi Code subscription usage limit reached. Switch to your own Moonshot API keys',
    );
  });

  it('does not classify a Moonshot open-platform rate limit as Kimi Code exhaustion', () => {
    const error = kimiCodeError(
      'Rate limit reached',
      { error: { message: 'Rate limit reached', type: 'rate_limit' } },
      429,
      'api-key',
    );
    error.provider = 'moonshot';

    const providerError = formatProviderHttpError(error);

    expect(providerError.classification?.kind).not.toBe(
      'kimi-code-subscription',
    );
  });
});
