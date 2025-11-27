/**
 * Output processing flows module.
 *
 * This module provides pocketflow-based output processing for agents.
 * The main entry point is `runOutputProcessing()` which orchestrates
 * the entire output processing pipeline.
 */

// Main flow and runner
export {
  createOutputProcessingFlow,
  runOutputProcessing,
  type OutputProcessingResult,
  type OutputProcessingServices,
  type OutputProcessingParams,
  type OutputProcessingInput,
  type OutputProcessingShared,
} from './OutputProcessingFlow';

// Types for consumers who need to work with the shared store
export {
  OutputProcessingAction,
  createInitialState,
  createOutputProcessingShared,
  type OutputProcessingState,
  type OutputProcessingActionType,
  type XmlValidationResult,
  type FileProcessingResult,
  type DiffGenerationResult,
} from './OutputProcessingTypes';

// Individual nodes for testing or custom flows
export {
  PrepareOutputNode,
  XmlValidationNode,
  ProcessFilesNode,
  IndentFilesNode,
  ReplaceInputCommandsNode,
  FinalizeOutputNode,
} from './OutputProcessingNodes';
