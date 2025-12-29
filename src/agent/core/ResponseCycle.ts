/**
 * @file ResponseCycle.ts
 *
 * Response cycle execution for workflow agents.
 *
 * Returns a result indicating whether the round should end.
 * Supports proactive, turn-based execution for structured output generation.
 *
 * @see ToolUseCycle for interactive cycle execution
 */

// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentFileLocation } from '@utils/files';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from './flows/ResponseCycleFlow';
import { createRetryState } from './flows/RetryState';
import { interpretCycleCompletion } from './flows/CommonCycleTypes';

// Import and re-export from single source of truth
import type { ResponseCycleOptions } from './flows/CycleServices';
export type { ResponseCycleOptions };

export interface ResponseCycleInput<C = unknown> {
  options: ResponseCycleOptions<C>;
  messages: ProviderMessage[];
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation: AgentFileLocation;
  store: AgentSharedStore;
}

export interface ResponseCycleResult {
  store: AgentSharedStore;
  endTurn: boolean;
  /** True if the cycle stopped due to an error (not user cancellation). */
  failedWithError: boolean;
  /** Error message if failedWithError is true. */
  errorMessage?: string;
  /** True if the user cancelled the retry wait (should stop gracefully). */
  userCancelled: boolean;
}

/**
 * Executes a response cycle for workflow agents.
 *
 * Response cycles return a result indicating whether the turn should end,
 * used by workflow flows to determine round continuation.
 *
 * Unlike tool-use cycles which continue until user input, response cycles
 * complete when the model generates a full response or hits a stopping condition.
 *
 * @param input - Cycle input with options, messages, output location, and store
 * @returns Result with endTurn flag and updated store
 * @see runToolUseCycle for interactive cycle execution
 */
export async function runResponseCycle<C = unknown>(
  input: ResponseCycleInput<C>,
): Promise<ResponseCycleResult> {
  // Shared state contains only mutable data that flows through nodes.
  // Services (options, store) are injected via setParams().
  const shared: ResponseCycleShared = {
    state: {
      messages: input.messages,
      outputLocation: input.outputLocation,
      endTurn: false,
      shouldStop: false,
      outputExists: false,
      systemPrompt: undefined,
      debugContext: undefined,
      debugFileOptions: undefined,
      startTime: undefined,
      responseObject: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      processedResponse: undefined,
      roundFinalized: false,
    } satisfies ResponseCycleState,
    retryState: createRetryState(),
  };

  const flow = createResponseCycleFlow<C>();
  // Inject immutable services via params (PocketFlow pattern)
  flow.setParams({ services: { options: input.options, store: input.store } });
  await flow.run(shared);

  // Interpret cycle completion - shared logic with ToolUseCycle
  const completion = interpretCycleCompletion(shared.state, shared.retryState);

  return {
    store: input.store,
    endTurn: shared.state.endTurn,
    ...completion,
  };
}
