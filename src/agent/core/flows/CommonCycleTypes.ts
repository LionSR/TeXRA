/**
 * Common types shared across different flow cycles to reduce duplication
 * and provide consistent interfaces.
 */

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentLogger } from '@logger/AgentLogger';

/**
 * Base state interface shared by all cycle flows.
 * Contains common fields for message handling and flow control.
 */
export interface BaseCycleState {
  /** Messages being processed in this cycle */
  messages: ProviderMessage[];
  /** Whether the cycle should stop processing */
  shouldStop: boolean;
  /** Time taken for response in seconds */
  responseTime?: number;
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
 * Generic result type for node execution that can succeed or fail.
 * Use this for nodes that always execute (no skipping).
 */
export type NodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Result type for nodes that can be skipped based on flow state.
 * Use this when a node might not execute due to prior failures or conditions.
 */
export type SkippableNodeResult<T> =
  | { skipped: true }
  | { skipped: false; value: T };

/**
 * Generic reset function for cycle states.
 * Resets all resettable fields while preserving input data (messages).
 *
 * @param state - The state object to reset
 * @param additionalFields - Additional field names beyond BaseCycleState to reset
 */
export function resetCycleState<T extends BaseCycleState>(
  state: T,
  additionalFields: (keyof T)[],
): void {
  // Reset base cycle state fields
  state.shouldStop = false;
  state.responseTime = undefined;
  state.stopReason = undefined;

  // Reset additional fields specific to the cycle type
  for (const field of additionalFields) {
    if (field !== 'messages') {
      // Preserve messages, reset everything else
      (state[field] as any) = undefined;
    }
  }
}
