// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { BaseTool } from '@tools/core/base';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import { AgentWorkspaceState } from './AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
  type ToolUseCycleState,
} from './flows/ToolUseCycleFlow';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';

// Local imports - model handlers

// Local imports - tools

export interface ToolUseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  toolRegistry: Record<string, BaseTool<any>>;
  workspaceState: AgentWorkspaceState;
  modelName?: string;
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

export async function runToolUseCycle<C = unknown>(
  context: ToolUseCycleContext<C>,
): Promise<void> {
  const shared: ToolUseCycleShared<C> = {
    options: context.options,
    store: context.store,
    state: {
      messages: context.messages,
      shouldStop: false,
      response: undefined,
      responseTime: undefined,
      toolCall: undefined,
      text: undefined,
      stopReason: undefined,
    } satisfies ToolUseCycleState,
  };

  const flow = createToolUseCycleFlow<C>();
  await flow.run(shared);
}
