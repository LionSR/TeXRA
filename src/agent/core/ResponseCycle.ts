// Local imports - agent components
import { AgentStateGlobal, AgentStateRound } from './AgentState';
import { ToolState } from './ToolState';

// Local imports - flow orchestration
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from './flows/ResponseCycleFlow';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';

// Local imports - model handler types
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - agent configuration
import type { AgentConfig } from './AgentConfig';

export interface ResponseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  agentConfig: AgentConfig;
}

export interface ResponseCycleContext<C = unknown> {
  options: ResponseCycleOptions<C>;
  messages: ProviderMessage[];
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  outputFile: string;
}

export interface ResponseCycleResult {
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  endTurn: boolean;
}

/**
 * Executes a response cycle using Pocket Flow architecture.
 * Creates a structured shared store with explicit state slices and runs the flow.
 */
export async function runResponseCycle<C = unknown>(
  context: ResponseCycleContext<C>,
): Promise<ResponseCycleResult> {
  // Create structured shared store with explicit slices - native Pocket Flow design
  const shared: ResponseCycleShared<C> = {
    options: context.options,
    store: {
      persistent: {
        messages: context.messages,
        stateRound: context.stateRound,
        stateGlobal: context.stateGlobal,
        toolState: context.toolState,
        outputFile: context.outputFile,
      },
      runtime: {
        endTurn: false,
        shouldStop: false,
        outputExists: false,
      },
      debug: {
        systemPrompt: undefined,
        debugContext: undefined,
        debugFileOptions: undefined,
      },
      model: {
        startTime: undefined,
        responseObject: undefined,
        responseTime: undefined,
        stopReason: undefined,
        processedResponse: undefined,
      },
    },
  };

  const flow = createResponseCycleFlow<C>();
  await flow.run(shared);

  // Extract results from persistent slice
  return {
    stateRound: shared.store.persistent.stateRound,
    stateGlobal: shared.store.persistent.stateGlobal,
    toolState: shared.store.persistent.toolState,
    endTurn: shared.store.runtime.endTurn,
  };
}
