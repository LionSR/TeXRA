// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from './flows/ResponseCycleFlow';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';
import type { AgentConfig } from './AgentConfig';

export interface ResponseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  agentConfig: AgentConfig;
}

export interface ResponseCycleContext<C = unknown> {
  options: ResponseCycleOptions<C>;
  messages: ProviderMessage[];
  outputFile: string;
  store: AgentSharedStore;
}

export interface ResponseCycleResult {
  store: AgentSharedStore;
  endTurn: boolean;
}

export async function runResponseCycle<C = unknown>(
  context: ResponseCycleContext<C>,
): Promise<ResponseCycleResult> {
  const shared: ResponseCycleShared<C> = {
    options: context.options,
    store: context.store,
    state: {
      messages: context.messages,
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
      roundFinalized: false,
    } satisfies ResponseCycleState,
  };

  const flow = createResponseCycleFlow<C>();
  await flow.run(shared);

  return {
    store: shared.store,
    endTurn: shared.state.endTurn,
  };
}
