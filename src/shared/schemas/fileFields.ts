import { z } from 'zod';

/** The four canonical `*Files` list fields, defaulting to `[]` when absent. */
export const fileListFields = {
  inputFiles: z.array(z.string()).prefault([]),
  contextFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
};

/** The same four `*Files` list fields, required (no default). */
export const requiredFileListFields = {
  inputFiles: z.array(z.string()),
  contextFiles: z.array(z.string()),
  mediaFiles: z.array(z.string()),
  outputFiles: z.array(z.string()),
};

/** Used by AgentConfig where `editedFile` may be null. */
export const NullableFileFieldsSchema = z.object({
  ...fileListFields,
  editedFile: z.string().nullable().prefault(null),
});

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
  ...fileListFields,
  editedFile: nullishString,
});
