import { z } from 'zod';

export const AttachedMemoryMissSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export type AttachedMemoryMiss = z.infer<typeof AttachedMemoryMissSchema>;

const AttachedMemoryMissesSchema = z.array(AttachedMemoryMissSchema);

export function readAttachedMemoryMisses(value: unknown): AttachedMemoryMiss[] {
  return AttachedMemoryMissesSchema.catch([]).parse(value);
}
