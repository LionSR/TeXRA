import {
  readRuntimeHistoryConfig,
  requestClearRuntimeHistoryExecutions,
  requestDeleteRuntimeHistoryExecution,
  type RuntimeHistoryAgentConfig,
  type RuntimeHistoryClearResult,
  type RuntimeHistoryDeleteExecutionResult,
} from '@agent/runtime/historyCommands';
import {
  buildRuntimeTaskStateFromConfig,
  type RuntimeTaskState,
} from '@agent/runtime/executionRequests';
import type { ExecutionId } from '@shared/schemas';

export type SettingsHistoryConfigResult =
  | { readonly ok: true; readonly config: RuntimeHistoryAgentConfig }
  | { readonly ok: false; readonly reason: 'missingConfig' };

export type SettingsHistoryRestoreResult =
  | { readonly ok: true; readonly taskState: RuntimeTaskState }
  | { readonly ok: false; readonly reason: 'missingConfig' };

export interface SettingsHistoryActionControllerDeps {
  readonly readConfig?: (
    executionId: ExecutionId,
  ) => Promise<RuntimeHistoryAgentConfig | null>;
  readonly buildTaskState?: (
    config: RuntimeHistoryAgentConfig,
  ) => RuntimeTaskState;
  readonly deleteExecution?: (
    executionId: ExecutionId,
  ) => Promise<RuntimeHistoryDeleteExecutionResult>;
  readonly clearExecutions?: () => Promise<RuntimeHistoryClearResult>;
}

/**
 * Host-neutral history actions for the Settings view.
 *
 * Hosts decide which message to show or command to execute. This controller
 * owns the runtime-history interpretation: id casting, missing-config
 * handling, and the config-to-task-state projection used by restore.
 */
export class SettingsHistoryActionController {
  constructor(
    private readonly deps: SettingsHistoryActionControllerDeps = {},
  ) {}

  async getRerunConfig(
    historyId: string,
  ): Promise<SettingsHistoryConfigResult> {
    const config = await this.readConfig(historyId);
    if (!config) return { ok: false, reason: 'missingConfig' };
    return { ok: true, config };
  }

  async getRestoreTaskState(
    historyId: string,
  ): Promise<SettingsHistoryRestoreResult> {
    const config = await this.readConfig(historyId);
    if (!config) return { ok: false, reason: 'missingConfig' };
    return {
      ok: true,
      taskState: this.buildTaskState(config),
    };
  }

  deleteHistoryExecution(
    historyId: string,
  ): Promise<RuntimeHistoryDeleteExecutionResult> {
    return this.deleteExecution(historyId);
  }

  clearHistoryExecutions(): Promise<RuntimeHistoryClearResult> {
    return this.clearExecutions();
  }

  private readConfig(
    historyId: string,
  ): Promise<RuntimeHistoryAgentConfig | null> {
    return (this.deps.readConfig ?? readRuntimeHistoryConfig)(
      historyId as ExecutionId,
    );
  }

  private buildTaskState(config: RuntimeHistoryAgentConfig): RuntimeTaskState {
    return (this.deps.buildTaskState ?? buildRuntimeTaskStateFromConfig)(
      config,
    );
  }

  private deleteExecution(
    historyId: string,
  ): Promise<RuntimeHistoryDeleteExecutionResult> {
    return (this.deps.deleteExecution ?? requestDeleteRuntimeHistoryExecution)(
      historyId as ExecutionId,
    );
  }

  private clearExecutions(): Promise<RuntimeHistoryClearResult> {
    return (
      this.deps.clearExecutions ?? requestClearRuntimeHistoryExecutions
    )();
  }
}
