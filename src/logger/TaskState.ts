import { AgentConfig } from '../agent/AgentConfig';

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

/** Creates a TaskState object from a serializable state object */
export function fromObject(obj: Record<string, any>): TaskState {
  return {
    // Basic task info
    agent: obj.agent || 'correct',
    model: obj.model || '',
    instruction: obj.instruction || '',
    // File selections
    inputFile: obj.inputFile || '',
    referenceFile: obj.referenceFile || '',
    auxiliaryFile: obj.auxiliaryFile || '',
    figureFile: obj.figureFile || '',
    outputNameOverride: obj.outputNameOverride || '',

    // Multiple file selections
    multipleInputFiles: obj.multipleInputFiles || [],
    multipleReferenceFiles: obj.multipleReferenceFiles || [],
    multipleAuxiliaryFiles: obj.multipleAuxiliaryFiles || [],
    multipleFigureFiles: obj.multipleFigureFiles || [],
    multipleOutputFiles: obj.multipleOutputFiles || [],

    // Multiple file selection visibility
    multipleInputFilesVisible: obj.multipleInputFilesVisible || false,
    multipleReferenceFilesVisible: obj.multipleReferenceFilesVisible || false,
    multipleAuxiliaryFilesVisible: obj.multipleAuxiliaryFilesVisible || false,
    multipleFigureFilesVisible: obj.multipleFigureFilesVisible || false,
    multipleOutputFilesVisible: obj.multipleOutputFilesVisible || false,

    // Auto extract settings
    autoExtractFigure: obj.autoExtractFigure || false,
    autoExtractTikzFigure: obj.autoExtractTikzFigure || false,

    // Tool use settings
    reflect: obj.reflect || false,
    attachTeXCount: obj.attachTeXCount || false,
    usePrefillFromInput: obj.usePrefillFromInput || false,
    printInputPrompt: obj.printInputPrompt || false,

    // Output name override visibility
    outputNameOverrideVisible: obj.outputNameOverrideVisible || false,
  };
}
