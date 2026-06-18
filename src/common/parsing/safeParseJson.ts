import { type ZodType } from 'zod';

import { ensureError } from '@common/errors/errorMessage';
import { type Result, ok, err } from '@common/result';

/**
 * Parse JSON text without throwing.
 *
 * Returns `{ ok: true, value }` with the parsed value typed as `unknown`
 * (the honest type for untrusted text), or `{ ok: false, error }` with the
 * `SyntaxError` raised by `JSON.parse`. Use this instead of a bare
 * `JSON.parse(...)` wrapped in try/catch.
 */
export function safeParseJson(text: string): Result<unknown, Error> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err(ensureError(error));
  }
}

/**
 * Parse JSON text and validate the result against a Zod schema, without
 * throwing. A parse failure or a schema mismatch both yield
 * `{ ok: false, error }`; on success `value` is the validated, typed result.
 *
 * Prefer this over `JSON.parse(text) as T` whenever the text comes from an
 * untrusted source (disk, network, IPC): the cast lies if the bytes don't
 * match `T`, whereas this surfaces the mismatch as an error.
 */
export function parseJsonWith<T>(
  text: string,
  schema: ZodType<T>,
): Result<T, Error> {
  const parsed = safeParseJson(text);
  if (!parsed.ok) return parsed;

  const result = schema.safeParse(parsed.value);
  if (result.success) return ok(result.data);
  return err(result.error);
}
