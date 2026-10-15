import { z } from 'zod';

/** The four canonical `*Files` list fields, defaulting to `[]` when absent. */
const fileListFields = {
  inputFiles: z.array(z.string()).prefault([]),
  contextFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
};

/** Used by AgentConfig where `editedFile` may be null. */
export const NullableFileFieldsSchema = z.object({
  ...fileListFields,
  editedFile: z.string().nullable().prefault(null),
});
