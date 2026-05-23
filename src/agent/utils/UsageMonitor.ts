import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRunStateSnapshot } from '@agent/core/AgentState';
import type { RunUsageTotals } from '@agent/core/RunUsageAccumulator';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';
import { shouldUseOpenRouter } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { getServerSideKeyService } from '@auth/serverKeys';
import { toErrorMessage } from '@common/errors';
import { UsageLogService } from '@logger/index';
import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import type { ModelCapabilities, ModelConfig } from 'llm-zoo';

/**
 * Metadata for usage logging. Required because `agentCategory` controls
 * the `runKind` derivation in `recordUsage` — a silent default would
 * misreport usage runs from a future caller that forgot to set it.
 */
export interface UsageMonitorMetadata {
  /** Agent name for backend logging */
  agentName: string;
  /** Agent category: workflow or toolUse */
  agentCategory: AgentCategory;
}

/**
 * Minimal model info needed for usage tracking.
 *
 * This interface captures only the fields UsageMonitor actually uses,
 * eliminating the need to store a full IModelHandler reference.
 * Fields are directly from ModelCapabilities and ModelConfig.
 */
export interface UsageMonitorModelInfo {
  capabilities: Pick<
    ModelCapabilities,
    | 'supportsPromptCaching'
    | 'supportsAutoPromptCaching'
    | 'supportsReasoning'
    | 'cacheDiscountFactor'
  >;
  config: Pick<
    ModelConfig,
    | 'provider'
    | 'name'
    | 'fullName'
    | 'inputPrice'
    | 'openRouterOnly'
    | 'requiresResponsesAPI'
  >;
}

/**
 * Runtime dependencies for UsageMonitor.
 *
 * Takes individual fields instead of full AgentExecutionContext:
 * - logger: For error logging and the workflow-mode `usage` trace event
 * - runtimeHost: For the `updateStreamUsage` progress-view event
 * - storageKey: The storage key for this execution (immutable)
 * - streamId: For backend logging
 */
export interface UsageMonitorContext {
  logger: AgentTrace;
  runtimeHost: AgentRuntimeHost;
  storageKey: StorageKey;
  streamId: StreamTabId;
}

/**
 * Handles recording usage statistics to the log and progress view.
 *
 * Cost is computed once during normalization and stored in the accumulator.
 * This class simply reads the pre-computed totals - no cost recomputation needed.
 */
type UsageMonitorRunKind = 'workflow' | 'tool-use';

export class UsageMonitor {
  /**
   * Active group ID for statistics logging.
   * When set, statistics are logged with this group ID instead of storageKey.
   * This allows statistics to be associated with individual rounds (r0, r1)
   * rather than the parent stage.
   */
  private activeGroupId: string | undefined;

  constructor(
    private modelInfo: UsageMonitorModelInfo,
    private readonly context: UsageMonitorContext,
    private readonly metadata: UsageMonitorMetadata,
  ) {}

  setModelInfo(modelInfo: UsageMonitorModelInfo): void {
    this.modelInfo = modelInfo;
  }

  /**
   * Set the active group ID for statistics logging.
   * Call this when entering a new round to associate statistics with that round.
   *
   * @param groupId - The round stage ID (e.g., r0, r1) or undefined to use storageKey
   */
  setActiveGroupId(groupId: string | undefined): void {
    this.activeGroupId = groupId;
  }

