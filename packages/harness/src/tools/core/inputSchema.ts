/**
 * Shapes and field spellings shared by tool input schemas.
 */

// Third-party imports
import { Schema, SchemaGetter } from 'effect';

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
export function nullishWithDefault<Schema extends Schema.Top>(
  schema: Schema,
  fallback: Schema['Type'],
): Schema.Codec<Schema['Type'], Schema['Encoded'] | null | undefined> {
  return Schema.optional(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(
      Schema.Unknown /* TODO(effect-schema): transform target schema; was `.transform((value) => value ?? fallback)` */,
      {
        decode: SchemaGetter.transform((value) => value ?? fallback),
        encode: SchemaGetter.forbidden(() => 'decode-only'),
      },
    ),
  );
}
