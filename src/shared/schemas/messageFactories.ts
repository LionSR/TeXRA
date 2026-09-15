/** Shared helpers for inbound (frontend → backend) message schemas. */
import { z } from 'zod';

/** Schema with only a `command` literal (no payload). */
export function commandOnly<T extends string>(command: T) {
  return z.object({ command: z.literal(command) });
}
