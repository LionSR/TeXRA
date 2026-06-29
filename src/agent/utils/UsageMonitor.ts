import { UsageLogService } from '@telemetry/UsageLogService';
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRunStateSnapshot } from '@agent/core/state/AgentState';
import type { RunUsageTotals } from '@agent/core/usage/RunUsageAccumulator';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';
import { shouldUseOpenRouter } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { getServerSideKeyService } from '@auth/serverKeys';
import { toErrorMessage } from '@common/errors';
import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import { roundTo } from '@utils/core';
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
   * The most recent run totals seen by {@link recordUsage}. Cached so a failed
   * run can still report usage on its terminal `result` event (the catch arm
   * has no flow result to read totals from). Undefined before the first round.
   */
  private lastSeenTotals: RunUsageTotals | undefined;

  constructor(
    private modelInfo: UsageMonitorModelInfo,
    private readonly context: UsageMonitorContext,
    private readonly metadata: UsageMonitorMetadata,
  ) {}

  setModelInfo(modelInfo: UsageMonitorModelInfo): void {
    this.modelInfo = modelInfo;
  }

  /** The last run totals recorded this run, or undefined before any round. */
  lastTotals(): RunUsageTotals | undefined {
    return this.lastSeenTotals;
  }

  async recordUsage(stateGlobal: AgentRunStateSnapshot): Promise<void> {
    const { logger, runtimeHost, storageKey, streamId } = this.context;
    const { agentCategory } = this.metadata;
    const runKind: UsageMonitorRunKind =
      agentCategory === AgentCategory.ToolUse ? 'tool-use' : 'workflow';

    try {
      const totals = stateGlobal.usageAccumulator.totals;
      this.lastSeenTotals = totals;
      const latestUsage = stateGlobal.usageAccumulator.latestUsage;

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
      const viaChatGptSubscription =
        latestUsage?.viaChatGptSubscription ?? false;

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
        cost: roundTo(roundCost, 3),
        elapsedTime: roundTo(stateGlobal.totalResponseTimeMs / 1000, 1),
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
          percentageCached: roundTo(percentageCached, 2),
        }),
        ...(capabilities.supportsReasoning && {
          reasoningTokens: roundReasoningTokens,
        }),
        ...(toolUseTokens > 0 && { toolUseTokens }),
        ...(viaChatGptSubscription && { viaChatGptSubscription: true }),
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
        const transcriptPayload: Record<string, number> = {};
        for (const [key, value] of Object.entries(payload)) {
          if (typeof value === 'number') transcriptPayload[key] = value;
        }
        // The round stage's AsyncLocalStorage scope already stamps the active
        // round id (r0/r1...) onto emitted events; fall back to storageKey for
        // any usage logged outside a round stage.
        logger.usage(transcriptPayload, {
          stageId: logger.activeStageId() ?? storageKey,
        });
      }

      // Log to backend for analytics/billing. Relay-backed rounds wait for the
      // flush because the next relay request enforces the cap from DB state.
      await this.logToBackend(stateGlobal.totalResponseTimeMs, {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCacheReadTokens,
        ...(roundCacheMissTokens != null && {
          cacheMissInputTokens: roundCacheMissTokens,
        }),
        cacheCreationInputTokens: roundCacheCreationTokens,
        reasoningTokens: roundReasoningTokens,
        cost: roundCost,
        // Free ChatGPT-subscription round: still logged (cost is 0), but marked
        // so analytics can tell it apart from any other zero-cost row.
        viaChatGptSubscription,
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
   * Errors are caught and logged, never thrown.
   */
  private async logToBackend(
    totalResponseTimeMs: number,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheMissInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
      cost: number;
      viaChatGptSubscription?: boolean;
    },
  ): Promise<void> {
    try {
      const { config } = this.modelInfo;
      const provider = UsageProviderSchema.catch('unknown').parse(
        config.provider.toLowerCase(),
      );
      const cachedInputTokens = usage.cachedInputTokens ?? 0;
      const cacheMissInputTokens =
        usage.cacheMissInputTokens ??
        Math.max(0, usage.inputTokens - cachedInputTokens);

      const usedRelay =
        !usage.viaChatGptSubscription &&
        !shouldUseOpenRouter(config) &&
        getServerSideKeyService().shouldUseServerSideKeysSync(
          config.provider,
          config.name,
        );

      UsageLogService.log({
        model: config.fullName,
        provider,
        agentName: this.metadata.agentName,
        agentCategory: this.metadata.agentCategory,
        inputTokens: cacheMissInputTokens,
        outputTokens: usage.outputTokens,
        cost: roundTo(usage.cost, 6),
        responseTimeMs: Math.round(totalResponseTimeMs),
        cachedInputTokens,
        ...(usage.cacheMissInputTokens != null && {
          cacheMissInputTokens: usage.cacheMissInputTokens,
        }),
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        usedRelay,
        ...(usage.viaChatGptSubscription && {
          viaChatGptSubscription: true,
        }),
        streamId: this.context.streamId,
      });

      // The relay enforces the monthly spend cap from the server-side usage
      // total, which is only as fresh as the last flush (otherwise batched
      // every ~30s / 10 entries). For relay rounds, flush now so the relay's
      // pre-call check sees this round's cost before the next call — bounding
      // free-tier overage to roughly one round instead of a whole session.
      if (usedRelay) {
        const flushed = await UsageLogService.flush();
        if (!flushed) {
          this.context.logger.debug(
            'Relay usage logging is queued; spend-cap data will retry later.',
          );
        }
      }
    } catch (error) {
      this.context.logger.debug(
        `Backend usage logging failed: ${toErrorMessage(error)}`,
      );
    }
  }
}
