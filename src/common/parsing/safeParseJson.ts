import { type ZodType } from 'zod';
import { type Result, ok, err } from 'neverthrow';

import { ensureError } from '@utils/errors/errorMessage';

/**
 * Parse JSON text without throwing.
 *
 * Returns an `Ok<unknown>` with the parsed value typed as `unknown` (the
 * honest type for untrusted text), or an `Err<Error>` carrying the
 * `SyntaxError` raised by `JSON.parse`. Use this instead of a bare
 * `JSON.parse(...)` wrapped in try/catch. Branch with `result.isOk()` /
 * `result.isErr()`, or chain with `.map` / `.andThen` / `.match`.
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
 * throwing. A parse failure or a schema mismatch both yield an `Err<Error>`;
 * on success the `Ok` value is the validated, typed result.
 *
 * Prefer this over `JSON.parse(text) as T` whenever the text comes from an
 * untrusted source (disk, network, IPC): the cast lies if the bytes don't
 * match `T`, whereas this surfaces the mismatch as an error.
 */
export function parseJsonWith<T>(
  text: string,
  schema: ZodType<T>,
): Result<T, Error> {
  return safeParseJson(text).andThen((value) => {
    const result = schema.safeParse(value);
    return result.success ? ok(result.data) : err(result.error);
  });
}
