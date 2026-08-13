import type { FileLocation } from '@shared/schemas';

/** File relationship facts for a single output path. All fields optional — absence means no match. */
export interface RoundFileEntry {
  /** Base FileLocation for round-based diffs (rewrite agents). */
  base?: FileLocation;
  /** Previous-round FileLocation for between-round diffs. */
  prev?: FileLocation;
  /** Original base FileLocation for lineage tracking. */
  origin?: FileLocation;
}

/** Maps output paths to their file relationship facts. Used by LatexDiffManager and diffComputation. */
export type RoundFileMapping = Map<string, RoundFileEntry>;
