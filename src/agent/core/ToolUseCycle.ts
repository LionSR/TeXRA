/**
 * @file ToolUseCycle.ts
 *
 * Tool-use cycle execution for interactive agents.
 *
 * Operates on messages in-place and continues until user follow-up is required.
 * Used by BaseToolUseAgent for reactive, session-based execution.
 *
 * @see ResponseCycle for workflow-based cycle execution
 */

// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
  type ToolUseCycleState,
} from './flows/ToolUseCycleFlow';
import { createRetryState, type RetryCallbacks } from './flows/RetryState';

// Import and re-export from single source of truth
import type { ToolUseCycleOptions } from './flows/CycleServices';
export type { ToolUseCycleOptions };

export interface ToolUseCycleInput<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

export interface ToolUseCycleResult {
  /** Callbacks for triggering manual retry from UI. */
  retryCallbacks: RetryCallbacks;
}

/**
 * Executes a tool-use cycle for interactive agents.
 *
 * Tool-use cycles operate on messages in-place and continue until
 * user follow-up is required. They don't return a value because
 * control flow is managed by the interactive session lifecycle.
 *
 * This is used by BaseToolUseAgent for reactive, session-based execution
 * where the agent responds to tools and waits for user input.
 *
 * @param input - Cycle input with options, messages, and store
 * @returns Result with retry callbacks for UI to trigger manual retry
 * @see runResponseCycle for workflow-based cycle execution that returns control flags
 */
export async function runToolUseCycle<C = unknown>(
  input: ToolUseCycleInput<C>,
): Promise<ToolUseCycleResult> {
  // Initialize retry callbacks - these will be populated by RetryWaitNode
  // and can be called by the UI to trigger manual retry
  const retryCallbacks: RetryCallbacks = {};

  // Shared state contains only mutable data that flows through nodes.
  // Services (options, store) are injected via setParams().
  const shared: ToolUseCycleShared<C> = {
    state: {
      messages: input.messages,
      shouldStop: false,
      response: undefined,
      responseTime: undefined,
      toolCalls: undefined,
      text: undefined,
      stopReason: undefined,
    } satisfies ToolUseCycleState,
    retryState: createRetryState(),
    retryCallbacks,
  };

  const flow = createToolUseCycleFlow<C>();
  // Inject immutable services via params (PocketFlow pattern)
  flow.setParams({ services: { options: input.options, store: input.store } });
  await flow.run(shared);

  return { retryCallbacks };
}
