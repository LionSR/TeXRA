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

export async function runResponseCycle<C = unknown>(
  context: ResponseCycleContext<C>,
): Promise<ResponseCycleResult> {
  const shared: ResponseCycleShared<C> = {
    options: context.options,
    cycle: {
      messages: context.messages,
      stateRound: context.stateRound,
      stateGlobal: context.stateGlobal,
      toolState: context.toolState,
      outputFile: context.outputFile,
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
    } satisfies ResponseCycleState,
  };

  const flow = createResponseCycleFlow<C>();
  await flow.run(shared);

  return {
    stateRound: shared.cycle.stateRound,
    stateGlobal: shared.cycle.stateGlobal,
    toolState: shared.cycle.toolState,
    endTurn: shared.cycle.endTurn,
  };
}
