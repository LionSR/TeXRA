// Third-party imports
import OpenAI from 'openai';

// Local imports - canonical model errors
import { ModelError } from './turn.js';

/** Classifies failures shared by the two direct OpenAI protocols. */
export function openaiFailure(cause: unknown): ModelError {
  if (cause instanceof OpenAI.APIConnectionError) {
    return new ModelError({ kind: 'transport', message: cause.message, cause });
  }
  if (cause instanceof OpenAI.APIError) {
    return new ModelError({
      kind:
        cause.status === 401 || cause.status === 403
          ? 'authentication'
          : 'provider-rejection',
      message: cause.message,
      status: cause.status,
      requestId: cause.requestID ?? undefined,
      cause,
    });
  }
  return new ModelError({
    kind: 'transport',
    message: 'The model transport failed.',
    cause,
  });
}
