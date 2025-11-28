/**
 * Output processing flows module.
 *
 * This module provides pocketflow-based output processing for agents.
 * The main entry point is `runOutputProcessing()` which delegates to
 * OutputHandler as the single source of truth.
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
} from './OutputProcessingTypes';

// Node for testing or custom flows
export { ProcessOutputNode } from './OutputProcessingNodes';
