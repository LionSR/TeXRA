// State management
export {
  createOutputState,
  setActiveRun,
  hasRoundOutputs,
  getOutputFilesByRound,
} from './outputState';
export type { OutputState, OutputDependencies } from './outputState';

// Processing pipeline
export { extractFilesFromXml } from './xmlExtraction';
export { traceFileLineage } from './lineageMapping';
export {
  checkExpectedOutputs,
  type ValidationResult,
} from './outputValidation';
export { summarizeRound, getRoundOutput } from './roundSummary';

// Types
export type { RoundFileMapping } from './types';

// Classes
export { LatexDiffManager } from './LatexDiffManager';
export { XmlOutputManager } from './XmlOutputManager';
