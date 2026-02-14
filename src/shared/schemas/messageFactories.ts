/**
 * Shared factory functions for constructing message schemas.
 *
 * These helpers reduce boilerplate when defining inbound (frontend → backend)
 * message schemas across views. Each factory produces a Zod object schema
 * with a `command` literal discriminator plus optional payload fields.
 */
import { z } from 'zod';

/** Schema with only a `command` literal (no payload). */
export const commandOnly = <T extends string>(command: T) =>
  z.object({ command: z.literal(command) });

/** Schema with `command` + optional `filePath`. */
export const withOptionalFilePath = <T extends string>(command: T) =>
  z.object({ command: z.literal(command), filePath: z.string().optional() });

/** Schema with `command` + required `files` string array. */
export const withFilesArray = <T extends string>(command: T) =>
  z.object({ command: z.literal(command), files: z.array(z.string()) });

/** Schema with `command` + optional `notifyWhenEmpty` boolean. */
export const withNotifyWhenEmpty = <T extends string>(command: T) =>
  z.object({
    command: z.literal(command),
    notifyWhenEmpty: z.boolean().nullish(),
  });
