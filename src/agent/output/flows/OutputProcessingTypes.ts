/**
 * Types for the output processing flow following pocketflow architecture.
 *
 * This module defines the shared store for output processing.
 * The flow delegates to OutputHandler as the single source of truth.
 */

// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type {
  FileLocation,
  AgentFileLocation,
  OutputFileInfo,
} from '@agent/output/types';
import type { AgentLogStage } from '@logger/AgentLogger';

// ============================================================================
// SHARED STORE
// ============================================================================

/**
 * Input configuration for output processing - immutable during flow execution.
 */
export interface OutputProcessingInput {
  /** Location of the raw output file from the model */
  readonly outputLocation: AgentFileLocation;
  /** Current round index */
  readonly currRound: number;
  /** Base files to compare against for diff generation */
  readonly baseFiles: readonly FileLocation[];
  /** Agent workflow settings */
  readonly agentSetting: AgentWorkflowSetting;
  /** Agent configuration */
  readonly agentConfig: AgentConfig;
  /** Whether the turn has ended (affects diff generation) */
  readonly endTurn: boolean;
  /** Whether XML validation should be performed */
  readonly shouldValidateXml: boolean;
  /** Document tag for XML extraction */
  readonly documentTag: string;
  /** Parent log stage for nested logging */
  readonly parentStage?: AgentLogStage;
}

/**
 * Mutable state during output processing.
 */
export interface OutputProcessingState {
  /** Processed output files with metadata */
  processedFiles: OutputFileInfo[];
  /** Whether processing should continue */
  shouldContinue: boolean;
  /** Error encountered during processing (if any) */
  error: Error | null;
}

/**
 * Combined shared store for output processing flow.
 */
export interface OutputProcessingShared {
  /** Immutable input configuration */
  readonly input: OutputProcessingInput;
  /** Mutable processing state */
  state: OutputProcessingState;
}

// ============================================================================
// FLOW TRANSITIONS
// ============================================================================

/**
 * Flow transition actions for output processing.
 */
export const OutputProcessingAction = {
  /** Flow completed successfully */
  COMPLETE: 'complete',
  /** Flow failed with error */
  ERROR: 'error',
} as const;

export type OutputProcessingActionType =
  (typeof OutputProcessingAction)[keyof typeof OutputProcessingAction];

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Creates initial output processing state with default values.
 */
export function createInitialState(): OutputProcessingState {
  return {
    processedFiles: [],
    shouldContinue: true,
    error: null,
  };
}

/**
 * Creates an output processing shared store from input configuration.
 */
export function createOutputProcessingShared(
  input: OutputProcessingInput,
): OutputProcessingShared {
  return {
    input,
    state: createInitialState(),
  };
}
