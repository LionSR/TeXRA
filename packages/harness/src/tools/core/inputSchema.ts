/**
 * Shapes and field spellings shared by tool input schemas.
 */

// Third-party imports
import { Option, Schema, SchemaGetter } from 'effect';

/**
 * An optional tool-input field whose absence resolves to `fallback` before
 * `execute` ever sees it.
 *
 * The encoded side is `Schema.optional(Schema.NullOr(schema))`, deliberately
 * not `Schema.optional(schema)` with a decoding default. OpenAI-compatible
 * providers (DeepSeek, Kimi, …) represent an omitted optional field as an
 * explicit `null` in structured output, so the field must be nullable as well
 * as optional; `withDecodingDefault` substitutes only for an absent or
 * `undefined` field and would hand `null` straight through. The `?? fallback`
 * covers absent, `undefined` and `null` alike, which is why the decoded field
 * is required and not nullable, and use sites need no `== null` check of
 * their own.
 *
 * `description` is written on the encoded side: that is the side the model's
 * JSON Schema is generated from, and an annotation on the decoded side of a
 * transformation never reaches it.
 */
export function nullishWithDefault<S extends Schema.Top>(
  schema: S,
  fallback: S['Type'],
  description: string,
) {
  return Schema.optional(Schema.NullOr(schema))
    .annotate({ description })
    .pipe(
      Schema.decodeTo(Schema.toType(schema), {
        decode: SchemaGetter.transformOptional((value) =>
          Option.some(Option.getOrUndefined(value) ?? fallback),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    );
}
