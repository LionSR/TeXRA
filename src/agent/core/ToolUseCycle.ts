// Local imports - agent components
import { ToolState } from './ToolState';

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
import { AgentLogScope } from '@logger/AgentLogger';

export interface ToolUseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  toolRegistry: Record<string, BaseTool<any>>;
  toolState: ToolState;
  modelName?: string;
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  scope?: AgentLogScope;
}

export async function runToolUseCycle<C = unknown>(
  context: ToolUseCycleContext<C>,
): Promise<void> {
  const logScope =
    context.scope ?? new AgentLogScope(context.options.logger, context.options.logger.getActiveGroupId());

  const shared: ToolUseCycleShared<C> = {
    options: context.options,
    state: {
      messages: context.messages,
      toolState: context.options.toolState,
      iteration: 0,
      shouldStop: false,
      response: undefined,
      responseTime: undefined,
      toolInfo: undefined,
      text: undefined,
      stopReason: undefined,
    } satisfies ToolUseCycleState,
    logScope,
  };

  const flow = createToolUseCycleFlow<C>();
  await flow.run(shared);
}
