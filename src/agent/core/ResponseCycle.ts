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
import type { AgentSharedStore } from './AgentSharedStore';
import type { AgentWorkspaceState } from './AgentWorkspaceState';
import type { AgentRunState, ConversationRoundState } from './AgentState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from './flows/ResponseCycleFlow';
import { createRetryState } from './flows/RetryState';
import { interpretCycleCompletion } from './flows/CommonCycleTypes';

// Import and re-export from single source of truth
import type {
  ResponseCycleOptions,
  RoundFinalizedCallback,
} from './flows/CycleServices';
export type { ResponseCycleOptions };

// ============================================================================
// Core Execution (shared by both entry points)
// ============================================================================

/**
 * Core response cycle result (without store wrapper).
 */
export interface ResponseCycleCoreResult {
  endTurn: boolean;
  failedWithError: boolean;
  errorMessage?: string;
  userCancelled: boolean;
}

/**
 * Core input for response cycle execution with state slices.
 * Used internally and by ResponseCycleCompositionNode.
 */
export interface ResponseCycleCoreInput<C = unknown> {
  options: ResponseCycleOptions<C>;
  messages: ProviderMessage[];
  outputLocation: AgentFileLocation;
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  onRoundFinalized?: RoundFinalizedCallback;
}

/**
 * Execute response cycle with state slices (no store wrapper).
 *
 * This is the core execution function used by both:
 * - runResponseCycle() (standalone function with store)
 * - ResponseCycleCompositionNode (flow node with slices)
 *
 * @internal
 */
export async function executeResponseCycleCore<C = unknown>(
  input: ResponseCycleCoreInput<C>,
): Promise<ResponseCycleCoreResult> {
  const shared: ResponseCycleShared = {
    state: {
      messages: input.messages,
      outputLocation: input.outputLocation,
      endTurn: false,
      shouldStop: false,
      outputExists: false,
      systemPrompt: undefined,
      debug: undefined,
      responseObject: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      processedResponse: undefined,
    } satisfies ResponseCycleState,
    retryState: createRetryState(),
  };

  const flow = createResponseCycleFlow<C>();
  flow.setServices({
    ...input.options,
    round: input.round,
    run: input.run,
    workspace: input.workspace,
    onRoundFinalized: input.onRoundFinalized,
  });
  await flow.run(shared);

  const completion = interpretCycleCompletion(shared.state, shared.retryState);

  return {
    endTurn: shared.state.endTurn,
    ...completion,
  };
}

// ============================================================================
// Public API (with store wrapper)
// ============================================================================

export interface ResponseCycleInput<C = unknown> {
  options: ResponseCycleOptions<C>;
  messages: ProviderMessage[];
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation: AgentFileLocation;
  store: AgentSharedStore;
  /** Optional callback invoked when round completes. */
  onRoundFinalized?: RoundFinalizedCallback;
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
  const { store, onRoundFinalized } = input;

  const result = await executeResponseCycleCore({
    options: input.options,
    messages: input.messages,
    outputLocation: input.outputLocation,
    round: store.round,
    run: store.run,
    workspace: store.workspace,
    onRoundFinalized,
  });

  return {
    store: input.store,
    ...result,
  };
}
