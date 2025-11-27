/**
 * Types for the output processing flow following pocketflow architecture.
 *
 * This module defines the shared store and related types for output processing,
 * keeping data schema separate from compute logic per pocketflow philosophy.
 */

// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type {
  FileLocation,
  AgentFileLocation,
  OutputFileInfo,
  OutputXmlSummary,
  RoundFileMapping,
} from '@agent/output/types';
import type { AgentLogStage } from '@logger/AgentLogger';

// ============================================================================
// SHARED STORE - Single source of truth for output processing state
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
 * Mutable state that flows through nodes during output processing.
 */
export interface OutputProcessingState {
  /** Raw content read from the output file */
  rawContent: string | null;
  /** Content after XML validation/repair */
  validatedContent: string | null;
  /** Processed output files with metadata */
  processedFiles: OutputFileInfo[];
  /** XML summary extracted from the output */
  xmlSummary: OutputXmlSummary | null;
  /** File mapping for diff generation */
  fileMapping: RoundFileMapping | null;
  /** Whether processing should continue */
  shouldContinue: boolean;
  /** Error encountered during processing (if any) */
  error: Error | null;
}

/**
 * Combined shared store for output processing flow.
 *
 * Following pocketflow philosophy:
 * - `input` contains immutable configuration (read in prep)
 * - `state` contains mutable processing state (written in post)
 */
export interface OutputProcessingShared {
  /** Immutable input configuration */
  readonly input: OutputProcessingInput;
  /** Mutable processing state */
  state: OutputProcessingState;
}

// ============================================================================
// FLOW TRANSITIONS - Action strings for node transitions
// ============================================================================

/**
 * Flow transition actions for output processing.
 * Using const object instead of enum for better tree-shaking.
 */
export const OutputProcessingAction = {
  /** Continue to next node in sequence */
  DEFAULT: 'default',
  /** Skip XML validation (direct processing) */
  SKIP_VALIDATION: 'skip_validation',
  /** XML needs repair, loop back */
  REPAIR: 'repair',
  /** Processing multiple output files */
  MULTIPLE: 'multiple',
  /** Processing single output file */
  SINGLE: 'single',
  /** Skip diff generation */
  SKIP_DIFF: 'skip_diff',
  /** Flow completed successfully */
  COMPLETE: 'complete',
  /** Flow failed with error */
  ERROR: 'error',
} as const;

export type OutputProcessingActionType =
  (typeof OutputProcessingAction)[keyof typeof OutputProcessingAction];

// ============================================================================
// RESULT TYPES - For node exec results
// ============================================================================

/**
 * Result of XML validation step.
 */
export interface XmlValidationResult {
  isValid: boolean;
  content: string;
  repairAttempted: boolean;
}

/**
 * Result of file processing step.
 */
export interface FileProcessingResult {
  files: OutputFileInfo[];
  xmlSummary: OutputXmlSummary | null;
}

/**
 * Result of diff generation step.
 */
export interface DiffGenerationResult {
  filesWithDiff: OutputFileInfo[];
  diffGenerated: boolean;
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Creates initial output processing state with default values.
 */
export function createInitialState(): OutputProcessingState {
  return {
    rawContent: null,
    validatedContent: null,
    processedFiles: [],
    xmlSummary: null,
    fileMapping: null,
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
