// State management
export {
  createOutputState,
  setActiveRun,
  getStorageKey,
  ensureRoundData,
  hasRoundOutputs,
  ensureRound,
  getOutputFilesByRound,
} from './outputState';
export type { OutputState, OutputDependencies, RoundData } from './outputState';

// XML extraction
export { extractFilesFromXml } from './xmlExtraction';

// Diff computation
export { computeOutputDiffStats } from './diffComputation';

// Lineage mapping
export { traceFileLineage } from './lineageMapping';

// Validation
export { checkExpectedOutputs } from './outputValidation';
export type { ValidationResult } from './outputValidation';

// Round summary
export { summarizeRound, getRoundOutput } from './roundSummary';
export type { RoundSummary } from './roundSummary';

// Manager factories
export {
  createDiffManager,
  createXmlManager,
  ensureXmlStructure,
} from './managerFactories';

// Types
export type { RoundFileMapping } from './types';

// Classes
export { LatexDiffManager } from './LatexDiffManager';
export { XmlOutputManager } from './XmlOutputManager';
