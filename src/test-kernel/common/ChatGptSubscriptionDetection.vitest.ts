import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { classifyModelFailure } from '@agent/runtime/run/modelFailure';
import { judgeFailure } from '../../../packages/llm/src/api/verdict.js';

const USAGE_LIMIT_BODY = {
  type: 'usage_limit_reached',
  message: 'The usage limit has been reached',
  plan_type: 'pro',
  resets_at: 1782634869,
  eligible_promo: null,
  resets_in_seconds: 159728,
} as const;

/** The Codex backend's rejection, as the binding judges it and the run reads it. */
function codexFailure(body: unknown) {
  const cause = Object.assign(new Error('codex backend rejected the request'), {
    error: body,
  });
  const judged = judgeFailure(
    new ModelError({
      kind: 'provider-rejection',
      message: cause.message,
      cause,
    }),
    'chatgpt-subscription',
  );
  return {
    judged,
    formatted: classifyModelFailure(judged, {
      config: { provider: ModelProvider.OPENAI },
    }).formatted,
  };
}

describe('the ChatGPT subscription usage limit', () => {
  it('is a used-up plan with its tier and reset, direct or enveloped', () => {
    expect(codexFailure(USAGE_LIMIT_BODY).judged).toMatchObject({
      kind: 'quota-exhausted',
      retryable: false,
      quota: {
        plan: 'chatgpt-subscription',
        planType: 'pro',
        resetsInMs: 159_728_000,
      },
    });
    expect(
      codexFailure({ error: USAGE_LIMIT_BODY }).judged.quota?.planType,
    ).toBe('pro');
  });

  it('is not read into an unrelated body', () => {
    expect(codexFailure({ type: 'rate_limit_exceeded' }).judged.quota).toBe(
      undefined,
    );
    expect(codexFailure({ message: 'nope' }).judged.quota).toBe(undefined);
  });

  it('offers the switch to the OpenAI key', () => {
    const { formatted } = codexFailure(USAGE_LIMIT_BODY);

    expect(formatted.classification?.kind).toBe('chatgpt-subscription');
    // The stored OpenAI key is NOT the broken credential, so no key change is
    // forced (that reason is reserved for upstream credit depletion).
    expect(formatted.userRetryable).toBe(true);
    expect(formatted.message).toContain('ChatGPT subscription usage limit');
    // ChatGPT is the only route with a plan slot.
    expect(formatted.message).toContain('(Pro plan)');
    expect(formatted.message).toContain('Resets in 1d 20h');
    expect(formatted.message).toContain('your own OpenAI API key');
  });

  it('drops minutes once the reset window reaches a day, even with a zero hour component', () => {
    // 1 day + 58 minutes, 0 whole hours — regression case for the pretty-ms
    // swap: without flooring to the hour once days >= 1, pretty-ms back-fills
    // the zero hour unit with minutes ("1d 58m") instead of "1d".
    const { message } = codexFailure({
      type: 'usage_limit_reached',
      resets_in_seconds: 86_400 + 58 * 60,
    }).formatted;
    expect(message).toContain('Resets in 1d.');
    expect(message).not.toContain('58m');
  });
});
