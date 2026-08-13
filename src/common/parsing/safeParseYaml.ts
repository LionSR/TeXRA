import { type ZodType } from 'zod';
import { type Result, ok, err } from 'neverthrow';
import * as yaml from 'yaml';

import { ensureError } from '@utils/errors/errorMessage';

/**
 * Parse YAML text without throwing.
 *
 * Returns an `Ok<unknown>` with the parsed value typed as `unknown` (the
 * honest type for untrusted text), or an `Err<Error>` carrying the parse
 * error raised by `yaml.parse`. Use this instead of a bare `yaml.parse(...)`
 * wrapped in try/catch. Branch with `result.isOk()` / `result.isErr()`, or
 * chain with `.map` / `.andThen` / `.match`.
 */
export function safeParseYaml(text: string): Result<unknown, Error> {
  try {
    return ok(yaml.parse(text) as unknown);
  } catch (error) {
    return err(ensureError(error));
  }
}

/**
 * Parse YAML text and validate the result against a Zod schema, without
 * throwing. A parse failure or a schema mismatch both yield an `Err<Error>`;
 * on success the `Ok` value is the validated, typed result.
 *
 * Prefer this over `yaml.parse(text) as T` / `Schema.parse(yaml.parse(text))`
 * whenever the text comes from an untrusted source (disk, network, remote
 * config): the cast lies if the bytes don't match `T`, whereas this surfaces
 * the mismatch as an error with a uniform shape across call sites.
 */
export function parseYamlWith<T>(
  text: string,
  schema: ZodType<T>,
): Result<T, Error> {
  return safeParseYaml(text).andThen((value) => {
    const result = schema.safeParse(value);
    return result.success ? ok(result.data) : err(result.error);
  });
}
