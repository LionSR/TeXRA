import { Result } from 'effect';
import * as yaml from 'yaml';

import { ensureError } from '@utils/errors/errorMessage';

/**
 * Parse YAML text without throwing.
 *
 * Returns a `Result.Success<unknown>` with the parsed value typed as
 * `unknown` (the honest type for untrusted text), or a `Result.Failure<Error>`
 * carrying the parse error raised by `yaml.parse`. Use this instead of a bare
 * `yaml.parse(...)` wrapped in try/catch. Branch with `Result.isSuccess` /
 * `Result.isFailure`, or chain with `Result.map` / `Result.flatMap` /
 * `Result.getOrElse`.
 */
export function safeParseYaml(text: string): Result.Result<unknown, Error> {
  return Result.try({
    try: () => yaml.parse(text) as unknown,
    catch: ensureError,
  });
}
