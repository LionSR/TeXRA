// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logger
import {
  AgentLogger,
  type AgentLogStage,
  type AgentLoggerStageOptions,
} from '@logger/AgentLogger';
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

  stage(
    label: string,
    options?: AgentLoggerStageOptions,
  ): Promise<AgentLogStage> {
    return this.logger.stage(label, options);
  }

  async withStage<T>(
    label: string,
    fn: (stage: AgentLogStage) => Promise<T>,
    options?: AgentLoggerStageOptions,
  ): Promise<T> {
    const stage = await this.stage(label, options);
    return stage.run(() => fn(stage));
  }
}
