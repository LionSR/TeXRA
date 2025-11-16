// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { BaseTool } from '@tools/core/base';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import { AgentWorkspaceState } from './AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  type ToolUseCycleContext,
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

export interface ToolUseCycleInput<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

export async function runToolUseCycle<C = unknown>(
  input: ToolUseCycleInput<C>,
): Promise<void> {
  const context: ToolUseCycleContext<C> = {
    options: input.options,
    store: input.store,
    state: {
      messages: input.messages,
      shouldStop: false,
      response: undefined,
      responseTime: undefined,
      toolInfo: undefined,
      text: undefined,
      stopReason: undefined,
    } satisfies ToolUseCycleState,
  };

  const flow = createToolUseCycleFlow<C>();
  await flow.run(context);
}
