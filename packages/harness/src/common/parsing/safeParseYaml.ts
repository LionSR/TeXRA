import { Result } from 'effect';
import * as yaml from 'yaml';
import { type ZodType } from 'zod';

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

/**
 * Parse YAML text and validate the result against a Zod schema, without
 * throwing. A parse failure or a schema mismatch both yield a
 * `Result.Failure<Error>`; on success the `Result.Success` value is the
 * validated, typed result.
 *
 * Prefer this over `yaml.parse(text) as T` / `Schema.parse(yaml.parse(text))`
 * whenever the text comes from an untrusted source (disk, network, remote
 * config): the cast lies if the bytes don't match `T`, whereas this surfaces
 * the mismatch as an error with a uniform shape across call sites.
 */
export function parseYamlWith<T>(
  text: string,
  schema: ZodType<T>,
): Result.Result<T, Error> {
  return Result.flatMap(safeParseYaml(text), (value) => {
    const result = schema.safeParse(value);
    return result.success
      ? Result.succeed(result.data)
      : Result.fail(result.error);
  });
}
