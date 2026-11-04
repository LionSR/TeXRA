// Third-party imports
import { APIError, BadRequestError as OpenAIBadRequestError } from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports
import { RouteUnavailable } from '@texra-ai/harness/host';
import { failureInfo } from '@agent/runtime/modelAccess/failureInfo';
import { openaiFailure } from '../../../packages/llm/src/api/openaiError.js';
import { judgeFailure } from '../../../packages/llm/src/api/verdict.js';
import { ModelError } from '../../../packages/llm/src/errors.js';

/**
 * An OpenAI SDK failure as the binding raises and judges it, recorded the way
 * the run records it: the package owns every verdict on a provider's reply.
 */
const judged = (cause: unknown) =>
  failureInfo(judgeFailure(openaiFailure(cause), 'api-key', false), 'openai');

describe('context-window overflow', () => {
  it("is the verdict on OpenAI's native error code even when the message wording is unfamiliar", () => {
    const err = new OpenAIBadRequestError(
      400,
      { code: 'context_length_exceeded', message: 'Some brand-new wording' },
      'Some brand-new wording',
      new Headers(),
    );

    expect(judged(err).classification).toStrictEqual({
      kind: 'context-window',
    });
  });
});

describe('an account out of credit', () => {
  // DeepSeek answers a request on an empty balance with a 402 whose error
  // type, not its code, says why (the code is a generic
  // `invalid_request_error`).
  it("is the credit verdict on DeepSeek's insufficient balance", () => {
    const err = new APIError(
      402,
      {
        message: 'Insufficient Balance',
        type: 'insufficient_balance_error',
        param: null,
        code: 'invalid_request_error',
      },
      '402 Insufficient Balance',
      new Headers(),
    );

    expect(judged(err).classification).toStrictEqual({
      kind: 'upstream-credit',
    });
  });
});

describe('a ChatGPT plan limit', () => {
  // OpenAI can end a streamed response with `response.failed` once the plan
  // runs out; the stream's terminal event carries the error as a plain object.
  it('is the quota verdict when it arrives as a failed response event', () => {
    const failed = new ModelError({
      kind: 'provider-rejection',
      message: 'Usage limit reached.',
      cause: {
        code: 'subscription_sharing_usage_limit_exceeded',
        message: 'Usage limit reached.',
      },
    });

    expect(
      judgeFailure(failed, 'chatgpt-subscription', false).quota,
    ).toStrictEqual({ plan: 'chatgpt-subscription' });
  });
});

describe('a subscription that cannot bill', () => {
  // A host words a lapsed session (which switch, which sign-in) from what
  // the run records with the failure; composed into the harness's plain
  // message, the facts were lost to every stored row and notice.
  it('is recorded with its route, its sign-in need and the session failure', () => {
    const lapsed = new RouteUnavailable({
      reason: 'unavailable',
      message: 'The refresh token was revoked.',
      session: { route: 'chatgpt-subscription', needsReauth: true },
    });

    expect(failureInfo(lapsed, 'openai').classification).toStrictEqual({
      kind: 'subscription-session',
      route: 'chatgpt-subscription',
      needsReauth: true,
      sessionError: 'The refresh token was revoked.',
    });
  });
});
