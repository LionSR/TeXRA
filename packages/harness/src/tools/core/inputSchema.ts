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
): Schema.decodeTo<Schema.toType<S>, Schema.optional<Schema.NullOr<S>>> {
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

/**
 * An optional, nullable tool-input field with no default. The decoded value
 * stays nullish: it is `undefined` when the field is absent and `null` when the
 * model sends an explicit `null`, so `execute` coalesces it with `?? fallback`
 * (which covers both) or tests `== null`.
 *
 * Like {@link nullishWithDefault}, the encoded side is
 * `Schema.optional(Schema.NullOr(schema))`, not `Schema.optional(schema)`:
 * OpenAI-compatible providers (DeepSeek, Kimi, …) send an omitted optional
 * field as an explicit `null` in structured output, so the field must be
 * nullable as well as optional, and plain `Schema.optional(schema)` would fail
 * to decode that `null`. Unlike `nullishWithDefault`, this applies no decoding
 * transformation, so a `null` is kept rather than replaced by a fallback.
 * Naming the shape keeps every tool-input field that takes no default on the
 * one rule. `description` is written on the encoded side, which is where the
 * model's JSON Schema is generated from.
 */
export function optionalInput<S extends Schema.Top>(
  schema: S,
  description: string,
): Schema.optional<Schema.NullOr<S>> {
  return Schema.optional(Schema.NullOr(schema)).annotate({ description });
}

/**
 * A tool call's optional time limit in milliseconds, from one second to a
 * day. Each tool annotates it with what the limit stops.
 */
export const timeoutMsField = Schema.optional(
  Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)).check(
      Schema.isLessThanOrEqualTo(24 * 60 * 60 * 1000),
    ),
  ),
);
