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
 * Result type for nodes that can be skipped based on flow state.
 * Use this when a node might not execute due to prior failures or conditions.
 */
export type SkippableNodeResult<T> =
  | { skipped: true }
  | { skipped: false; value: T };

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
  state.responseTime = undefined;
  state.stopReason = undefined;

  // Reset additional optional fields to undefined
  for (const field of additionalFields) {
    // Skip 'messages' to preserve it across resets
    if (field !== 'messages') {
      state[field] = undefined as T[typeof field];
    }
  }
}
