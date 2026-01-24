/**
 * Diff result schema for latexdiff operations.
 */
import { z } from 'zod';
import { FileLocationSchema, OutputFileInfoSchema } from '@shared/schemas';

const DiffStatusSchema = z.enum(['success', 'error']);

export const DiffResultSchema = z.object({
  baseLocation: FileLocationSchema.nullable(),
  baseRound: z.number().nullable(),
  revised: OutputFileInfoSchema,
  diffLocation: FileLocationSchema.nullable(),
  status: DiffStatusSchema,
  message: z.string().optional(),
  runId: z.string().optional(),
});

export type DiffResult = z.infer<typeof DiffResultSchema>;
