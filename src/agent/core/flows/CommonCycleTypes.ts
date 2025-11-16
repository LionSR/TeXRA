/**
 * Common types shared across different flow cycles to reduce duplication
 * and provide consistent interfaces.
 */

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

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
 * Generic reset function for cycle states.
 * Resets all resettable fields while preserving input data (messages).
 *
 * @param state - The state object to reset
 * @param fieldsToReset - Array of field names to reset to undefined
 */
export function resetCycleState<T extends BaseCycleState>(
  state: T,
  fieldsToReset: Array<keyof Omit<T, keyof BaseCycleState>>,
): void {
  state.shouldStop = false;
  state.responseTime = undefined;
  state.stopReason = undefined;

  // Reset additional fields specific to the cycle type
  for (const field of fieldsToReset) {
    (state[field] as any) = undefined;
  }
}
