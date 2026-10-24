import { Schema } from 'effect';

/**
 * Any JSON-serializable value. Shared home for `z.json()` so structured tool
 * output, script results, and agent run results validate the
 * same contract instead of re-declaring it per module.
 */
export const JsonValueSchema = Schema.Json;
export type JsonValue = typeof JsonValueSchema.Type;

/** A value as a stored row keeps it: what `JSON.stringify` writes, read
 *  back. The boundary where an arbitrary value enters a persisted field. */
export const toJsonValue = (value: unknown): JsonValue =>
  Schema.decodeUnknownSync(JsonValueSchema)(
    JSON.parse(JSON.stringify(value) ?? 'null'),
  );
