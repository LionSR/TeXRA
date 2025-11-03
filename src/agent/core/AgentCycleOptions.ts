// Local imports - agent configuration
import type { AgentPrompt, AgentSetting } from './AgentDataclass';

// Local imports - logging
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';

export interface AgentCycleBaseOptions<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  client: C;
  checkInterruption: () => Promise<boolean> | boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  context: AgentExecutionContext;
}
