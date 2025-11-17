// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { DiffStatsSchema, type DiffStats } from '@agent/types/DiffTypes';

// Local imports - files
import type { FileLocation } from '@utils/files/taskRunStorage';

// ============================================================================
// SCHEMAS (Zod v3 - define schemas, then infer types)
// ============================================================================

const FileLocationScopeSchema = z.union([
  z.literal('workspace'),
  z.literal('runStorage'),
  z.literal('external'),
]);

const FileRelativeScopeSchema = z.union([
  z.literal('workspace'),
  z.literal('runStorage'),
  z.literal('absolute'),
]);

const WorkspaceLocationSchema = z
  .object({
    absolutePath: z.string(),
    relativePath: z.string(),
  })
  .strict();

const RunStorageLocationSchema = z
  .object({
    absolutePath: z.string(),
    relativePath: z.string(),
    storageRelativePath: z.string(),
  })
  .strict();

export const FileLocationSchema = z
  .object({
    absolutePath: z.string(),
    scope: FileLocationScopeSchema,
    relativePath: z.string(),
    relativeScope: FileRelativeScopeSchema,
    workspace: WorkspaceLocationSchema.nullish(),
    runStorage: RunStorageLocationSchema.nullish(),
  })
  .strict();

// ============================================================================
// OUTPUT FILE TYPES
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

export type OutputFile = z.infer<typeof OutputFileSchema>;

/**
 * File lineage - tracks where files came from.
 * Uses full FileLocation objects (not split across string + location fields).
 */
export const FileLineageSchema = z
  .object({
    base: FileLocationSchema.optional(),
    previous: FileLocationSchema.optional(),
    original: FileLocationSchema.optional(),
  })
  .strict();

export type FileLineage = z.infer<typeof FileLineageSchema>;

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
    lineage: FileLineageSchema.optional(),
    diff: DiffStatsSchema.optional(),
  })
  .strict();

export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

// ============================================================================
// XML SUMMARY TYPES
// ============================================================================

const RawOutputXmlSummarySchema = z
  .object({
    tagContents: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    documents: z.array(z.string()).optional(),
    singleOutputFile: z.string().nullable().optional(),
    sourceLocation: FileLocationSchema.nullable().optional(),
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

export type OutputXmlSummary = z.infer<typeof OutputXmlSummarySchema>;

// ============================================================================
// ROUND OUTPUT TYPES
// ============================================================================

/**
 * Complete artifacts from a conversation round.
 * - round: Round number
 * - rawOutput: The XML file the LLM wrote (before extraction)
 * - outputs: Extracted output files with metadata
 * - xmlSummary: Parsed XML summary (tags, documents, etc.)
 */
export const RoundOutputArtifactsSchema = z
  .object({
    round: z.number(),
    rawOutput: FileLocationSchema.nullable(),
    outputs: OutputFileInfoSchema.array(),
    xmlSummary: OutputXmlSummarySchema,
  })
  .strict();

export type RoundOutputArtifacts = z.infer<typeof RoundOutputArtifactsSchema>;

// ============================================================================
// INTERNAL MAPPING TYPES (used by OutputHandler)
// ============================================================================

/**
 * Internal mapping structure for file relationships.
 * Used for computing diffs and determining file origins.
 */
export interface RoundFileMapping {
  baseToOutput: Map<string, string>;
  prevToOutput: Map<string, string>;
  originByOutput: Map<string, string | undefined>;
  locationByOutput: Map<string, FileLocation>;
}

// ============================================================================
// LEGACY TYPES (for migration - will be removed)
// ============================================================================

/**
 * @deprecated Use OutputFile instead.
 * Legacy type with duplicate path fields. Kept temporarily for migration.
 */
export interface NamedOutputFile {
  source: string;
  path: string; // Duplicate of location.absolutePath
  relativePath: string; // Duplicate of location.relativePath
  workspacePath?: string; // Duplicate of location.workspace?.absolutePath
  location: FileLocation;
}
