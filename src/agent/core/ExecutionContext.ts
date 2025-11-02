// Local imports - types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import type { MessageType } from '@logger/messageTypes';

// Local imports - configuration
import type { AgentConfig } from './AgentConfig';
import type { AgentSetting } from './AgentDataclass';

// Local imports - logging
import type { ScopedAgentLogger } from '@logger/ScopedAgentLogger';

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';

/**
 * Unified execution context that encapsulates all execution-scoped
 * dependencies and state. This eliminates the need to pass multiple
 * separate parameters through method chains.
 *
 * Benefits:
 * - Single source of truth for execution state
 * - Type-safe access to all execution resources
 * - Simplified method signatures
 * - Easy to extend without breaking existing signatures
 *
 * Example usage:
 * ```typescript
 * async function processData(context: ExecutionContext) {
 *   await context.withGroup('Processing', async () => {
 *     context.log('info', 'Starting processing');
 *     // All logging automatically uses correct group
 *   });
 * }
 * ```
 */
export interface ExecutionContext<C = unknown> {
  // Identifiers
  readonly executionId: ExecutionId;
  readonly streamTabId: StreamTabId;

  // Core dependencies
  readonly logger: ScopedAgentLogger;
  readonly modelHandler: IModelHandler<any, any, any, any, C>;
  readonly agentConfig: AgentConfig;
  readonly agentSetting: AgentSetting;

  // Utility methods
  /**
   * Execute a function within a log group scope.
   * The group is automatically managed (started/ended).
   */
  withGroup<T>(name: string, callback: () => Promise<T>): Promise<T>;

  /**
   * Log a message at the specified level.
   * Automatically uses the current group scope.
   */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    messageType?: MessageType,
    data?: unknown,
  ): void;

  /**
   * Get the current active group ID.
   */
  getCurrentGroupId(): string | undefined;
}

/**
 * Factory for creating ExecutionContext instances.
 */
export class ExecutionContextFactory {
  /**
   * Create a new ExecutionContext.
   *
   * @param params Context parameters
   * @returns ExecutionContext instance
   */
  static create<C = unknown>(params: {
    executionId: ExecutionId;
    streamTabId: StreamTabId;
    logger: ScopedAgentLogger;
    modelHandler: IModelHandler<any, any, any, any, C>;
    agentConfig: AgentConfig;
    agentSetting: AgentSetting;
  }): ExecutionContext<C> {
    return new ExecutionContextImpl(params);
  }
}

/**
 * Implementation of ExecutionContext.
 * Private - use ExecutionContextFactory to create instances.
 */
class ExecutionContextImpl<C = unknown> implements ExecutionContext<C> {
  readonly executionId: ExecutionId;
  readonly streamTabId: StreamTabId;
  readonly logger: ScopedAgentLogger;
  readonly modelHandler: IModelHandler<any, any, any, any, C>;
  readonly agentConfig: AgentConfig;
  readonly agentSetting: AgentSetting;

  constructor(params: {
    executionId: ExecutionId;
    streamTabId: StreamTabId;
    logger: ScopedAgentLogger;
    modelHandler: IModelHandler<any, any, any, any, C>;
    agentConfig: AgentConfig;
    agentSetting: AgentSetting;
  }) {
    this.executionId = params.executionId;
    this.streamTabId = params.streamTabId;
    this.logger = params.logger;
    this.modelHandler = params.modelHandler;
    this.agentConfig = params.agentConfig;
    this.agentSetting = params.agentSetting;
  }

  async withGroup<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return this.logger.withGroup(name, callback);
  }

  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    this.logger[level](message, undefined, messageType, data);
  }

  getCurrentGroupId(): string | undefined {
    return this.logger.getCurrentScope();
  }
}
