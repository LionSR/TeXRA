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
import type { BaseTool } from '@tools/core/base';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import { AgentWorkspaceState } from './AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  type ToolUseCycleContext,
  type ToolUseCycleState,
} from './flows/ToolUseCycleFlow';
import { createRetryState } from './flows/RetryState';
import type { RetryCallbacks } from './flows/RetryWaitNode';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';

// Local imports - model handlers

// Local imports - tools

export interface ToolUseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  toolRegistry: Record<string, BaseTool<any>>;
  workspaceState: AgentWorkspaceState;
  modelName?: string;
  agentName?: string;
}

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

  const context: ToolUseCycleContext<C> = {
    options: input.options,
    store: input.store,
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
  await flow.run(context);

  return { retryCallbacks };
}
