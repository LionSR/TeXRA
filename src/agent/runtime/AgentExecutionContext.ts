// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';

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
  agentCategory?: AgentCategory;
}

/**
 * Aggregates shared execution state so collaborators avoid plumbing IDs.
 */
export class AgentExecutionContext {
  public readonly logger: AgentLogger;
  public readonly usageReporter: AgentUsageReporter;
  private readonly agentCategory: AgentCategory;

  constructor(private readonly init: AgentExecutionContextInit) {
    this.logger = new AgentLogger(init.streamId, true);
    this.agentCategory = init.agentCategory ?? AgentCategory.Workflow;
    this.usageReporter = new AgentUsageReporter(
      this.logger,
      init.streamId,
      this.agentCategory,
    );
  }

  get streamId(): StreamTabId {
    return this.init.streamId;
  }

  get executionId(): ExecutionId | undefined {
    return this.init.executionId;
  }

  get sessionCategory(): AgentCategory {
    return this.agentCategory;
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
