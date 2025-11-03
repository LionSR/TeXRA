// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';
import { AgentUsageReporter } from '@logger/AgentUsageReporter';

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

  constructor(private readonly init: AgentExecutionContextInit) {
    this.logger = new AgentLogger(init.streamId, true);
    this.usageReporter = new AgentUsageReporter(this.logger, init.streamId);
  }

  get streamId(): StreamTabId {
    return this.init.streamId;
  }

  get executionId(): ExecutionId | undefined {
    return this.init.executionId;
  }
}
