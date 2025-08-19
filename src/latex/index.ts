// Export TikZ-related functionality
export { TikzPictureManager, tikzPictureManager } from './TikzPictureManager';

// Export figure extraction functionality
export { extractFigurePathsFromLatex } from './extractFigure';

// Export text connection functionality
export {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
  ConnectionResult,
} from './textConnection';

// Export LaTeX compilation tools
export { compileLatex2Pdf } from './texTools';

// Export texcount functionality
export { getTeXCountStats } from './texcount';

// Export latexdiff service
export { LaTeXdiffService } from './latexdiff';
// Export latexdiff helpers
export { collectMathMacros } from './latexdiff/mathMacroDetector';

export { ArxivSourceProcessor, arxivProcessor } from './arxivProcessor';

// Export media manager
export { LatexMediaManager } from './LatexMediaManager';
