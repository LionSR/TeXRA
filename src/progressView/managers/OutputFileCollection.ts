/**
 * Per-run output file data: files + missing outputs, co-located.
 *
 * Plain data type replacing the raw inner Map<number, OutputFileInfo[]>
 * plus the separate missing-outputs Map. Standalone functions handle
 * serialization, deserialization, and path extraction.
 */
import { z } from 'zod';

import {
  OutputFileInfoSchema,
  OutputFileInfoListSchema,
  type OutputFileInfo,
} from '@shared/schemas';
import { RoundKeySchema } from '@progressView/persistence/schemaUtils';

// =============================================================================
// Type
// =============================================================================

export interface OutputFileCollection {
  files: Map<number, OutputFileInfo[]>;
  missing: Map<number, string[]>;
}

export function createCollection(): OutputFileCollection {
  return { files: new Map(), missing: new Map() };
}

export function isCollectionEmpty(c: OutputFileCollection): boolean {
  return c.files.size === 0 && c.missing.size === 0;
}

// =============================================================================
// Mutations (operate directly on the maps)
// =============================================================================

/** Add or replace output files for specific rounds. */
export function addFiles(
  c: OutputFileCollection,
  filesByRound: { [key: number]: OutputFileInfo[] },
): void {
  for (const [round, files] of Object.entries(filesByRound)) {
    const roundResult = RoundKeySchema.safeParse(round);
    if (!roundResult.success) continue;

    const normalized = OutputFileInfoListSchema.parse(
      Array.isArray(files) ? files : [],
    );

    if (normalized.length === 0) {
      c.files.delete(roundResult.data);
    } else {
      c.files.set(roundResult.data, normalized);
    }
  }
}

/** Set missing output paths for specific rounds. */
export function setMissing(
  c: OutputFileCollection,
  filesByRound: { [key: number]: string[] },
): void {
  for (const [round, files] of Object.entries(filesByRound)) {
    const roundResult = RoundKeySchema.safeParse(round);
    if (!roundResult.success) continue;
    c.missing.set(roundResult.data, files);
  }
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Collect all known file paths from output file info records.
 * Extracts paths from location and lineage (original, diffBase, diffFile).
 */
export function getKnownPaths(
  c: OutputFileCollection,
  workspaceOnly = false,
): Set<string> {
  const paths = new Set<string>();
  for (const infos of c.files.values()) {
    for (const info of infos) {
      const locations = [
        info.location,
        info.lineage?.original,
        info.lineage?.diffBase,
        info.lineage?.diffFile,
      ];
      for (const loc of locations) {
        if (loc?.absolutePath && (!workspaceOnly || loc.kind === 'workspace')) {
          paths.add(loc.absolutePath);
        }
      }
    }
  }
  return paths;
}

// =============================================================================
// Serialization
// =============================================================================

/** Canonical serialized format. */
export interface SerializedCollection {
  files: Record<string, unknown[]>;
  missing: Record<string, string[]>;
}

export function serializeCollection(c: OutputFileCollection): SerializedCollection {
  const files: Record<string, unknown[]> = {};
  for (const [round, infos] of c.files) {
    files[String(round)] = infos;
  }
  const missing: Record<string, string[]> = {};
  for (const [round, paths] of c.missing) {
    missing[String(round)] = paths;
  }
  return { files, missing };
}

// =============================================================================
// Deserialization (backward-compatible)
// =============================================================================

/** New canonical format: files + missing co-located. */
const SerializedCollectionSchema = z.strictObject({
  files: z.record(z.string(), z.array(z.unknown()).catch([])),
  missing: z.record(z.string(), z.array(z.string()).catch([])).prefault(() => ({})),
});

/** Legacy format: just round→files records (no missing data wrapper). */
const LegacyRoundRecordSchema = z.record(z.string(), z.array(z.unknown()).catch([]));

/**
 * Deserialize from persistence. Handles both:
 * - New format: `{ files: {...}, missing: {...} }`
 * - Legacy format: `{ "0": [...files], "1": [...files] }` (round→files only)
 */
export function deserializeCollection(data: unknown): OutputFileCollection {
  // Try new format first (per CLAUDE.md: new format first in union)
  const newResult = SerializedCollectionSchema.safeParse(data);
  if (newResult.success) {
    return parseRecords(newResult.data.files, newResult.data.missing);
  }

  // Fall back to legacy format (round→files records)
  const legacyResult = LegacyRoundRecordSchema.safeParse(data);
  if (legacyResult.success) {
    return parseRecords(legacyResult.data, {});
  }

  return createCollection();
}

function parseRecords(
  filesRecord: Record<string, unknown[]>,
  missingRecord: Record<string, string[]>,
): OutputFileCollection {
  const files = new Map<number, OutputFileInfo[]>();
  for (const [key, items] of Object.entries(filesRecord)) {
    const round = RoundKeySchema.safeParse(key);
    if (!round.success) continue;

    const parsed = items
      .map((item) => OutputFileInfoSchema.safeParse(item))
      .filter(
        (result): result is { success: true; data: OutputFileInfo } =>
          result.success,
      )
      .map((result) => result.data);

    if (parsed.length > 0) {
      files.set(round.data, parsed);
    }
  }

  const missing = new Map<number, string[]>();
  for (const [key, paths] of Object.entries(missingRecord)) {
    const round = RoundKeySchema.safeParse(key);
    if (!round.success || paths.length === 0) continue;
    missing.set(round.data, paths);
  }

  return { files, missing };
}
