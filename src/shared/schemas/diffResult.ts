/**
 * Diff result schemas for latexdiff operations.
 *
 * Supports both new format (DiffResult from backend) and legacy format
 * with automatic transformation to a canonical display structure.
 *
 * Following CLAUDE.md: "Handle legacy at entry point using safeParse,
 * not scattered fallbacks in consumers."
 */
import { z } from 'zod';
import { FileLocationSchema, OutputFileInfoSchema } from './output';
import { getBasename } from '../utils/path';

// ============================================================================
// Status Schema
// ============================================================================

export const DiffStatusSchema = z.enum(['success', 'error']);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

// ============================================================================
// New Format (canonical)
// ============================================================================

/**
 * New DiffResult format from backend.
 * This is the canonical format that legacy data transforms into.
 */
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

// ============================================================================
// Display Data (what formatters need)
// ============================================================================

/**
 * Flattened display data for rendering latexdiff entries.
 * Both new and legacy formats transform to this structure.
 */
export const DiffResultDisplaySchema = z.object({
  baseFile: z.string(),
  revisedFile: z.string(),
  diffFile: z.string(),
  displayName: z.string(),
  baseRound: z.number().nullable(),
  revisedRound: z.number(),
  status: DiffStatusSchema,
  message: z.string().optional(),
  runId: z.string().optional(),
});

export type DiffResultDisplay = z.infer<typeof DiffResultDisplaySchema>;

// ============================================================================
// Extraction Helpers
// ============================================================================

/** Extract absolutePath from a FileLocation or return empty string */
function getAbsolutePath(
  location: z.infer<typeof FileLocationSchema> | null,
): string {
  return location?.absolutePath ?? '';
}

/** Extract display name from output file info */
function getDisplayName(
  revised: z.infer<typeof OutputFileInfoSchema>,
  baseLocation: z.infer<typeof FileLocationSchema> | null,
): string {
  // Prefer original path from lineage
  const original = revised.lineage?.original;
  if (original) {
    const path =
      ('relativePath' in original ? original.relativePath : null) ||
      original.absolutePath;
    const basename = getBasename(path);
    if (basename) return basename;
  }

  // Fall back to base location
  if (baseLocation) {
    if ('relativePath' in baseLocation && baseLocation.relativePath) {
      return baseLocation.relativePath;
    }
    const basename = getBasename(baseLocation.absolutePath);
    if (basename) return basename;
  }

  return 'unknown';
}

// ============================================================================
// Transform: New Format -> Display
// ============================================================================

/**
 * Transform new DiffResult to display format.
 */
export function transformDiffResultToDisplay(
  entry: DiffResult,
): DiffResultDisplay {
  return {
    baseFile: getAbsolutePath(entry.baseLocation),
    revisedFile: getAbsolutePath(entry.revised.location),
    diffFile: getAbsolutePath(entry.diffLocation),
    displayName: getDisplayName(entry.revised, entry.baseLocation),
    baseRound: entry.baseRound,
    revisedRound: entry.revised.round,
    status: entry.status,
    message: entry.message,
    runId: entry.runId,
  };
}

// ============================================================================
// Legacy Format Schema
// ============================================================================

/** Legacy location object with absolutePath */
const LegacyLocationSchema = z
  .object({
    absolutePath: z.string().optional(),
  })
  .passthrough();

/** Legacy locations container */
const LegacyLocationsSchema = z
  .object({
    base: LegacyLocationSchema.optional(),
    revised: LegacyLocationSchema.optional(),
    diff: LegacyLocationSchema.optional(),
  })
  .optional();

/** Extract round from label like "[r1]" or "file.tex [r2]" */
function parseRoundFromLabel(label: string | undefined): number | null {
  if (typeof label !== 'string') return null;
  const match = label.match(/\[r(\d+)\]/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Legacy DiffResult format (locations + labels).
 * Transforms to DiffResultDisplay on parse.
 */
export const LegacyDiffResultSchema = z
  .object({
    locations: LegacyLocationsSchema,
    basePath: z.string().optional(),
    revisedPath: z.string().optional(),
    diffPath: z.string().optional(),
    baseLabel: z.string().optional(),
    revisedLabel: z.string().optional(),
    baseRound: z.number().optional(),
    revisedRound: z.number().optional(),
    originalFileName: z.string().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
    runId: z.string().optional(),
  })
  .transform((entry): DiffResultDisplay => {
    // Extract file paths with fallbacks
    const baseFile =
      entry.locations?.base?.absolutePath ?? entry.basePath ?? '';
    const revisedFile =
      entry.locations?.revised?.absolutePath ?? entry.revisedPath ?? '';
    const diffFile =
      entry.locations?.diff?.absolutePath ?? entry.diffPath ?? '';

    // Extract rounds from fields or labels
    const baseRound =
      entry.baseRound ?? parseRoundFromLabel(entry.baseLabel) ?? null;
    const revisedRound =
      entry.revisedRound ?? parseRoundFromLabel(entry.revisedLabel) ?? 0;

    // Determine display name: originalFileName > stripped label > basename
    let displayName = entry.originalFileName ?? '';
    if (!displayName && entry.baseLabel) {
      displayName = entry.baseLabel.replace(/\s*\[r\d+\]/, '');
    }
    if (!displayName && baseFile) {
      displayName = getBasename(baseFile) || 'unknown';
    }
    if (!displayName) {
      displayName = 'unknown';
    }

    return {
      baseFile,
      revisedFile,
      diffFile,
      displayName,
      baseRound,
      revisedRound,
      status:
        entry.status === 'success' || entry.status === 'error'
          ? entry.status
          : 'error',
      message: entry.message,
      runId: entry.runId,
    };
  });

// ============================================================================
// Entry Point: Parse Any Format
// ============================================================================

/**
 * Parse a diff result entry from either new or legacy format.
 * Returns validated DiffResultDisplay ready for rendering.
 *
 * Usage:
 *   const result = parseDiffResultEntry(rawData);
 *   if (result.success) {
 *     // result.data is DiffResultDisplay
 *   }
 */
export function parseDiffResultEntry(
  data: unknown,
):
  | { success: true; data: DiffResultDisplay }
  | { success: false; error: string } {
  // Try new format first (canonical)
  const newResult = DiffResultSchema.safeParse(data);
  if (newResult.success) {
    return {
      success: true,
      data: transformDiffResultToDisplay(newResult.data),
    };
  }

  // Try legacy format (transforms to display)
  const legacyResult = LegacyDiffResultSchema.safeParse(data);
  if (legacyResult.success) {
    return { success: true, data: legacyResult.data };
  }

  return { success: false, error: 'Invalid diff result format' };
}

/**
 * Parse an array of diff result entries.
 * Returns array of validated display data, skipping invalid entries.
 */
export function parseDiffResultEntries(data: unknown): DiffResultDisplay[] {
  if (!Array.isArray(data)) return [];

  return data
    .map((entry) => parseDiffResultEntry(entry))
    .filter(
      (result): result is { success: true; data: DiffResultDisplay } =>
        result.success,
    )
    .map((result) => result.data);
}
