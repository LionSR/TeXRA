/**
 * Diff result schemas for latexdiff operations.
 *
 * Uses Zod union with transform for backward-compatible parsing:
 * - New format (DiffResultSchema) passes through as-is
 * - Legacy format transforms into DiffResult structure
 */
import { z } from 'zod';
import { FileLocationSchema } from '@utils/files';
import { OutputFileInfoSchema, FileLineageSchema } from './types';

// =============================================================================
// Shared
// =============================================================================

const DiffStatusSchema = z.enum(['success', 'error']);

// =============================================================================
// New Format (source of truth)
// =============================================================================

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

// =============================================================================
// Legacy Format (backward compat)
// =============================================================================

const LegacyLocationsSchema = z.object({
  base: FileLocationSchema.nullable(),
  revised: FileLocationSchema.nullable(),
  diff: FileLocationSchema.nullable(),
});

export const LegacyDiffEntrySchema = z.object({
  originalFileName: z.string().optional(),
  baseLabel: z.string(),
  revisedLabel: z.string().optional(),
  status: DiffStatusSchema,
  message: z.string().optional(),
  locations: LegacyLocationsSchema,
  basePath: z.string().optional(),
  revisedPath: z.string().optional(),
  diffPath: z.string().optional(),
  runId: z.string().optional(),
});

export type LegacyDiffEntry = z.infer<typeof LegacyDiffEntrySchema>;

// =============================================================================
// Union Schema (single entry point)
// =============================================================================

/** Parses either format, transforms legacy to DiffResult */
export const DiffEntrySchema = z.union([
  // New format - pass through
  DiffResultSchema,

  // Legacy format - transform to DiffResult
  // Note: locations.base IS the original file - use it directly, no fake FileLocation from strings
  LegacyDiffEntrySchema.transform((e): DiffResult => {
    const base = e.locations.base;
    const revised = e.locations.revised;
    return {
      baseLocation: base,
      baseRound: null,
      revised: {
        source: '',
        round: 0,
        location: revised ?? { kind: 'external', absolutePath: '' },
        lineage: {
          original: base, // base IS the original file location
          diffBase: base,
          diffFile: e.locations.diff,
        },
        diff: null,
      },
      diffLocation: e.locations.diff,
      status: e.status,
      message: e.message,
      runId: e.runId,
    };
  }),
]);

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse and normalize a diff entry from either format.
 * Returns null if parsing fails.
 */
export function parseDiffEntry(raw: unknown): DiffResult | null {
  const result = DiffEntrySchema.safeParse(raw);
  return result.success ? result.data : null;
}