  async recordUsage(stateGlobal: AgentRunStateSnapshot): Promise<void> {
    const { logger, runtimeHost, storageKey, streamId } = this.context;
    const { agentCategory } = this.metadata;
    const runKind: UsageMonitorRunKind =
      agentCategory === AgentCategory.ToolUse ? 'tool-use' : 'workflow';

    try {
      const totals = stateGlobal.usageAccumulator.totals;
      const latestUsage =
        stateGlobal.usageAccumulator.normalizedSnapshots.at(-1)?.usage;

      // Per-round usage - sent to both UI (for accumulation) and backend analytics
      const roundInputTokens = latestUsage?.inputTokens ?? 0;
      const roundOutputTokens = latestUsage?.outputTokens ?? 0;
      const roundCacheReadTokens = latestUsage?.cachedInputTokens ?? 0;
      const roundCacheMissTokens = latestUsage?.cacheMissInputTokens;
      const roundCacheMissTokensForDisplay = roundCacheMissTokens ?? 0;
      const roundCacheCreationTokens = latestUsage?.cacheCreationTokens ?? 0;
      const roundReasoningTokens = latestUsage?.reasoningTokens ?? 0;
      const roundCost = latestUsage?.cost ?? 0;
      const toolUseTokens = latestUsage?.toolUsePromptTokens ?? 0;

      const { capabilities } = this.modelInfo;
      const supportsCaching =
        capabilities.supportsPromptCaching ||
        capabilities.supportsAutoPromptCaching;

      // Calculate cache percentage for display
      const percentageCached = this.calculateCachePercentage(
        supportsCaching,
        totals,
      );

      // Build payload for UI
      const payload: ExtendedTokenUsageStats = {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cost: Number(roundCost.toFixed(3)),
        elapsedTime: Number(
          (stateGlobal.totalResponseTimeMs / 1000).toFixed(1),
        ),
        ...(roundCacheReadTokens > 0 && {
          cacheReadInputTokens: roundCacheReadTokens,
        }),
        ...(roundCacheMissTokensForDisplay > 0 && {
          cacheMissInputTokens: roundCacheMissTokensForDisplay,
        }),
        ...(roundCacheCreationTokens > 0 && {
          cacheCreationInputTokens: roundCacheCreationTokens,
        }),
        ...(supportsCaching && {
          percentageCached: Number(percentageCached.toFixed(2)),
        }),
        ...(capabilities.supportsReasoning && {
          reasoningTokens: roundReasoningTokens,
        }),
        ...(toolUseTokens > 0 && { toolUseTokens }),
      };

      // Two surfaces for usage: the progress-view sidebar (via runtimeHost
      // event) and — for workflow agents — the transcript's statistics line
      // (via the trace channel). Tool-use agents skip the transcript copy
      // because their UI surface is the tool-use cards, not a stats line.
      runtimeHost.emit('updateStreamUsage', {
        streamId,
        storageKey,
        usage: payload,
      });
      if (agentCategory === AgentCategory.Workflow) {
        logger.usage(payload, {
          stageId: this.activeGroupId ?? storageKey,
        });
      }

      // Log to backend for analytics (non-blocking, fire-and-forget)
      this.logToBackend(stateGlobal.totalResponseTimeMs, {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCacheReadTokens,
        ...(roundCacheMissTokens != null && {
          cacheMissInputTokens: roundCacheMissTokens,
        }),
        cacheCreationInputTokens: roundCacheCreationTokens,
        reasoningTokens: roundReasoningTokens,
        cost: roundCost,
      });
    } catch (error) {
      logger.error(
        `Error printing ${runKind} statistics: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Calculate cache percentage based on model capabilities and totals.
   */
  private calculateCachePercentage(
    supportsCaching: boolean,
    totals: RunUsageTotals,
  ): number {
    if (!supportsCaching) return 0;

    const totalCacheableTokens = this.modelInfo.capabilities
      .supportsPromptCaching
      ? totals.totalCacheCreationInputTokens + totals.totalCacheReadInputTokens
      : totals.totalInputTokens;

    if (totalCacheableTokens === 0) return 0;
    return (totals.totalCacheReadInputTokens / totalCacheableTokens) * 100;
  }

  /**
   * Log per-round usage to backend for analytics/billing.
   * Non-blocking - errors are caught and logged, never thrown.
   */
  private logToBackend(
    totalResponseTimeMs: number,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheMissInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
      cost: number;
    },
  ): void {
    try {
      const { config } = this.modelInfo;
      const provider = UsageProviderSchema.catch('unknown').parse(
        config.provider.toLowerCase(),
      );
      const cachedInputTokens = usage.cachedInputTokens ?? 0;
      const cacheMissInputTokens =
        usage.cacheMissInputTokens ??
        Math.max(0, usage.inputTokens - cachedInputTokens);

      UsageLogService.log({
        model: config.fullName,
        provider,
        agentName: this.metadata.agentName,
        agentCategory: this.metadata.agentCategory,
        inputTokens: cacheMissInputTokens,
        outputTokens: usage.outputTokens,
        cost: Number(usage.cost.toFixed(6)),
        responseTimeMs: Math.round(totalResponseTimeMs),
        cachedInputTokens,
        ...(usage.cacheMissInputTokens != null && {
          cacheMissInputTokens: usage.cacheMissInputTokens,
        }),
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        usedRelay:
          !shouldUseOpenRouter(config) &&
          getServerSideKeyService().shouldUseServerSideKeysSync(
            config.provider,
            config.name,
          ),
        streamId: this.context.streamId,
      });
    } catch (error) {
      this.context.logger.debug(
        `Backend usage logging failed: ${toErrorMessage(error)}`,
      );
    }
  }
}
