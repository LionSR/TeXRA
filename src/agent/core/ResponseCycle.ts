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
import type { TaskRunFileService, AgentFileLocation } from '@utils/files';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import {
  createResponseCycleFlow,
  type ResponseCycleContext,
  type ResponseCycleState,
} from './flows/ResponseCycleFlow';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';
import type { AgentConfig } from './AgentConfig';

export interface ResponseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  agentConfig: AgentConfig;
  fileService: TaskRunFileService;
}

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
  const context: ResponseCycleContext<C> = {
    options: input.options,
    store: input.store,
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
  };

  const flow = createResponseCycleFlow<C>();
  await flow.run(context);

  return {
    store: context.store,
    endTurn: context.state.endTurn,
  };
}
