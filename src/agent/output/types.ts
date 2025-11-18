// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { DiffStatsSchema } from '@agent/types/DiffTypes';
// Re-export FileLocation from its source of truth
import type { FileLocation, AgentFileLocation } from '@utils/files';
export type { FileLocation, AgentFileLocation };

// ============================================================================
// OUTPUT FILE SCHEMAS (types derived via z.infer)
// ============================================================================

/**
 * Minimal output file reference - just source name + location.
 * Location contains all path variants (absolute, relative, workspace).
 * Note: FileLocation type is imported from @utils/files (not defined here)
 */
export const OutputFileSchema = z
  .object({
    source: z.string(),
    location: z.custom<FileLocation>(),
  })
  .strict();

/**
 * File lineage - tracks where files came from and what to compare against.
 * Uses full FileLocation objects (not split across string + location fields).
 * Fields are nullable to support cases where lineage doesn't exist.
 */
export const FileLineageSchema = z
  .object({
    /** Original location before any agent processing */
    original: z.custom<FileLocation>().nullable(),
    /** What file to diff against (base/previous round, computed by getEffectiveBaseFile) */
    diffBase: z.custom<FileLocation>().nullable(),
    /** Generated diff file location (if latexdiff was run) */
    diffFile: z.custom<FileLocation>().nullable(),
  })
  .strict();

/** @deprecated Old structure, use FileLineageSchema */
const LegacyFileLineageSchema = z
  .object({
    base: z.custom<FileLocation>().nullable(),
    previous: z.custom<FileLocation>().nullable(),
    original: z.custom<FileLocation>().nullable(),
  })
  .strict();

/**
 * Complete output file metadata.
 * - source: Document name (e.g., "main.tex")
 * - location: Where the file is (has all path variants)
 * - lineage: Where it came from (base/previous/original)
 * - diff: Line changes vs base
 */
export const OutputFileInfoSchema = z
  .object({
    source: z.string(),
    location: z.custom<FileLocation>(),
    lineage: FileLineageSchema.nullable(),
    diff: DiffStatsSchema.nullable(),
  })
  .strict();

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

// Derive types from schemas (Zod v4)
// Note: FileLocation is imported from @utils/files, not derived here
export type OutputFile = z.infer<typeof OutputFileSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;

// ============================================================================
// XML SUMMARY SCHEMAS
// ============================================================================

const RawOutputXmlSummarySchema = z
  .object({
    tagContents: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    documents: z.array(z.string()).optional(),
    singleOutputFile: z.string().nullable(),
    sourceLocation: z.custom<FileLocation>().nullable(),
  })
  .strict();

export const OutputXmlSummarySchema = RawOutputXmlSummarySchema.transform(
  (value) => ({
    tagContents: value.tagContents ?? {},
    documents: value.documents ?? [],
    singleOutputFile: value.singleOutputFile ?? null,
    sourceLocation: value.sourceLocation ?? null,
  }),
);

// Derive type from schema (Zod v4)
export type OutputXmlSummary = z.infer<typeof OutputXmlSummarySchema>;

// ============================================================================
// ROUND OUTPUT SCHEMAS
// ============================================================================

/**
 * Output from processing a conversation round.
 * - round: Round number
 * - rawOutput: The XML file the LLM wrote (before extraction)
 * - outputs: Extracted output files with metadata
 * - xmlSummary: Parsed XML metadata (TODO: Can this be simplified/removed?)
 */
export const RoundOutputSchema = z
  .object({
    round: z.number(),
    rawOutput: z.custom<FileLocation>().nullable(),
    outputs: OutputFileInfoSchema.array(),
    xmlSummary: OutputXmlSummarySchema,
  })
  .strict();

// Derive type from schema (Zod v4)
export type RoundOutput = z.infer<typeof RoundOutputSchema>;

// ============================================================================
// INTERNAL MAPPING SCHEMAS (used by OutputHandler)
// ============================================================================

/**
 * Internal mapping structure for file relationships.
 * Uses string keys (comparable paths) for robust lookups and FileLocation values for data.
 * This ensures lookups work even when FileLocation objects are reconstructed.
 *
 * All maps are indexed by OUTPUT path for efficient lineage lookup during gatherOutputFileInfo.
 */
export interface RoundFileMapping {
  /** Maps output file path to its corresponding base FileLocation (for round-based diffs) */
  baseToOutput: Map<string, FileLocation>;
  /** Maps output file path to its previous round FileLocation (for inter-round diffs) */
  prevToOutput: Map<string, FileLocation>;
  /** Maps output file path to its original base FileLocation (for tracking lineage) */
  originByOutput: Map<string, FileLocation | undefined>;
}

// ============================================================================
// LEGACY TYPES REMOVED
// ============================================================================
// NamedOutputFile has been eliminated. Use OutputFileInfo instead.
// OutputFileInfo contains all necessary information without duplicate fields.
