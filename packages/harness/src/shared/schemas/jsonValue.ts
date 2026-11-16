import { Schema } from 'effect';

/** A value as a stored row keeps it: what `JSON.stringify` writes, read
 *  back. The boundary where an arbitrary value enters a persisted field. */
export const toJsonValue = (value: unknown): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(JSON.stringify(value) ?? 'null'),
  );
