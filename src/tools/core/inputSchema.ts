/**
 * Field spellings shared by tool input schemas.
 */

// Third-party imports
import type { z } from 'zod';

/**
 * An optional tool-input field whose absence resolves to `fallback` before
 * `execute` ever sees it.
 *
 * The wrapping is `.nullish()`, deliberately not `.optional()` and not
 * `.prefault()`. OpenAI-compatible providers (DeepSeek, Kimi, …) represent an
 * omitted optional field as an explicit `null` in structured output, so the
 * field must be nullable as well as optional; `.prefault()` substitutes only
 * for `undefined` and would hand `null` straight through. The `?? fallback`
 * covers both, which is why the resulting field's output type is not nullable
 * and use sites need no `== null` check of their own.
 */
export function nullishWithDefault<Schema extends z.ZodType>(
  schema: Schema,
  fallback: z.output<Schema>,
) {
  return schema.nullish().transform((value) => value ?? fallback);
}
