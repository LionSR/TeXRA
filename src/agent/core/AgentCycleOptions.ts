// Local imports - agent configuration
import type { AgentPrompt, AgentSetting } from './AgentDataclass';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';

// Local imports - identifier types
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - execution context
import type { ExecutionContext } from './ExecutionContext';

/**
 * Base options for agent execution cycles.
 *
 * Note: The `executionContext` field is optional and provides a unified
 * way to access execution-scoped dependencies. When provided, it can
 * reduce the need to access individual fields like logger, executionId, etc.
 *
 * Example with ExecutionContext:
 * ```typescript
 * async function processCycle(options: AgentCycleBaseOptions) {
 *   if (options.executionContext) {
 *     // Use unified context
 *     await options.executionContext.withGroup('Processing', async () => {
 *       options.executionContext.log('info', 'Starting');
 *     });
 *   } else {
 *     // Fallback to individual fields
 *     const groupId = await options.logger.startGroup('Processing');
 *     options.logger.info('Starting', groupId);
 *     options.logger.endGroup(groupId);
 *   }
 * }
 * ```
 */
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

  /**
   * Optional unified execution context providing cleaner access to
   * execution-scoped dependencies. When present, prefer using this
   * over individual fields for logging and context access.
   */
  executionContext?: ExecutionContext<C>;
}
