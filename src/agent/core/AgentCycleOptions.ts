// Third-party imports
import { z } from 'zod';

// Local imports - agent configuration
import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentLogger } from '@logger/AgentLogger';
import type { AgentPrompt, AgentSetting } from './AgentDataclass';

export interface UserVariableChannels {
  input: Readonly<Record<string, any>>;
  transient: Record<string, any>;
  output: Record<string, any>;
}

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy user variable channels that may contain removed or renamed fields.
 */
export const UserVariableChannelsSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  transient: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
});

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
