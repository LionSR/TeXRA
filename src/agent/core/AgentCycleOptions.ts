// Local imports - agent configuration
import type { AgentPrompt, AgentSetting } from './AgentDataclass';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';

// Local imports - identifier types
import type { ExecutionId } from '@agent/types/IdentifierTypes';

export interface AgentCycleBaseOptions<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  logger: AgentLogger;
  client: C;
  checkInterruption: () => Promise<boolean> | boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  executionId?: ExecutionId;
}
