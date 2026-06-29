/**
 * Shared parameter schemas for common patterns.
 *
 * Only contains schemas that are actively used - no speculative abstractions.
 */

import { z } from 'zod';

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
  /**
   * Extra directories to prepend onto the kpathsea search path (TEXINPUTS /
   * BIBINPUTS / BSTINPUTS), after the main file's own directory and before the
   * workspace root. Used when a run-storage document compiles outside its
   * original location so relative `\input{…}` / `\bibliography{…}` targets
   * (e.g. `figures/fig.tex`, `library.bib`) still resolve against the original
   * source directory.
   */
  extraInputDirs: z.array(z.string()).prefault([]),
});

/** Input type - compiler optional with default applied by schema.parse() */
export type LaTeXCompileOptions = z.input<typeof LaTeXCompileOptionsSchema>;
