/** Shared helpers for inbound (frontend → backend) message schemas. */
import { Schema } from 'effect';

/** Schema with only a `command` literal (no payload). */
export function commandOnly<T extends string>(command: T) {
  return Schema.Struct({ command: Schema.Literal(command) });
}
