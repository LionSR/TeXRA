export {
  createOutputState,
  createDiffManager,
  createXmlManager,
  setActiveRun,
  getOutputFilesByRound,
  ensureRound,
  hasRoundOutputs,
  ensureXmlStructure,
  calculateRoundMapping,
  gatherRoundFileInfo,
  validateOutputsExist,
  finalizeRoundData,
  processRoundOutputs,
  getRoundArtifacts,
} from './outputUtils';
export type {
  OutputState,
  OutputDependencies,
  ValidationResult,
  FinalizeRoundResult,
} from './outputUtils';
export type { RoundFileMapping } from './types';
export { LatexDiffManager } from './LatexDiffManager';
export { XmlOutputManager } from './XmlOutputManager';
