/**
 * @file ResponseCycle.ts
 *
 * Response cycle execution for workflow agents.
 *
 * Returns a result indicating whether the round should end.
 * Used by BaseReflectionAgent for proactive, turn-based execution.
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
import { createRetryState, type RetryCallbacks } from './flows/RetryState';

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
  /** Callbacks for triggering manual retry from UI. */
  retryCallbacks: RetryCallbacks;
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
 * Response cycles return a result indicating whether the turn should end.
 * This is used by workflow agents (BaseReflectionAgent) to determine round continuation.
 *
 * Unlike tool-use cycles which continue until user input, response cycles
 * complete when the model generates a full response or hits a stopping condition.
 *
 * @param input - Cycle input with options, messages, output location, and store
 * @returns Result with endTurn flag and updated store
 * @see runToolUseCycle for interactive cycle execution that doesn't return control flags
 */
export async function runResponseCycle<C = unknown>(
  input: ResponseCycleInput<C>,
): Promise<ResponseCycleResult> {
  // Initialize retry callbacks - these will be populated by RetryWaitNode
  // and can be called by the UI to trigger manual retry
  const retryCallbacks: RetryCallbacks = {};

  // Shared state contains only mutable data that flows through nodes.
  // Services (options, store) are injected via setParams().
  const shared: ResponseCycleShared<C> = {
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
      responseTime: undefined,
      stopReason: undefined,
      processedResponse: undefined,
      roundFinalized: false,
    } satisfies ResponseCycleState,
    retryState: createRetryState(),
    retryCallbacks,
  };

  const flow = createResponseCycleFlow<C>();
  // Inject immutable services via params (PocketFlow pattern)
  flow.setParams({ services: { options: input.options, store: input.store } });
  await flow.run(shared);

  // Determine if the cycle failed due to an error (not user cancellation).
  // User cancellation clears lastError in BaseRetryWaitNode, so:
  // - Error failure: shouldStop=true, lastError exists → failedWithError=true
  // - User cancelled: shouldStop=true, lastError=undefined → failedWithError=false
  const failedWithError =
    shared.state.shouldStop && !!shared.retryState.lastError;
  const userCancelled = shared.state.shouldStop && !shared.retryState.lastError;

  return {
    store: input.store,
    endTurn: shared.state.endTurn,
    retryCallbacks,
    failedWithError,
    errorMessage: shared.retryState.lastError?.message,
    userCancelled,
  };
}
