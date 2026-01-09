/**
 * Output file schemas. Types derived from schemas for single source of truth.
 */
import { z } from 'zod';
import { DiffStatsSchema } from '@agent/types/DiffTypes';
import { FileLocationSchema, type FileLocation } from '@utils/files';

/** Minimal output file reference - source name + location */
export const OutputFileSchema = z.strictObject({
  source: z.string(),
  location: FileLocationSchema,
});

/** File lineage - tracks where files came from */
export const FileLineageSchema = z.strictObject({
  original: FileLocationSchema.nullable(),
  diffBase: FileLocationSchema.nullable(),
  diffFile: FileLocationSchema.nullable(),
});

/** Complete output file metadata (extends OutputFileSchema) */
export const OutputFileInfoSchema = OutputFileSchema.extend({
  lineage: FileLineageSchema.nullable(),
  diff: DiffStatsSchema.nullable(),
});

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

export type OutputFile = z.infer<typeof OutputFileSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;

/** XML summary schema with defaults via prefault */
export const OutputXmlSummarySchema = z.strictObject({
  tagContents: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .prefault(() => ({})),
  documents: z.array(z.string()).prefault(() => []),
  singleOutputFile: z.string().nullable(),
  sourceLocation: FileLocationSchema.nullable(),
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
