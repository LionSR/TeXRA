// Export TikZ-related functionality
export {
  extractTikzPicturesWithLabels,
  createStandaloneLatexWithLabels,
  extractAndCompileTikzPicturesWithLabels,
} from './tikzpicture';

// Export figure extraction functionality
export { extractFigurePathsFromLatex } from './extractFigure';

// Export text connection functionality
export {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
} from './textConnection';

// Export LaTeX compilation tools
export { compileLatexToPdf } from './texTools';

// Re-export types
export type { ConnectionResult } from './textConnection';
