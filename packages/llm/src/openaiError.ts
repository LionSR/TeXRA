// Third-party imports
import OpenAI from 'openai';

// Local imports - canonical model errors
import { type ModelError, sdkModelError } from './errors.js';

/** Classifies failures shared by the two direct OpenAI protocols. */
export function openaiFailure(cause: unknown): ModelError {
  return sdkModelError(
    cause,
    cause instanceof OpenAI.APIError &&
      !(cause instanceof OpenAI.APIConnectionError)
      ? {
          status: cause.status,
          headers: cause.headers,
          requestId: cause.requestID,
        }
      : undefined,
    'The model transport failed.',
  );
}
