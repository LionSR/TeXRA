import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { failureInfo } from '@agent/runtime/modelAccess/failureInfo';
import {
  judgeFailure,
  type BillingRoute,
} from '../../../packages/llm/src/api/verdict.js';

const USAGE_LIMIT_BODY = {
  message: "You've reached your weekly usage limit.",
  resets_in_seconds: 3600,
} as const;

const RATE_LIMIT_BODY = {
  message: 'Rate limit reached. Too many requests.',
} as const;

/**
 * An xAI rejection judged on the route the binding bills through. SuperGrok
 * and a direct xAI key share `api.x.ai`, so the route is the only signal.
 */
function xaiFailure(
  body: unknown,
  route: BillingRoute = 'xai-subscription',
  status?: number,
) {
  const cause = Object.assign(new Error('xAI rejected the request'), {
    error: body,
    ...(status === undefined ? {} : { status }),
  });
  return failureInfo(
    judgeFailure(
      new ModelError({
        kind: 'provider-rejection',
        message: cause.message,
        ...(status === undefined ? {} : { status }),
        cause,
      }),
      route,
    ),
    ModelProvider.XAI,
  );
}

describe('the Grok subscription usage limit', () => {
  it('is a switchable plan exhaustion on the subscription route', () => {
    const formatted = xaiFailure(USAGE_LIMIT_BODY);

    expect(formatted.classification?.kind).toBe('xai-subscription');
    expect(formatted.userRetryable).toBe(true);
    expect(formatted.message).toContain('Grok subscription usage limit');
    // The affordance names the same fallback the preference switch offers.
    expect(formatted.message).toContain(
      'Resets in 1h. Switch to your own xAI API key',
    );
  });

  it('is not read into a transient rate limit on the subscription route', () => {
    expect(xaiFailure(RATE_LIMIT_BODY).classification?.kind).not.toBe(
      'xai-subscription',
    );
  });

  it('is not read into the same body on the API-key route', () => {
    const formatted = xaiFailure(USAGE_LIMIT_BODY, 'api-key', 429);

    expect(formatted.classification?.kind).not.toBe('xai-subscription');
    expect(formatted.message).not.toContain('Switch to your own xAI');
  });
});
