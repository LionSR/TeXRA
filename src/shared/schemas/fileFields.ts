/**
 * File field schemas - single source of truth for file-related config fields.
 *
 * Two variants:
 * - NullableFileFieldsSchema: For storage/config (allows null)
 * - UIFileFieldsSchema: For UI state (coerces null → '')
 */
import { z } from 'zod';

/**
 * File fields with nullable single-file fields.
 * Used by AgentConfig where null means "not set".
 */
export const NullableFileFieldsSchema = z.object({
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFile: z.string().nullable().prefault(null),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFile: z.string().nullable().prefault(null),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFile: z.string().nullable().prefault(null),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  editedFile: z.string().nullable().prefault(null),
});

export type NullableFileFields = z.infer<typeof NullableFileFieldsSchema>;

/** Schema that accepts string or null/undefined, outputs string (coerces nullish → ''). */
const nullishString = z
  .string()
  .nullish()
  .transform((v) => v ?? '');

/**
 * File fields for UI state where null is not valid.
 * Uses transform to coerce null/undefined → ''.
 */
export const UIFileFieldsSchema = z.object({
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFile: nullishString,
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFile: nullishString,
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFile: nullishString,
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  editedFile: nullishString,
});

export type UIFileFields = z.infer<typeof UIFileFieldsSchema>;
