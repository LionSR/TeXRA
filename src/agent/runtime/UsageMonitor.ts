import type { AgentTrace } from '@agent/trace';
import type { ConfigProvider } from '@platform/interfaces';
import type {
  AgentCategory,
  NormalizedUsage,
  RunId,
  RunUsageTotals,
} from '@shared/schemas';
import type { UsageLog } from '@shared/usageLog';
import { roundTo } from '@utils/core';
import type { ModelConfig } from 'llm-zoo';

/**
 * Metadata for usage logging. Required because `agentCategory` is billed
 * with every round — a silent default would misreport usage runs from a
 * future caller that forgot to set it.
 */
interface UsageMonitorMetadata {
  /** Agent name for backend logging */
  agentName: string;
  /** Agent category: workflow or toolUse */
  agentCategory: AgentCategory;
}

/**
 * Minimal model info needed for usage logging: the name the backend bills
 * the round under.
 */
type UsageMonitorModelInfo = Pick<ModelConfig, 'fullName'>;

/**
 * Runtime dependencies for UsageMonitor — the individual run facts it reads,
 * never a whole run context:
 *
 * - logger: For error logging
 * - runId: The run whose usage this is (immutable)
 */
interface UsageMonitorContext {
  logger: AgentTrace;
  runId: RunId;
  /** The run's workspace configuration, which usage logging reads consent from. */
  config: ConfigProvider;
  usageLog: UsageLog['Service'];
}

/**
 * Reports each priced round to the usage log, which bills per round. It
 * writes no session row: the round's usage is its `model.message` response
 * row, and every display of it is a projection of that row.
 */
export class UsageMonitor {
  constructor(
    private readonly context: UsageMonitorContext,
    private readonly metadata: UsageMonitorMetadata,
  ) {}

  /**
   * Record one round's usage against `bound`, the run's binding that served
   * it. `totals` are the run's folded totals after the round; `latestUsage`
   * is the round's own priced usage. The loop passes the model it actually
   * ran, so a mid-run switch is billed against it without anyone mirroring
   * it back in.
   */
  recordUsage(
    totals: RunUsageTotals,
    latestUsage: NormalizedUsage | null,
    bound: { readonly config: UsageMonitorModelInfo },
  ): void {
    if (!latestUsage) return;
    const cachedInputTokens = latestUsage.cachedInputTokens ?? 0;
    try {
      this.context.usageLog.log(
        {
          model: bound.config.fullName,
          provider: latestUsage.provider,
          agentName: this.metadata.agentName,
          agentCategory: this.metadata.agentCategory,
          // Backend billing always needs a real number, so a provider that
          // reported no cache-miss count is billed the derived estimate
          // (input minus cache-read). Display never guesses: it shows only
          // what a provider reported.
          inputTokens:
            latestUsage.cacheMissInputTokens ??
            Math.max(0, latestUsage.inputTokens - cachedInputTokens),
          outputTokens: latestUsage.outputTokens,
          cost: roundTo(latestUsage.cost, 6),
          responseTimeMs: Math.round(totals.totalResponseTimeMs),
          cachedInputTokens,
          reasoningTokens: latestUsage.reasoningTokens ?? 0,
          usageRoute: latestUsage.usageRoute ?? 'api-key',
          // An external wire key of the usage-log edge function, the same
          // class as the CLI's NDJSON projection keys: the relay's request
          // column is still named `streamId`, so the key stays until that
          // column is renamed to `run_id` (a server-side change, not part of
          // this release). It carries the run id and no stream vocabulary
          // survives behind it.
          streamId: this.context.runId,
        },
        this.context.config,
      );
    } catch (error) {
      // Best-effort billing edge: a failed log never reaches the run loop.
      this.context.logger.warn('Backend usage logging failed', {
        data: error,
      });
    }
  }
}
