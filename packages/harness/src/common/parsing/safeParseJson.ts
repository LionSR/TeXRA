import { Result } from 'effect';

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
  return Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: ensureError,
  });
}
