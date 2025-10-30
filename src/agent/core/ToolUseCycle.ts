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

// Local imports - usage
import type { ExecutionId } from '@agent/types/IdentifierTypes';

export interface ToolUseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  toolRegistry: Record<string, BaseTool<any>>;
  toolState: ToolState;
  modelName?: string;
  executionId?: ExecutionId;
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  groupId?: string;
}

export async function runToolUseCycle<C = unknown>(
  context: ToolUseCycleContext<C>,
): Promise<void> {
  const shared: ToolUseCycleShared<C> = {
    options: context.options,
    state: {
      messages: context.messages,
      toolState: context.options.toolState,
      groupId: context.groupId,
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
