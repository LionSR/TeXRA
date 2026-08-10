import { describe, expect, it } from 'vitest';

import {
  describeKimiCodeSubscriptionLimit,
  parseKimiCodeSubscriptionLimit,
} from '@common/errors/sdkError/kimiCodeSubscriptionDetection';
import {
  formatProviderHttpError,
} from '@common/errors/sdkError/providerErrorFormat';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';

const USAGE_LIMIT_MESSAGE =
  "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing";

const USAGE_LIMIT_BODY = {
  error: {
    message: USAGE_LIMIT_MESSAGE,
    type: 'invalid_request_error',
    code: 'usage_limit_reached',
  },
} as const;

/** Build an OpenAI-SDK-style error carrying the Kimi Code coding endpoint. */
function kimiCodeError(
  message: string,
  body: unknown,
  status = 403,
  baseURL = KIMI_CODE_BASE_URL,
): Error & {
  status: number;
  request: { baseURL: string };
  error: unknown;
  provider?: string;
} {
  const error = new Error(message) as Error & {
    status: number;
    request: { baseURL: string };
    error: unknown;
    provider?: string;
  };
  error.status = status;
  error.request = { baseURL };
  error.error = body;
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

  it('returns null when the error is not on the Kimi Code coding endpoint', () => {
    const error = kimiCodeError(
      USAGE_LIMIT_MESSAGE,
      USAGE_LIMIT_BODY,
      403,
      'https://api.moonshot.cn/v1',
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

  it('formats a human-readable reset hint', () => {
    const text = describeKimiCodeSubscriptionLimit({ resetsInSeconds: 3600 });
    expect(text).toContain('Kimi Code subscription usage limit');
    expect(text).toContain('Moonshot API key');
  });
});

describe('formatProviderHttpError for Kimi Code subscription limits', () => {
  it('classifies a Kimi Code usage-limit error as a switchable credential exhaustion', () => {
    const error = kimiCodeError(USAGE_LIMIT_MESSAGE, USAGE_LIMIT_BODY);
    error.provider = 'moonshot';

    const providerError = formatProviderHttpError(error);

    expect(providerError.exhaustionReason).toBe('kimi-code-subscription');
    // The stored Moonshot key is NOT the broken credential, so no key change
    // is forced (that reason is reserved for upstream credit depletion).
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain(
      'Kimi Code subscription usage limit',
    );
  });

  it('does not classify a Moonshot open-platform rate limit as Kimi Code exhaustion', () => {
    const error = kimiCodeError(
      'Rate limit reached',
      { error: { message: 'Rate limit reached', type: 'rate_limit' } },
      429,
      'https://api.moonshot.cn/v1',
    );
    error.provider = 'moonshot';

    const providerError = formatProviderHttpError(error);

    expect(providerError.exhaustionReason).not.toBe('kimi-code-subscription');
  });
});
