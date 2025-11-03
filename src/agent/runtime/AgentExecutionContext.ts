// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';
import { AgentUsageReporter } from '@logger/AgentUsageReporter';

// Local imports - runtime helpers
import { AgentLogScopeManager } from './AgentLogScopeManager';

export interface AgentExecutionContextInit {
  streamId: StreamTabId;
  executionId?: ExecutionId;
}

/**
 * Aggregates shared execution state so collaborators avoid plumbing IDs.
 */
export class AgentExecutionContext {
  public readonly logger: AgentLogger;
  public readonly usageReporter: AgentUsageReporter;
  public readonly logScopes: AgentLogScopeManager;

  constructor(private readonly init: AgentExecutionContextInit) {
    this.logger = new AgentLogger(init.streamId, true);
    this.usageReporter = new AgentUsageReporter(this.logger, init.streamId);
    this.logScopes = new AgentLogScopeManager(this.logger);
  }

  get streamId(): StreamTabId {
    return this.init.streamId;
  }

  get executionId(): ExecutionId | undefined {
    return this.init.executionId;
  }
}
