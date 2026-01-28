import { z } from 'zod';

import { FileLocationSchema, OutputFileInfoSchema } from './output';
import { getBasename } from '../utils/path';

export const DiffStatusSchema = z.enum(['success', 'error']);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

/** Shared metadata fields for diff results */
const DiffMetadataSchema = z.object({
  status: DiffStatusSchema,
  message: z.string().optional(),
  runId: z.string().optional(),
});

/** Canonical DiffResult format from backend */
export const DiffResultSchema = DiffMetadataSchema.extend({
  baseLocation: FileLocationSchema.nullable(),
  baseRound: z.number().nullable(),
  revised: OutputFileInfoSchema,
  diffLocation: FileLocationSchema.nullable(),
});

export type DiffResult = z.infer<typeof DiffResultSchema>;

/** Flattened display data for rendering latexdiff entries */
export const DiffResultDisplaySchema = DiffMetadataSchema.extend({
  baseFile: z.string(),
  revisedFile: z.string(),
  diffFile: z.string(),
  displayName: z.string(),
  baseRound: z.number().nullable(),
  revisedRound: z.number(),
});

export type DiffResultDisplay = z.infer<typeof DiffResultDisplaySchema>;

function getAbsolutePath(
  location: z.infer<typeof FileLocationSchema> | null,
): string {
  return location?.absolutePath ?? '';
}

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

const LegacyLocationSchema = z.looseObject({
  absolutePath: z.string().optional(),
});

/** Legacy locations container */
const LegacyLocationsSchema = z
  .object({
    base: LegacyLocationSchema.optional(),
    revised: LegacyLocationSchema.optional(),
    diff: LegacyLocationSchema.optional(),
  })
  .optional();

function parseRoundFromLabel(label: string | undefined): number | null {
  if (typeof label !== 'string') return null;
  const match = label.match(/\[r(\d+)\]/);
  return match ? parseInt(match[1], 10) : null;
}

/** Legacy DiffResult format - transforms to DiffResultDisplay on parse */
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

/** Parse a diff result entry from either new or legacy format */
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

/** Parse an array of diff result entries, skipping invalid ones */
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
