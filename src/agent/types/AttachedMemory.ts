import { z } from 'zod';

export const AttachedMemoryMissSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export type AttachedMemoryMiss = z.infer<typeof AttachedMemoryMissSchema>;

/** Tolerant: malformed or missing input parses to an empty list. */
export const AttachedMemoryMissesSchema = z
  .array(AttachedMemoryMissSchema)
  .catch([]);
