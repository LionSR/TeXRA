/**
 * Output file schemas. Types derived from schemas for single source of truth.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import {
  FileLocationSchema,
  OutputFileInfoSchema,
  type FileLocation,
} from '@shared/schemas';

/** XML summary schema with defaults via prefault */
export const OutputXmlSummarySchema = z.strictObject({
  tagContents: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .prefault(() => ({})),
  documents: z.array(z.string()).prefault(() => []),
  singleOutputFile: z.string().nullable().prefault(null),
  sourceLocation: FileLocationSchema.nullable().prefault(null),
});
export type OutputXmlSummary = z.infer<typeof OutputXmlSummarySchema>;

/** Output from processing a conversation round */
export const RoundOutputSchema = z.strictObject({
  round: z.number(),
  rawOutput: FileLocationSchema.nullable(),
  outputs: OutputFileInfoSchema.array(),
  xmlSummary: OutputXmlSummarySchema,
});
export type RoundOutput = z.infer<typeof RoundOutputSchema>;

/**
 * Internal mapping for file relationships (used by OutputHandler).
 * All maps are indexed by OUTPUT path for efficient lineage lookup.
 */
export interface RoundFileMapping {
  /** Output path → base FileLocation (for round-based diffs) */
  baseToOutput: Map<string, FileLocation>;
  /** Output path → previous round FileLocation (for inter-round diffs) */
  prevToOutput: Map<string, FileLocation>;
  /** Output path → original base FileLocation (for tracking lineage) */
  originByOutput: Map<string, FileLocation | undefined>;
}

export type { FileLineage, OutputFile, OutputFileInfo } from '@shared/schemas';
