// Standard library imports
import { randomUUID } from 'crypto';

// Local imports - agent types
import type {
  ExecutionId,
  ExecutionIdentity,
  StorageKey,
  StreamTabId,
} from '@agent/types/IdentifierTypes';
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
 * Aggregates shared execution state and provides the unified ExecutionIdentity.
 *
 * This is the single source of truth for execution identity:
 * - executionId: Always a UUID, generated if not provided
 * - storageKey: THE key for storage operations
 * - streamTabId: UI tab identifier
 *
 * ## Storage Key Resolution
 *
 * The storageKey is computed once and updated only when a workflow agent
 * creates its primary task group:
 * - Initial value: executionId (works for tool-use agents)
 * - After updateStorageKey(): task group ID (for workflow agents)
 *
 * Components receive the identity and use storageKey directly, eliminating
 * runtime resolution and "which ID do I use?" confusion.
 */
export class AgentExecutionContext {
  public readonly logger: AgentLogger;
  public readonly usageReporter: AgentUsageReporter;
  private readonly agentCategory: AgentCategory;

  /**
   * Mutable identity for storage key resolution.
   *
   * ## Design Decision: Mutable storageKey
   *
   * The storageKey is intentionally mutable while other identity fields are readonly:
   * - executionId: Immutable, set at construction, always a UUID
   * - streamTabId: Immutable, set at construction, for UI identification
   * - storageKey: Mutable, initially equals executionId
   *
   * ## Why Mutable?
   *
   * Workflow agents create their primary task group AFTER construction.
   * When the task group is created, updateStorageKey() sets storageKey to the
   * task group ID. This is the single moment of mutation - after that,
   * storageKey remains constant for the execution lifetime.
   *
   * Tool-use agents never call updateStorageKey(), so storageKey remains
   * equal to executionId throughout execution.
   *
   * ## Type Note
   *
   * The getter returns ExecutionIdentity (all readonly). This is intentional -
   * consumers should not be able to mutate the identity directly. The mutable
   * `storageKey` here is an internal implementation detail for the workflow
   * agent lifecycle.
   */
  private _identity: {
    readonly executionId: ExecutionId;
    storageKey: StorageKey;
    readonly streamTabId: StreamTabId;
  };

  constructor(private readonly init: AgentExecutionContextInit) {
    this.logger = new AgentLogger(init.streamId, true);
    this.agentCategory = init.agentCategory ?? AgentCategory.Workflow;
    this.usageReporter = new AgentUsageReporter(
      this.logger,
      init.streamId,
      this.agentCategory,
    );

    // Generate executionId if not provided (always a UUID)
    const executionId = init.executionId ?? randomUUID();

    // Initialize identity with executionId as the initial storageKey
    // Workflow agents will call updateStorageKey() when they create
    // their primary task group
    this._identity = {
      executionId,
      storageKey: executionId as StorageKey,
      streamTabId: init.streamId,
    };
  }

  /**
   * The unified execution identity.
   * Use this instead of accessing individual ID fields.
   */
  get identity(): ExecutionIdentity {
    return this._identity;
  }

  /**
   * THE key for storage operations (files, usage, artifacts).
   * This is the single source of truth - use this instead of computing IDs.
   */
  get storageKey(): StorageKey {
    return this._identity.storageKey;
  }

  get streamId(): StreamTabId {
    return this.init.streamId;
  }

  get executionId(): ExecutionId {
    return this._identity.executionId;
  }

  get sessionCategory(): AgentCategory {
    return this.agentCategory;
  }

  /**
   * Update the storage key to a task group ID.
   *
   * Called by workflow agents when they create their primary task group.
   * After this call, all storage operations use the task group ID.
   *
   * This should only be called ONCE per execution, when the primary
   * task group is created. Multiple calls are allowed but logged as warnings.
   *
   * @param taskGroupId - The task group ID to use as the storage key
   */
  updateStorageKey(taskGroupId: string): void {
    if (this._identity.storageKey !== this._identity.executionId) {
      this.logger.warn(
        `Storage key already set to ${this._identity.storageKey}, ` +
          `updating to ${taskGroupId}. This may indicate a bug.`,
      );
    }
    this._identity.storageKey = taskGroupId as StorageKey;
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
