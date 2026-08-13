/**
 * Shared factory functions for constructing message schemas.
 *
 * These helpers reduce boilerplate when defining inbound (frontend → backend)
 * message schemas across views. Each factory produces a Zod object schema
 * with a `command` literal discriminator plus optional payload fields.
 */
import { z } from 'zod';

/** Schema with only a `command` literal (no payload). */
export function commandOnly<T extends string>(command: T) {
  return z.object({ command: z.literal(command) });
}

/** Schema with `command` + required `files` string array. */
export function withFilesArray<T extends string>(command: T) {
  return z.object({ command: z.literal(command), files: z.array(z.string()) });
}
