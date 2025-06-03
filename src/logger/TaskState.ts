// Local imports - constants
import type { FileType } from '../utils/constants';

/** Interface for storing task execution state */
export interface TaskState {
  // Basic task info
  agent: string;
  model: string;
  instruction: string;

  // File selections
  inputFile: string;
  referenceFile: string;
  auxiliaryFile: string;
  mediaFile: string;
  outputNameOverride: string;

  // Multiple file selections
  inputFiles: string[];
  referenceFiles: string[];
  auxiliaryFiles: string[];
  mediaFiles: string[];
  outputFiles: string[];

  // Multiple file selection visibility
  /** Map of file type to active state */
  activeFiles: Record<FileType, boolean>;

  // Auto extract settings
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;

  // Tool config settings
  reflect: boolean;
  attachTeXCount: boolean;
  usePrefillFromInput: boolean;
  printInputPrompt: boolean;
  autoCompileInputPdf: boolean;

  // Output name override visibility
  outputNameOverrideVisible: boolean;
}
