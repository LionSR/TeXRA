// Local imports - logger
import type { AgentLogger } from '@logger/AgentLogger';

export type AgentLogStage = 'run' | 'init' | 'round' | 'output' | (string & {});

export interface AgentLogScopeToken {
  stage: AgentLogStage;
  groupId: string;
}

interface StageScopeOptions {
  id?: string;
  successStatus?: 'stopped' | 'error';
  errorStatus?: 'stopped' | 'error';
  parentStage?: AgentLogStage;
}

interface StageRunOptions extends StageScopeOptions {
  label: string;
}

const DEFAULT_STAGE_PARENTS: Partial<Record<AgentLogStage, AgentLogStage>> = {
  init: 'run',
  round: 'run',
  output: 'round',
};

function last<T>(values: T[] | undefined): T | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return values[values.length - 1];
}

/**
 * Manages lifecycle log scopes so agent collaborators avoid plumbing IDs.
 */
export class AgentLogScopeManager {
  private readonly stageStacks = new Map<AgentLogStage, string[]>();
  private readonly lastClosed = new Map<AgentLogStage, string>();

  constructor(
    private readonly logger: AgentLogger,
    private readonly stageParents: Partial<Record<AgentLogStage, AgentLogStage>> = {},
  ) {}

  getLogger(): AgentLogger {
    return this.logger;
  }

  getCurrent(stage: AgentLogStage): string | undefined {
    return last(this.stageStacks.get(stage));
  }

  getLastClosed(stage: AgentLogStage): string | undefined {
    return this.lastClosed.get(stage);
  }

  async runStage<T>(stage: AgentLogStage, options: StageRunOptions, fn: () => Promise<T>): Promise<T> {
    const token = await this.open(stage, options.label, options);
    return this.logger.withActiveGroup(token.groupId, async () => {
      try {
        const result = await fn();
        this.close(token, options.successStatus ?? 'stopped');
        return result;
      } catch (error) {
        this.close(token, options.errorStatus ?? 'error');
        throw error;
      }
    });
  }

  async open(
    stage: AgentLogStage,
    label: string,
    options: StageScopeOptions = {},
  ): Promise<AgentLogScopeToken> {
    const parentGroupId = this.resolveParent(stage, options.parentStage);
    const groupId = await this.logger.startGroup(label, options.id, parentGroupId);
    this.pushStage(stage, groupId);
    return { stage, groupId };
  }

  close(token: AgentLogScopeToken | undefined, status: 'stopped' | 'error' = 'stopped'): void {
    if (!token) {
      return;
    }

    this.popStage(token);
    this.lastClosed.set(token.stage, token.groupId);
    this.logger.endGroup(token.groupId, status);
  }

  async within<T>(stage: AgentLogStage, fn: () => Promise<T>): Promise<T> {
    const groupId = this.getCurrent(stage);
    if (!groupId) {
      return fn();
    }
    return this.logger.withActiveGroup(groupId, fn);
  }

  private resolveParent(stage: AgentLogStage, parentStage?: AgentLogStage): string | undefined {
    const preferredStage = parentStage ?? this.stageParents[stage] ?? DEFAULT_STAGE_PARENTS[stage];
    if (!preferredStage) {
      return undefined;
    }
    return this.getCurrent(preferredStage);
  }

  private pushStage(stage: AgentLogStage, groupId: string): void {
    const stack = this.stageStacks.get(stage) ?? [];
    stack.push(groupId);
    this.stageStacks.set(stage, stack);
  }

  private popStage(token: AgentLogScopeToken): void {
    const stack = this.stageStacks.get(token.stage);
    if (!stack || stack.length === 0) {
      return;
    }

    const index = stack.lastIndexOf(token.groupId);
    if (index === -1) {
      return;
    }

    stack.splice(index, 1);
    if (stack.length === 0) {
      this.stageStacks.delete(token.stage);
    } else {
      this.stageStacks.set(token.stage, stack);
    }
  }
}
