import { z } from 'zod';

import { getBasename } from '@utils/core';
import {
  type FileLocation,
  FileLocationSchema,
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

/**
 * Legacy round-label parse arm: pre-#3061 persisted latexdiff log entries
 * (see `LegacyDiffResultInputBaseSchema` below) predate the explicit
 * `baseRound`/`revisedRound` fields and only carry the round baked into a
 * display label (e.g. `"main.tex [r2]"`). Kept as the one read arm for that
 * shape; tracked for D3 retirement 2026-08-04 alongside the other #3061-era
 * shims in the #6981 ledger.
 */
function parseRoundFromLabel(label: string | undefined): number | null {
  if (typeof label !== 'string') return null;
  const match = label.match(/\[r(\d+)\]/);
  return match ? Number.parseInt(match[1], 10) : null;
}

const LegacyDiffResultInputBaseSchema = z.looseObject({
  locations: LegacyLocationsSchema,
  basePath: z.string().optional(),
  revisedPath: z.string().optional(),
  diffPath: z.string().optional(),
  baseLabel: z.string().optional(),
  revisedLabel: z.string().optional(),
  baseRound: RoundNumberSchema.optional(),
  revisedRound: RoundNumberSchema.optional(),
  originalFileName: z.string().optional(),
  status: z.string().optional(),
  message: z.string().optional(),
  runId: z.string().optional(),
});

type LegacyDiffResultInput = z.infer<typeof LegacyDiffResultInputBaseSchema>;

function hasLegacyDiffIdentity(entry: LegacyDiffResultInput): boolean {
  return Boolean(
    entry.locations?.base?.absolutePath ||
    entry.locations?.revised?.absolutePath ||
    entry.locations?.diff?.absolutePath ||
    entry.basePath ||
    entry.revisedPath ||
    entry.diffPath ||
    entry.baseLabel ||
    entry.originalFileName,
  );
}

const LegacyDiffResultInputSchema = LegacyDiffResultInputBaseSchema.refine(
  hasLegacyDiffIdentity,
);

function externalLocation(absolutePath: string): FileLocation {
  return { kind: 'external', absolutePath };
}

function nullableExternalLocation(
  absolutePath: string | undefined,
): FileLocation | null {
  return absolutePath ? externalLocation(absolutePath) : null;
}

function legacyDisplayName(entry: LegacyDiffResultInput): string {
  if (entry.originalFileName) return entry.originalFileName;
  if (entry.baseLabel) return entry.baseLabel.replace(/\s*\[r\d+\]/, '');
  return '';
}

function legacyPath(
  location: { absolutePath?: string } | undefined,
  fallback: string | undefined,
): string {
  return location?.absolutePath ?? fallback ?? '';
}

function legacyDiffResultToCanonical(entry: LegacyDiffResultInput): DiffResult {
  const baseFile = legacyPath(entry.locations?.base, entry.basePath);
  const revisedFile = legacyPath(entry.locations?.revised, entry.revisedPath);
  const diffFile = legacyPath(entry.locations?.diff, entry.diffPath);
  const baseRound =
    entry.baseRound ?? parseRoundFromLabel(entry.baseLabel) ?? null;
  const revisedRound =
    entry.revisedRound ?? parseRoundFromLabel(entry.revisedLabel) ?? 0;
  const originalDisplayName = legacyDisplayName(entry);

  return DiffResultSchema.parse({
    baseLocation: nullableExternalLocation(baseFile),
    baseRound,
    revised: {
      source: revisedFile,
      location: externalLocation(revisedFile),
      round: revisedRound,
      lineage: {
        original: nullableExternalLocation(originalDisplayName),
        diffBase: nullableExternalLocation(baseFile),
        diffFile: nullableExternalLocation(diffFile),
      },
      diff: null,
    },
    diffLocation: nullableExternalLocation(diffFile),
    status:
      entry.status === 'success' || entry.status === 'error'
        ? entry.status
        : 'error',
    message: entry.message,
    runId: entry.runId,
  });
}

const LegacyDiffResultDisplaySchema = LegacyDiffResultInputSchema.transform(
  (entry): DiffResultDisplay => {
    const display = diffResultToDisplay(legacyDiffResultToCanonical(entry));
    const displayName = legacyDisplayName(entry);
    return displayName ? { ...display, displayName } : display;
  },
);

const DiffResultEntrySchema = z.union([
  DiffResultDisplaySchema,
  LegacyDiffResultDisplaySchema,
]);

/** Parse a diff result entry from either new or legacy format, or null if neither matches. */
function parseDiffResultEntry(data: unknown): DiffResultDisplay | null {
  return DiffResultEntrySchema.nullable().catch(null).parse(data);
}

/** Parse an array of diff result entries, skipping invalid ones */
export function parseDiffResultEntries(data: unknown): DiffResultDisplay[] {
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry) => {
    const parsed = parseDiffResultEntry(entry);
    return parsed ? [parsed] : [];
  });
}
