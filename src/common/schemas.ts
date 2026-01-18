/**
 * Shared parameter schemas for common patterns.
 *
 * Only contains schemas that are actively used - no speculative abstractions.
 */

import { z } from 'zod';

// ============================================================================
// Stream Config Schema
// ============================================================================

/**
 * Configuration for identifying a stream by agent/model/file.
 * Used by streamEventUtils for ClearMissingOutputsOptions.
 */
export const StreamConfigSchema = z.object({
  agent: z.string(),
  model: z.string(),
  inputFile: z.string(),
});

export type StreamConfig = z.infer<typeof StreamConfigSchema>;

// ============================================================================
// Listing Options Schema
// ============================================================================

/**
 * Options for file listing operations with sensible defaults.
 * Used by prepareFilters in listing.ts.
 */
export const ListingOptionsSchema = z.object({
  includeExtensions: z.array(z.string()).prefault([]),
  excludeExtensions: z.array(z.string()).prefault([]),
  excludeDirectories: z.array(z.string()).prefault([]),
  excludeKeywords: z.array(z.string()).prefault([]),
  excludeFiles: z.array(z.string()).prefault([]),
});

export type ListingOptions = z.infer<typeof ListingOptionsSchema>;

// ============================================================================
// LaTeX Compile Options Schema
// ============================================================================

/**
 * Options for LaTeX compilation.
 * Used by compileLatex2Pdf in texTools.ts.
 */
export const LaTeXCompileOptionsSchema = z.object({
  channel: z.string().optional(),
  outputDirectory: z.string().optional(),
  compiler: z.enum(['pdflatex', 'latexmk']).prefault('pdflatex'),
});

export type LaTeXCompileOptions = z.infer<typeof LaTeXCompileOptionsSchema>;
