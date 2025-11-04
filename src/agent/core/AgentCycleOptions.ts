// Local imports - agent configuration
import type { AgentPrompt, AgentSetting } from './AgentDataclass';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - execution context
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';

export interface UserVariableChannels {
  input: Readonly<Record<string, any>>;
  transient: Record<string, any>;
  output: Record<string, any>;
}

export interface AgentCycleBaseOptions<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  userVarChannels: UserVariableChannels;
  logger: AgentLogger;
  context: AgentExecutionContext;
  client: C;
  checkInterruption: () => Promise<boolean> | boolean;
  setAbortController: (ctrl: AbortController | null) => void;
}
