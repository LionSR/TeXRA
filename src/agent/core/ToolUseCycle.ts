// Local imports - agent components
import {
  ToolRuntimeStore,
  createAgentSharedStore,
  RoundMetricsState,
  type AgentSharedStore,
} from '@agent/state';

// Local imports - flow orchestration
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
  type ToolUseCycleState,
} from './flows/ToolUseCycleFlow';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';

// Local imports - model handlers
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - tools
import type { BaseTool } from '@tools/core/base';

export interface ToolUseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  toolRegistry: Record<string, BaseTool<any>>;
  toolState: ToolRuntimeStore;
  modelName?: string;
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
}

export async function runToolUseCycle<C = unknown>(
  context: ToolUseCycleContext<C>,
): Promise<void> {
  const sharedStore: AgentSharedStore = createAgentSharedStore({
    roundMetrics: new RoundMetricsState(0),
    toolRuntime: context.options.toolState,
  });
  const shared: ToolUseCycleShared<C> = {
    options: context.options,
    state: {
      messages: context.messages,
      sharedStore,
      iteration: 0,
      shouldStop: false,
      response: undefined,
      responseTime: undefined,
      toolInfo: undefined,
      text: undefined,
      stopReason: undefined,
    } satisfies ToolUseCycleState,
  };

  const flow = createToolUseCycleFlow<C>();
  await flow.run(shared);
}
