/**
 * Zod schemas for progress view data parsing.
 * Replaces hand-rolled normalization functions with schema-first validation.
 */

// Third-party imports
import { z } from 'zod';

/**
 * Schema for MISSING_OUTPUTS message data.
 * Contains information about expected output files that were not found.
 */
export const MissingOutputsPayloadSchema = z.object({
  /** List of missing file paths */
  missing: z.array(z.string()).default([]),
  /** Path to the XML file to check for tag consistency */
  xmlFile: z.string().nullable().default(null),
  /** Expected document tag in the XML file */
  documentTag: z.string().nullable().default(null),
});

export type MissingOutputsPayload = z.infer<typeof MissingOutputsPayloadSchema>;

/**
 * Schema for raw TOOL_USE message data (as logged).
 * Supports both modern (toolName) and legacy (tool) field names.
 */
export const ToolUseLogSchema = z.object({
  /** Tool name (modern format) */
  toolName: z.string().optional(),
  /** Tool name (legacy format) */
  tool: z.string().optional(),
  /** Tool input parameters */
  input: z.unknown().optional(),
  /** Tool output (may be nested with metadata) */
  output: z.unknown().optional(),
  /** Summary text for display in header */
  summary: z.string().optional(),
  /** Error message if tool failed */
  error: z.string().optional(),
  /** Whether the tool execution resulted in an error */
  isError: z.boolean().optional(),
  /** User instruction/feedback provided during tool execution */
  userInstruction: z.string().optional(),
});

export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

/**
 * Schema for normalized tool use data (ready for rendering).
 * This is the output of the parseToolUseData function.
 */
export const NormalizedToolUseSchema = z.object({
  /** Original parsed data for fallback rendering */
  parsed: z.record(z.string(), z.unknown()),
  /** Resolved tool name (from toolName or tool field) */
  toolName: z.string(),
  /** Error message text (extracted from nested structure) */
  errorText: z.string(),
  /** Output text (formatted for display) */
  outputText: z.string(),
  /** User instruction text (extracted from nested structure) */
  userInstructionText: z.string(),
  /** Raw input value */
  input: z.unknown(),
  /** Whether this is an error state */
  isError: z.boolean(),
  /** Whether this has user feedback */
  isUserFeedback: z.boolean(),
  /** Summary text for the header */
  headerSummary: z.string(),
});

export type NormalizedToolUse = z.infer<typeof NormalizedToolUseSchema>;

/**
 * Schema for normalized file list entries (ready for rendering).
 * This is the display format consumed by htmlBuilders.buildFileListRender().
 */
export const NormalizedFileEntrySchema = z.object({
  /** Original file path (for FileListEntrySchema compatibility) */
  path: z.string(),
  /** Whether the file was successfully loaded/found */
  ok: z.boolean(),
  /** Category source identifier */
  source: z.string(),
  /** File path for display */
  filePath: z.string(),
  /** Basename of the file for display */
  fileName: z.string(),
  /** Display label for the source */
  sourceDisplay: z.string(),
  /** Whether this is an internal/bundled file */
  internal: z.boolean(),
  /** Variable name if loaded for prompt variable substitution */
  varName: z.string(),
});

export type NormalizedFileEntry = z.infer<typeof NormalizedFileEntrySchema>;

/**
 * Schema for web search result entries.
 */
export const WebSearchResultSchema = z.object({
  /** Result URL */
  url: z.string().optional(),
  /** Result title */
  title: z.string().optional(),
  /** Domain name */
  domain: z.string().optional(),
});

export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

/**
 * Schema for WEB_SEARCH message data.
 */
export const WebSearchPayloadSchema = z.object({
  /** Search query */
  query: z.string().optional(),
  /** Search results */
  results: z.array(WebSearchResultSchema).optional(),
  /** Search provider (anthropic, openai, etc.) */
  provider: z.string().optional(),
  /** Search status (in_progress, completed, failed) */
  status: z.string().optional(),
});

export type WebSearchPayload = z.infer<typeof WebSearchPayloadSchema>;
