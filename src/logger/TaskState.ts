import { AgentConfig } from '../agent/AgentConfig';
import { objectToTaskState } from '../utils/configConversion';

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
  figureFile: string;
  outputNameOverride: string;

  // Multiple file selections
  multipleInputFiles: string[];
  multipleReferenceFiles: string[];
  multipleAuxiliaryFiles: string[];
  multipleFigureFiles: string[];
  multipleOutputFiles: string[];

  // Multiple file selection visibility
  multipleInputFilesVisible: boolean;
  multipleReferenceFilesVisible: boolean;
  multipleAuxiliaryFilesVisible: boolean;
  multipleFigureFilesVisible: boolean;
  multipleOutputFilesVisible: boolean;

  // Auto extract settings
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;

  // Tool use settings
  reflect: boolean;
  attachTeXCount: boolean;
  usePrefillFromInput: boolean;
  printInputPrompt: boolean;

  // Output name override visibility
  outputNameOverrideVisible: boolean;
}
