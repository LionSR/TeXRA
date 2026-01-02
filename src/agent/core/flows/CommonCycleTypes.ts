/**
 * Common types shared across different flow cycles to reduce duplication
 * and provide consistent interfaces.
 *
 * ## Architectural Note: PocketFlow Separation of Concerns
 *
 * Flow nodes follow PocketFlow's separation pattern:
 * - `prep(shared)` extracts data from shared state into a PrepResult
 * - `exec(prepRes)` performs compute using ONLY prepRes (no shared access)
 * - `post(shared, prepRes, execRes)` writes results back to shared
 *
 * This separation ensures:
 * 1. `exec()` is isolated and easier to test
 * 2. Retries don't have side effects on shared state
 * 3. Clear data flow through the node lifecycle
 *
 * Services (modelHandler, client, etc.) are accessed via `_params.services`,
 * which is the PocketFlow pattern for immutable configuration.
 */

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { RetryState } from './RetryState';

/**
 * Base state interface shared by all cycle flows.
 * Contains common fields for message handling and flow control.
 */
export interface BaseCycleState {
  /** Messages being processed in this cycle */
  messages: ProviderMessage[];
  /** Whether the cycle should stop processing */
  shouldStop: boolean;
  /** Time taken for response in milliseconds */
  responseTimeMs?: number;
  /** Reason the model stopped generating */
  stopReason?: ProviderStopReason;
}

/**
 * Unified debug context used across all cycle flows.
 * Provides consistent logging and execution tracking.
 */
export interface CycleDebugContext {
  logger: AgentLogger;
  modelName?: string;
  executionId?: ExecutionId;
  /** Whether this is a remote agent (don't save messages to avoid leaking prompts) */
  isRemote?: boolean;
}

/**
 * Debug file options for saving intermediate flow state.
 */
export interface CycleDebugFileOptions {
  continuationCount: number;
  outputFile?: string;
  baseName?: string;
}

/**
 * Result type for nodes that can be skipped based on flow state.
 * Uses 'kind' discriminant for consistency with InvocationResult.
 */
export type SkippableNodeResult<T> =
  | { kind: 'skipped' }
  | { kind: 'success'; value: T };

/**
 * Generic reset function for cycle states.
 * Resets base state fields and any additional optional fields to undefined.
 *
 * IMPORTANT: Only pass fields that should be reset to undefined.
 * - Do NOT pass 'messages' (preserved across cycles)
 * - Do NOT pass boolean fields like 'endTurn'
 *   (these should be reset to false separately, not undefined)
 *
 * @param state - The state object to reset
 * @param additionalFields - Field names to reset to undefined (typically optional object fields)
 */
export function resetCycleState<T extends BaseCycleState>(
  state: T,
  additionalFields: (keyof T)[],
): void {
  // Reset base cycle state fields
  state.shouldStop = false;
  state.responseTimeMs = undefined;
  state.stopReason = undefined;

  // Reset additional optional fields to undefined
  for (const field of additionalFields) {
    // Skip 'messages' to preserve it across resets
    if (field !== 'messages') {
      state[field] = undefined as T[typeof field];
    }
  }
}

// ============================================================================
// Shared Flow Container Types
// ============================================================================

/**
 * Generic shared state wrapper for cycle flows.
 * Combines mutable runtime state with retry tracking.
 *
 * @template TState - The specific cycle state type (must extend BaseCycleState)
 */
export interface BaseCycleShared<TState extends BaseCycleState> {
  /** Runtime state for this cycle */
  state: TState;
  /** Retry state for model invocation errors */
  retryState: RetryState;
}

// ============================================================================
// Shared Prep/Exec Types for Invocation Nodes
// ============================================================================

/**
 * Base prep result for model/tool invocation nodes.
 * Contains the minimum data needed to decide whether to invoke.
 */
export interface BaseInvocationPrepResult {
  /** Whether to skip invocation (flow is stopping) */
  shouldStop: boolean;
  /** Messages to send to the model */
  messages: ProviderMessage[];
}

/**
 * Base success data returned from model/tool invocations.
 * Extended by specific flows with additional fields.
 */
export interface BaseInvocationSuccessData {
  /** Raw response from the model */
  response: unknown;
  /** Time taken for the response in milliseconds */
  responseTimeMs?: number;
}

// ============================================================================
// Cycle Result Interpretation
// ============================================================================

/**
 * Interpreted result from a cycle's shared state after flow completion.
 * Determines whether the cycle ended due to error, cancellation, or success.
 */
export interface CycleCompletionResult {
  /** True if the cycle stopped due to an error (not user cancellation). */
  failedWithError: boolean;
  /** Error message if failedWithError is true. */
  errorMessage?: string;
  /** True if the user cancelled the retry wait (should stop gracefully). */
  userCancelled: boolean;
}

/**
 * State needed to interpret cycle completion.
 * This is the minimal interface from shared state that we need.
 */
interface CycleCompletionState {
  shouldStop: boolean;
  endTurn?: boolean;
}

/**
 * Interprets cycle completion from shared state after flow execution.
 *
 * Determines if the cycle failed due to an error (not user cancellation):
 * - Error failure: shouldStop=true, lastError exists → failedWithError=true
 * - User cancelled: shouldStop=true, lastError=undefined, endTurn=false → userCancelled=true
 * - Successful completion: shouldStop=true, lastError=undefined, endTurn=true → neither
 *
 * @param state - The cycle state with shouldStop and optional endTurn
 * @param retryState - The retry state with optional lastError
 * @returns Interpreted completion result
 */
export function interpretCycleCompletion(
  state: CycleCompletionState,
  retryState: RetryState,
): CycleCompletionResult {
  const failedWithError = state.shouldStop && !!retryState.lastError;
  const userCancelled =
    state.shouldStop && !retryState.lastError && !state.endTurn;

  return {
    failedWithError,
    errorMessage: retryState.lastError?.message,
    userCancelled,
  };
}

