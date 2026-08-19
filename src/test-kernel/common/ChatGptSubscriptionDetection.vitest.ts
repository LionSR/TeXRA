import { describe, expect, it } from 'vitest';

import { parseChatGptSubscriptionLimit } from '@common/errors/sdkError/chatgptSubscriptionDetection';
import { formatProviderHttpError } from '@common/errors/sdkError/providerErrorFormat';

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
});

/** Codex-shaped error carrying `body` as its SDK error payload. */
function codexError(body: unknown): Error {
  const error = new Error('codex backend rejected the request') as Error & {
    error: unknown;
    provider?: string;
  };
  error.error = body;
  error.provider = 'openai';
  return error;
}

describe('formatProviderHttpError for ChatGPT subscription limits', () => {
  it('classifies a usage-limit error as a switchable credential exhaustion', () => {
    const providerError = formatProviderHttpError(codexError(USAGE_LIMIT_BODY));

    expect(providerError.exhaustionReason).toBe('chatgpt-subscription');
    // The stored OpenAI key is NOT the broken credential, so no key change is
    // forced (that reason is reserved for upstream credit depletion).
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('ChatGPT subscription usage limit');
    // ChatGPT is the only route with a plan slot.
    expect(providerError.message).toContain('(Pro plan)');
    expect(providerError.message).toContain('Resets in 1d 20h');
    expect(providerError.message).toContain('your own OpenAI API key');
  });

  it('drops minutes once the reset window reaches a day, even with a zero hour component', () => {
    // 1 day + 58 minutes, 0 whole hours — regression case for the pretty-ms
    // swap: without flooring to the hour once days >= 1, pretty-ms back-fills
    // the zero hour unit with minutes ("1d 58m") instead of "1d".
    const { message } = formatProviderHttpError(
      codexError({
        type: 'usage_limit_reached',
        resets_in_seconds: 86_400 + 58 * 60,
      }),
    );
    expect(message).toContain('Resets in 1d.');
    expect(message).not.toContain('58m');
  });
});
