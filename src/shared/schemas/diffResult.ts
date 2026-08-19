import { z } from 'zod';

import { getBasename } from '@utils/core';
import {
  type FileLocation,
  FileLocationSchema,
  fileLocationShortDisplayPath,
  type OutputFileInfo,
  OutputFileInfoSchema,
} from './output';
import { RoundNumberSchema } from './roundIndexed';

const DiffStatusSchema = z.enum(['success', 'error']);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

/** Shared metadata fields for diff results */
const DiffMetadataSchema = z.object({
  status: DiffStatusSchema,
  message: z.string().optional(),
  runId: z.string().optional(),
});

/**
 * Canonical DiffResult format from backend. `baseRound` is a round POINTER
 * (which round the base file came from — null when the base isn't
 * round-scoped, e.g. an original pre-round source), not a round-indexed
 * collection: it shares {@link RoundNumberSchema} with the round-indexed
 * item fields but deliberately does not join the {@link RoundIndexed}
 * container shape. `revisedRound` (see {@link DiffResultDisplaySchema}) is
 * derived from `revised.round` rather than duplicated here.
 */
const DiffResultSchema = DiffMetadataSchema.extend({
  baseLocation: FileLocationSchema.nullable(),
  baseRound: RoundNumberSchema.nullable(),
  revised: OutputFileInfoSchema,
  diffLocation: FileLocationSchema.nullable(),
});

export type DiffResult = z.infer<typeof DiffResultSchema>;

const DiffResultDisplayShapeSchema = DiffMetadataSchema.extend({
  baseFile: z.string(),
  revisedFile: z.string(),
  diffFile: z.string(),
  displayName: z.string(),
  baseRound: RoundNumberSchema.nullable(),
  revisedRound: RoundNumberSchema,
});

export type DiffResultDisplay = z.infer<typeof DiffResultDisplayShapeSchema>;

function diffResultToDisplay(entry: DiffResult): DiffResultDisplay {
  return DiffResultDisplayShapeSchema.parse({
    baseFile: getAbsolutePath(entry.baseLocation),
    revisedFile: getAbsolutePath(entry.revised.location),
    diffFile: getAbsolutePath(entry.diffLocation),
    displayName: getDisplayName(entry.revised, entry.baseLocation),
    baseRound: entry.baseRound,
    revisedRound: entry.revised.round,
    status: entry.status,
    message: entry.message,
    runId: entry.runId,
  });
}

/**
 * Transform canonical latexdiff entries into flattened display entries for the
 * progress view. Use {@link DiffResultDisplay} for the output shape.
 */
export const DiffResultDisplaySchema =
  DiffResultSchema.transform(diffResultToDisplay);

function getAbsolutePath(location: FileLocation | null): string {
  return location?.absolutePath ?? '';
}

function getDisplayName(
  revised: OutputFileInfo,
  baseLocation: FileLocation | null,
): string {
  // Prefer the original file's own name, from lineage.
  const original = revised.lineage?.original;
  if (original) {
    const basename = getBasename(fileLocationShortDisplayPath(original));
    if (basename) return basename;
  }

  // Fall back to how the base location reads.
  if (baseLocation) {
    const basePath = fileLocationShortDisplayPath(baseLocation);
    if (basePath) return basePath;
  }

  return 'unknown';
}

/** Parse an array of diff result entries, skipping invalid ones */
export function parseDiffResultEntries(data: unknown): DiffResultDisplay[] {
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry) => {
    const parsed = DiffResultDisplaySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
