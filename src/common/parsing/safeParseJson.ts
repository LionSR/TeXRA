import { Result } from 'effect';
import { type ZodType } from 'zod';

import { ensureError } from '@utils/errors/errorMessage';

/**
 * Parse JSON text without throwing.
 *
 * Returns a `Result.Success<unknown>` with the parsed value typed as
 * `unknown` (the honest type for untrusted text), or a `Result.Failure<Error>`
 * carrying the `SyntaxError` raised by `JSON.parse`. Use this instead of a
 * bare `JSON.parse(...)` wrapped in try/catch. Branch with
 * `Result.isSuccess` / `Result.isFailure`, or chain with `Result.map` /
 * `Result.flatMap` / `Result.getOrElse`.
 */
export function safeParseJson(text: string): Result.Result<unknown, Error> {
  try {
    return Result.succeed(JSON.parse(text) as unknown);
  } catch (error) {
    return Result.fail(ensureError(error));
  }
}

/**
 * Parse JSON text and validate the result against a Zod schema, without
 * throwing. A parse failure or a schema mismatch both yield a
 * `Result.Failure<Error>`; on success the `Result.Success` value is the
 * validated, typed result.
 *
 * Prefer this over `JSON.parse(text) as T` whenever the text comes from an
 * untrusted source (disk, network, IPC): the cast lies if the bytes don't
 * match `T`, whereas this surfaces the mismatch as an error.
 */
export function parseJsonWith<T>(
  text: string,
  schema: ZodType<T>,
): Result.Result<T, Error> {
  return Result.flatMap(safeParseJson(text), (value) => {
    const result = schema.safeParse(value);
    return result.success
      ? Result.succeed(result.data)
      : Result.fail(result.error);
  });
}
