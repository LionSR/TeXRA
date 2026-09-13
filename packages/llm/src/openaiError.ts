// Third-party imports
import OpenAI from 'openai';

// Local imports - canonical model errors
import { authOrRejectionKind, ModelError, retryAfterMsOf } from './turn.js';

/** Classifies failures shared by the two direct OpenAI protocols. */
export function openaiFailure(cause: unknown): ModelError {
  if (cause instanceof OpenAI.APIConnectionError) {
    return new ModelError({ kind: 'transport', message: cause.message, cause });
  }
  if (cause instanceof OpenAI.APIError) {
    const retryAfterMs = retryAfterMsOf(cause.headers);
    return new ModelError({
      kind: authOrRejectionKind(cause.status),
      message: cause.message,
      status: cause.status,
      requestId: cause.requestID ?? undefined,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      cause,
    });
  }
  return new ModelError({
    kind: 'transport',
    message: 'The model transport failed.',
    cause,
  });
}
