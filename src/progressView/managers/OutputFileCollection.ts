/**
 * Domain type for per-run output files.
 *
 * Owns both output files and missing outputs for a single run (StorageKey scope).
 * Replaces the raw inner Map<number, OutputFileInfo[]> + separate missing outputs Map
 * with a cohesive value type that encapsulates serialization and domain logic.
 *
 * This is the first step toward an Execution Aggregate — the collection will eventually
 * be owned by an ExecutionAggregate and persisted via ExecutionKVStore rather than Memento.
 */
import { z } from 'zod';

import {
  OutputFileInfoSchema,
  OutputFileInfoListSchema,
  type OutputFileInfo,
} from '@shared/schemas';
import { RoundKeySchema } from '@progressView/persistence/schemaUtils';

// =============================================================================
// Serialized format
// =============================================================================

/** New canonical format: files + missing co-located. */
const SerializedCollectionSchema = z.strictObject({
  files: z.record(z.string(), z.array(z.unknown()).catch([])),
  missing: z.record(z.string(), z.array(z.string()).catch([])).prefault(() => ({})),
});

/** Legacy format: just round→files records (no missing data wrapper). */
const LegacyRoundRecordSchema = z.record(z.string(), z.array(z.unknown()).catch([]));

// =============================================================================
// Collection class
// =============================================================================

export class OutputFileCollection {
  private _files: Map<number, OutputFileInfo[]>;
  private _missing: Map<number, string[]>;

  constructor(
    files?: Map<number, OutputFileInfo[]>,
    missing?: Map<number, string[]>,
  ) {
    this._files = files ?? new Map();
    this._missing = missing ?? new Map();
  }

  /** Add or replace output files for specific rounds. */
  addFiles(filesByRound: { [key: number]: OutputFileInfo[] }): void {
    for (const [round, files] of Object.entries(filesByRound)) {
      const roundResult = RoundKeySchema.safeParse(round);
      if (!roundResult.success) continue;

      const normalizedFiles = OutputFileInfoListSchema.parse(
        Array.isArray(files) ? files : [],
      );

      if (normalizedFiles.length === 0) {
        this._files.delete(roundResult.data);
      } else {
        this._files.set(roundResult.data, normalizedFiles);
      }
    }
  }

  /** Set missing output paths for specific rounds. */
  setMissing(filesByRound: { [key: number]: string[] }): void {
    for (const [round, files] of Object.entries(filesByRound)) {
      const roundResult = RoundKeySchema.safeParse(round);
      if (!roundResult.success) continue;
      this._missing.set(roundResult.data, files);
    }
  }

  /** Clear all missing output data. */
  clearMissing(): void {
    this._missing.clear();
  }

  /** Get a copy of files by round. */
  getFiles(): Map<number, OutputFileInfo[]> {
    return new Map(this._files);
  }

  /** Get a copy of missing outputs by round. */
  getMissing(): Map<number, string[]> {
    return new Map(this._missing);
  }

  /** Whether this collection has no files and no missing outputs. */
  isEmpty(): boolean {
    return this._files.size === 0 && this._missing.size === 0;
  }

  /** Whether this collection has any missing output data. */
  hasMissing(): boolean {
    return this._missing.size > 0;
  }

  /**
   * Collect all known file paths from output file info records.
   * Extracts paths from location and lineage (original, diffBase, diffFile).
   */
  getKnownPaths(workspaceOnly = false): Set<string> {
    const paths = new Set<string>();
    for (const infos of this._files.values()) {
      for (const info of infos) {
        collectPaths(paths, info, workspaceOnly);
      }
    }
    return paths;
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /** Serialize to the canonical format for persistence. */
  toJSON(): { files: Record<string, unknown[]>; missing: Record<string, string[]> } {
    const files: Record<string, unknown[]> = {};
    for (const [round, infos] of this._files) {
      files[String(round)] = infos;
    }

    const missing: Record<string, string[]> = {};
    for (const [round, paths] of this._missing) {
      missing[String(round)] = paths;
    }

    return { files, missing };
  }

  /**
   * Deserialize from persistence. Handles both:
   * - New format: `{ files: {...}, missing: {...} }`
   * - Legacy format: `{ "0": [...files], "1": [...files] }` (round→files only)
   */
  static fromJSON(data: unknown): OutputFileCollection {
    // Try new format first (per CLAUDE.md: new format first in union)
    const newResult = SerializedCollectionSchema.safeParse(data);
    if (newResult.success) {
      return OutputFileCollection.fromParsedRecord(
        newResult.data.files,
        newResult.data.missing,
      );
    }

    // Fall back to legacy format (round→files records)
    const legacyResult = LegacyRoundRecordSchema.safeParse(data);
    if (legacyResult.success) {
      return OutputFileCollection.fromParsedRecord(legacyResult.data, {});
    }

    // Unrecognized format — return empty
    return new OutputFileCollection();
  }

  private static fromParsedRecord(
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

    return new OutputFileCollection(files, missing);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Extract file paths from an OutputFileInfo, including lineage. */
function collectPaths(
  target: Set<string>,
  info: OutputFileInfo,
  workspaceOnly: boolean,
): void {
  const locations = [
    info.location,
    info.lineage?.original,
    info.lineage?.diffBase,
    info.lineage?.diffFile,
  ];

  for (const loc of locations) {
    if (loc?.absolutePath && (!workspaceOnly || loc.kind === 'workspace')) {
      target.add(loc.absolutePath);
    }
  }
}
