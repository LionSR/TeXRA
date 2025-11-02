// Local imports - agent state
import {
  RoundMetricsState,
  SessionUsageState,
  type ToolResponseState,
  createResponseCycleStore,
} from './AgentState';

// Local imports - flow orchestration
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
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
  stateRound: RoundMetricsState;
  stateGlobal: SessionUsageState;
  toolState: ToolResponseState;
  outputFile: string;
}

export interface ResponseCycleResult {
  stateRound: RoundMetricsState;
  stateGlobal: SessionUsageState;
  toolState: ToolResponseState;
  endTurn: boolean;
}

export async function runResponseCycle<C = unknown>(
  context: ResponseCycleContext<C>,
): Promise<ResponseCycleResult> {
  const store = createResponseCycleStore({
    messages: context.messages,
    outputFile: context.outputFile,
    round: context.stateRound,
    session: context.stateGlobal,
    toolState: context.toolState,
  });

  const shared: ResponseCycleShared<C> = {
    options: context.options,
    store,
  };

  const flow = createResponseCycleFlow<C>();
  await flow.run(shared);

  return {
    stateRound: shared.store.round,
    stateGlobal: shared.store.session,
    toolState: shared.store.tool,
    endTurn: shared.store.runtime.endTurn,
  };
}
