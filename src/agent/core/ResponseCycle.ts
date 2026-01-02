/**
 * @file ResponseCycle.ts
 *
 * Response cycle execution for workflow agents.
 *
 * Provides executeResponseCycleCore() as the single entry point for response
 * cycle execution, used by ResponseCycleCompositionNode within ReflectionFlow.
 *
 * @see ToolUseCycle for interactive cycle execution
 */

// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentFileLocation } from '@utils/files';

// Local file imports
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
 * Execute response cycle with state slices.
 *
 * This is the single entry point for response cycle execution,
 * used by ResponseCycleCompositionNode within ReflectionFlow.
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

