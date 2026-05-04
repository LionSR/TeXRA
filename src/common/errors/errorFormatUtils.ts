import { toErrorMessage } from './errorMessage';
import type { z } from 'zod';

const MAX_ERROR_LENGTH = 500;

/** Format an error with a prefix for logging or user messages. */
export function formatError(prefix: string, err: unknown): string {
  const detail = toErrorMessage(err);
  if (detail.length > MAX_ERROR_LENGTH) {
    return `${prefix}: ${detail.substring(0, MAX_ERROR_LENGTH)}...`;
  }
  return `${prefix}: ${detail}`;
}

/** Format a Zod validation error into a human-readable string. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
    )
    .join(', ');
}
