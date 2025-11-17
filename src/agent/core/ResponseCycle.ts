// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { TaskRunFileService, FileLocation } from '@utils/files';

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
  outputLocation: FileLocation;
  store: AgentSharedStore;
}

export interface ResponseCycleResult {
  store: AgentSharedStore;
  endTurn: boolean;
}

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
