/**
 * Default a schema field to a plain constant when it decodes from an absent or
 * `undefined` value.
 *
 * Effect's {@link Schema.withDecodingDefault} takes the default as an
 * `Effect`, so every field that defaults to a constant has to spell
 * `Effect.succeed(value)` and import `Effect` for nothing else. Almost every
 * default is a constant, so these name that case: `decodingDefault(schema,
 * value)` reads as "absent decodes as `value`" and lifts the constant for the
 * caller. `value` is typed as the schema's encoded (or decoded) value, so a
 * default of the wrong shape is still a type error.
 *
 * The two variants mirror the two combinators and are **not** interchangeable
 * (root `AGENTS.md`, "Defaults are not interchangeable"):
 *
 * - {@link decodingDefault} gives the default on the **encoded** side, before
 *   the field's decoding transformation runs.
 * - {@link decodingDefaultType} gives it on the **decoded** (`Type`) side, so
 *   it skips the transformation.
 *
 * For a default that must run an effect (reads a clock, can fail), call
 * {@link Schema.withDecodingDefault} directly; nothing in the tree needs that
 * today. A tool-input field keeps `nullishWithDefault`
 * (`packages/harness/src/tools/core/inputSchema.ts`): an OpenAI-compatible
 * provider sends an omitted optional field as an explicit `null`, which a
 * decoding default passes straight through.
 */
import { Effect, Schema } from 'effect';

/** Default an absent/`undefined` field to the encoded constant `value`. */
export function decodingDefault<S extends Schema.Top>(
  schema: S,
  value: S['Encoded'],
): Schema.withDecodingDefault<S> {
  return schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));
}

/** Default an absent/`undefined` field to the decoded (`Type`) constant `value`. */
export function decodingDefaultType<S extends Schema.Top>(
  schema: S,
  value: S['Type'],
): Schema.withDecodingDefaultType<S> {
  return schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(value)));
}
