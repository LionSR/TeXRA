import { z } from 'zod';

import { toErrorMessage } from './errorMessage';

const MAX_ERROR_LENGTH = 500;

/** Format an error with a prefix for logging or user messages. */
export function formatError(prefix: string, err: unknown): string {
  const detail = toErrorMessage(err);
  if (detail.length > MAX_ERROR_LENGTH) {
    return `${prefix}: ${detail.slice(0, MAX_ERROR_LENGTH)}...`;
  }
  return `${prefix}: ${detail}`;
}

/** Format a Zod validation error into a human-readable string. */
export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}
