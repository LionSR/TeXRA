// Third-party imports
import { z } from 'zod';

// Local imports - agent configuration
import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentLogger } from '@logger/AgentLogger';
import type { AgentPrompt, AgentSetting } from './AgentDataclass';

/**
 * User variable channels for template rendering.
 *
 * Two-channel design:
 * - input: Frozen base variables (readonly, set at initialization)
 * - transient: Runtime modifications (mutable copy of base)
 *
 * Note: The former 'output' channel was removed as it was never populated.
 */
export const UserVariableChannelsSchema = z.object({
  input: z.record(z.string(), z.unknown()).readonly(),
  transient: z.record(z.string(), z.unknown()),
});

/** Derived from UserVariableChannelsSchema - single source of truth */
export type UserVariableChannels = z.infer<typeof UserVariableChannelsSchema>;

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
