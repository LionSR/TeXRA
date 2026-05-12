// -----------------------------------------------------------------------------
// TikZ Utilities
// -----------------------------------------------------------------------------

export { TikzPictureManager, tikzPictureManager } from './TikzPictureManager';

// -----------------------------------------------------------------------------
// Figure Extraction
// -----------------------------------------------------------------------------

export { extractFigurePathsFromLatex } from './extractFigure';

// -----------------------------------------------------------------------------
// File Dependency Extraction
// -----------------------------------------------------------------------------

export { extractLatexFileDependencies } from './extractFileDependencies';

// -----------------------------------------------------------------------------
// Bibliography Utilities
// -----------------------------------------------------------------------------

export {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from './extractBibliography';

// -----------------------------------------------------------------------------
// LaTeX Formatting
// -----------------------------------------------------------------------------

export { runLatexFormatter } from './texFormatter';

// -----------------------------------------------------------------------------
// LaTeX Diff
// -----------------------------------------------------------------------------

export { LaTeXdiffService } from './latexdiff';
export {
  DEFAULT_MATH_MARKUP,
  describeMathMarkupOption,
  DiffCommandExecutor,
  DiffFileProcessor,
  generateDiffFileName,
  MATH_MARKUP_OPTIONS,
  type MathMarkupOption,
} from './latexdiff/index';

// -----------------------------------------------------------------------------
// Media/Image Handling
// -----------------------------------------------------------------------------

export { LatexMediaManager } from './LatexMediaManager';
export { ArxivSourceProcessor, arxivProcessor } from './arxivProcessor';

// -----------------------------------------------------------------------------
// Criticism Annotations
// -----------------------------------------------------------------------------

export {
  parseCriticismAnnotations,
  type CriticismAnnotation,
} from './criticismParser';

// -----------------------------------------------------------------------------
// Core Utilities
// -----------------------------------------------------------------------------

export { compileLatex2Pdf } from './texTools';
export {
  getTeXCount,
  getTeXCountStats,
  type TexcountMode,
  type TexcountOptions,
  type TexcountResult,
} from './texcount';
export {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
} from './textConnection';
