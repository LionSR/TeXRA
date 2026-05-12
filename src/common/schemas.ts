/**
 * Shared parameter schemas for common patterns.
 *
 * Only contains schemas that are actively used - no speculative abstractions.
 */

import { z } from 'zod';

// ============================================================================
// Stream Config
// ============================================================================

/** Configuration for identifying a stream by agent/model/file. Schema is the single source of truth. */
export const StreamConfigSchema = z.object({
  agent: z.string(),
  model: z.string(),
  inputFile: z.string(),
});

/** Derived type from schema. */
export type StreamConfig = z.infer<typeof StreamConfigSchema>;

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
  compiler: z.enum(['pdflatex', 'latexmk']).prefault('latexmk'),
  /** Millisecond timeout per compiler invocation. Kills the child on expiry. */
  timeout: z.int().positive().optional(),
});

/** Input type - compiler optional with default applied by schema.parse() */
export type LaTeXCompileOptions = z.input<typeof LaTeXCompileOptionsSchema>;
