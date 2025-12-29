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
 * - Do NOT pass boolean fields like 'endTurn' or 'roundFinalized'
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
// Debug Context Factory
// ============================================================================

/**
 * Creates a debug context for cycle operations.
 *
 * Note: The caller should pass isRemote (computed via isRemoteAgent from @agent/index)
 * to avoid circular dependency issues.
 */
export function createDebugContext(
  options: CycleDebugContext,
): CycleDebugContext {
  return { ...options };
}

/**
 * Creates debug file options for a cycle.
 */
export function createDebugFileOptions(
  roundIndex: number,
  baseName: string,
  outputFile?: string,
): CycleDebugFileOptions {
  return {
    continuationCount: roundIndex,
    baseName,
    outputFile,
  };
}
