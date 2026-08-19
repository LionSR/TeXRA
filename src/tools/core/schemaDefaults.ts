// Third-party imports
import type { z } from 'zod';

/**
 * A tool input field that accepts both `undefined` and `null` (required for
 * OpenAI-compatible structured output, which needs optional fields to also
 * be nullable) but resolves to a concrete default when either is given.
 * `.default()` alone does not cover this: it only substitutes for
 * `undefined`, never for an explicit `null`.
 */
export function withDefault<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: z.output<Schema>,
) {
  return schema.nullish().transform((v) => v ?? value);
}
