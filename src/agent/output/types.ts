// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { DiffStatsSchema } from '@agent/types/DiffTypes';

// ============================================================================
// SCHEMAS (Zod v4 - schemas are the source of truth, types derived via z.infer)
// ============================================================================

const WorkspaceFileLocationSchema = z
  .object({
    kind: z.literal('workspace'),
    absolutePath: z.string(),
    relativePath: z.string(),
  })
  .strict();

const RunStorageFileLocationSchema = z
  .object({
    kind: z.literal('runStorage'),
    absolutePath: z.string(),
    relativePath: z.string(),
    executionId: z.string(),
  })
  .strict();

const ExternalFileLocationSchema = z
  .object({
    kind: z.literal('external'),
    absolutePath: z.string(),
  })
  .strict();

export const FileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

// ============================================================================
// OUTPUT FILE SCHEMAS (types derived via z.infer)
// ============================================================================

/**
 * Minimal output file reference - just source name + location.
 * Location contains all path variants (absolute, relative, workspace).
 */
export const OutputFileSchema = z
  .object({
    source: z.string(),
    location: FileLocationSchema,
  })
  .strict();

/**
 * File lineage - tracks where files came from.
 * Uses full FileLocation objects (not split across string + location fields).
 * Fields are nullable to support cases where lineage doesn't exist.
 */
export const FileLineageSchema = z
  .object({
    base: FileLocationSchema.nullable(),
    previous: FileLocationSchema.nullable(),
    original: FileLocationSchema.nullable(),
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
    location: FileLocationSchema,
    lineage: FileLineageSchema.nullable(),
    diff: DiffStatsSchema.nullable(),
  })
  .strict();

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

// Derive types from schemas (Zod v4)
export type OutputFile = z.infer<typeof OutputFileSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;
export type FileLocation = z.infer<typeof FileLocationSchema>;

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
    sourceLocation: FileLocationSchema.nullable(),
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
    rawOutput: FileLocationSchema.nullable(),
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
 * Used for computing diffs and determining file origins.
 * Note: Maps can't be directly represented in Zod, so this remains an interface.
 */
export interface RoundFileMapping {
  baseToOutput: Map<string, string>;
  prevToOutput: Map<string, string>;
  originByOutput: Map<string, string | undefined>;
  locationByOutput: Map<string, FileLocation>;
}

// ============================================================================
// LEGACY TYPES REMOVED
// ============================================================================
// NamedOutputFile has been eliminated. Use OutputFileInfo instead.
// OutputFileInfo contains all necessary information without duplicate fields.
