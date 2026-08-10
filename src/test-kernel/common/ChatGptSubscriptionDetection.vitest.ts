import { describe, expect, it } from 'vitest';

import {
  describeChatGptSubscriptionLimit,
  parseChatGptSubscriptionLimit,
} from '@common/errors/sdkError/chatgptSubscriptionDetection';
import {
  formatProviderHttpError,
} from '@common/errors/sdkError/providerErrorFormat';

const USAGE_LIMIT_BODY = {
  type: 'usage_limit_reached',
  message: 'The usage limit has been reached',
  plan_type: 'pro',
  resets_at: 1782634869,
  eligible_promo: null,
  resets_in_seconds: 159728,
} as const;

describe('parseChatGptSubscriptionLimit', () => {
  it('parses a direct Codex usage-limit body', () => {
    const limit = parseChatGptSubscriptionLimit(USAGE_LIMIT_BODY);
    expect(limit).toEqual({
      planType: 'pro',
      resetsInSeconds: 159728,
    });
  });

  it('parses the SDK-enveloped { error } form', () => {
    expect(
      parseChatGptSubscriptionLimit({ error: USAGE_LIMIT_BODY })?.planType,
    ).toBe('pro');
  });

  it('ignores unrelated bodies', () => {
    expect(parseChatGptSubscriptionLimit({ type: 'rate_limit_exceeded' })).toBe(
      null,
    );
    expect(parseChatGptSubscriptionLimit(undefined)).toBe(null);
    expect(parseChatGptSubscriptionLimit({ message: 'nope' })).toBe(null);
  });

  it('formats a human-readable reset hint', () => {
    const text = describeChatGptSubscriptionLimit({
      planType: 'pro',
      resetsInSeconds: 159728,
    });
    expect(text).toContain('Pro plan');
    expect(text).toContain('Resets in 1d 20h');
    expect(text).toContain('OpenAI API key');
  });

  it('drops minutes once the reset window reaches a day, even with a zero hour component', () => {
    // 1 day + 58 minutes, 0 whole hours — regression case for the pretty-ms
    // swap: without flooring to the hour once days >= 1, pretty-ms back-fills
    // the zero hour unit with minutes ("1d 58m") instead of "1d".
    const text = describeChatGptSubscriptionLimit({
      resetsInSeconds: 86_400 + 58 * 60,
    });
    expect(text).toContain('Resets in 1d.');
    expect(text).not.toContain('58m');
  });
});

describe('formatProviderHttpError for ChatGPT subscription limits', () => {
  it('classifies a usage-limit error as a switchable credential exhaustion', () => {
    const error = new Error('codex backend rejected the request') as Error & {
      error: unknown;
      provider?: string;
    };
    error.error = USAGE_LIMIT_BODY;
    error.provider = 'openai';

    const providerError = formatProviderHttpError(error);

    expect(providerError.exhaustionReason).toBe('chatgpt-subscription');
    // The stored OpenAI key is NOT the broken credential, so no key change is
    // forced (that reason is reserved for upstream credit depletion).
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('ChatGPT subscription usage limit');
  });
});
