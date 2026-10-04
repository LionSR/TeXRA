import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { classifyModelFailure } from '@agent/runtime/run/modelFailure';
import {
  judgeFailure,
  type BillingRoute,
} from '../../../packages/llm/src/api/verdict.js';

const USAGE_LIMIT_MESSAGE =
  "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing";

const USAGE_LIMIT_BODY = {
  error: {
    message: USAGE_LIMIT_MESSAGE,
    type: 'invalid_request_error',
    code: 'usage_limit_reached',
  },
} as const;

/** An OpenAI-SDK-style rejection, judged on the route the binding bills through. */
function kimiCodeFailure(
  message: string,
  body: unknown,
  status = 403,
  route: BillingRoute = 'kimi-code-subscription',
) {
  const cause = Object.assign(new Error(message), { status, error: body });
  return classifyModelFailure(
    judgeFailure(
      new ModelError({
        kind: status === 403 ? 'authentication' : 'provider-rejection',
        message,
        status,
        cause,
      }),
      route,
    ),
    { config: { provider: ModelProvider.MOONSHOT } },
  );
}

describe('the Kimi Code subscription usage limit', () => {
  it('is a switchable plan exhaustion', () => {
    const { formatted, autoRetryable } = kimiCodeFailure(
      USAGE_LIMIT_MESSAGE,
      USAGE_LIMIT_BODY,
    );

    expect(formatted.classification?.kind).toBe('kimi-code-subscription');
    expect(autoRetryable).toBe(false);
    // The stored Moonshot key is NOT the broken credential, so no key change
    // is forced (that reason is reserved for upstream credit depletion).
    expect(formatted.userRetryable).toBe(true);
    // Copy comes from the quota-fallback catalog, so the sentence names the
    // same fallback the preference switch offers ("Moonshot API keys").
    expect(formatted.message).toContain(
      'Kimi Code subscription usage limit reached. Switch to your own Moonshot API keys',
    );
  });

  it('does not read a Moonshot open-platform rate limit as Kimi Code exhaustion', () => {
    const { formatted } = kimiCodeFailure(
      'Rate limit reached',
      { error: { message: 'Rate limit reached', type: 'rate_limit' } },
      429,
      'api-key',
    );

    expect(formatted.classification?.kind).not.toBe('kimi-code-subscription');
  });
});
