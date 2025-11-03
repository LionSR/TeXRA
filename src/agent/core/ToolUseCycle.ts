// Local imports - agent components
import { AgentSharedStore } from './AgentSharedStore';
import { AgentRunState, ConversationRoundState } from './AgentState';
import { ToolRuntimeState } from './ToolRuntimeState';

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
  toolState: ToolRuntimeState;
  modelName?: string;
  onUsageRecorded?: (event: ToolUseUsageEvent) => Promise<void> | void;
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

export interface ToolUseUsageEvent {
  run: AgentRunState;
  round: ConversationRoundState;
  endTurn: boolean;
}

export async function runToolUseCycle<C = unknown>(
  context: ToolUseCycleContext<C>,
): Promise<void> {
  const shared: ToolUseCycleShared<C> = {
    options: context.options,
    store: context.store,
    state: {
      messages: context.messages,
      toolState: context.options.toolState,
      iteration: context.store.round.roundIndex,
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
