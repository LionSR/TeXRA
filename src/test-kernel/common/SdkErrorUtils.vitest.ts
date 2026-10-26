// Third-party imports
import { BadRequestError as OpenAIBadRequestError } from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports
import { failureInfo } from '@agent/runtime/modelAccess/failureInfo';
import {
  attachErrorPresentationClaimed,
  attachProviderError,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { openaiFailure } from '../../../packages/llm/src/api/openaiError.js';
import { judgeFailure } from '../../../packages/llm/src/api/verdict.js';

/**
 * An OpenAI SDK failure as the binding raises and judges it, recorded the way
 * the run records it: the package owns every verdict on a provider's reply.
 */
const judged = (cause: unknown) =>
  failureInfo(judgeFailure(openaiFailure(cause), 'api-key'), 'openai');

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

describe('attachProviderError end-to-end', () => {
  // A frozen error cannot take a symbol property: marking it must neither
  // throw nor lose the mark, at the error itself or behind a wrapper.
  it('marks a frozen error without throwing', () => {
    const frozen = Object.freeze(new Error('overloaded'));
    attachErrorPresentationClaimed(frozen);
    attachProviderError(frozen, { message: 'overloaded', userRetryable: true });

    expect(hasErrorPresentationClaimed(frozen)).toBe(true);
    expect(
      hasErrorPresentationClaimed(new Error('wrapped', { cause: frozen })),
    ).toBe(true);
    expect(normalizeProviderError(frozen).userRetryable).toBe(true);
  });
});
