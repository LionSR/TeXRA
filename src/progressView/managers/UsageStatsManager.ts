// Local imports - identifiers
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { normalizeRunId } from '@progressView/constants/runIds';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
type RunUsageMap = Map<string, TokenUsageStats>;

export class UsageStatsManager extends PersistentMapManager<
  StreamTabId,
  RunUsageMap
> {
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.USAGE_STATS, storage, ['texra.usageStats']);
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Update usage statistics for a stream
   */
  async setRunUsage(
    stream: StreamTabId,
    runId: string,
    usage: TokenUsageStats,
  ): Promise<void> {
    if (!runId) {
      return;
    }

    const normalized = this.sanitizeUsage(usage);
    const current =
      this.items.get(stream) ?? new Map<string, TokenUsageStats>();
    if (
      normalized.inputTokens === 0 &&
      normalized.outputTokens === 0 &&
      normalized.cost === 0
    ) {
      current.delete(runId);
    } else {
      current.set(runId, normalized);
    }

    if (current.size === 0) {
      this.items.delete(stream);
    } else {
      this.items.set(stream, current);
    }

    await this.save();
  }

  /**
   * Delete usage statistics for a specific run within a stream
   */
  async deleteRunUsage(stream: StreamTabId, runId: string): Promise<void> {
    if (!runId) {
      return;
    }

    const existing = this.items.get(stream);
    if (!existing) {
      return;
    }

    existing.delete(runId);
    if (existing.size === 0) {
      this.items.delete(stream);
    }

    await this.save();
  }

  /**
   * Get usage statistics for a stream
   */
  getRunUsage(stream: StreamTabId): RunUsageMap {
    return new Map(this.items.get(stream) ?? []);
  }

  getUsageRecord(stream: StreamTabId): Record<string, TokenUsageStats> {
    const usage = this.items.get(stream);
    if (!usage || usage.size === 0) {
      return {};
    }

    const record: Record<string, TokenUsageStats> = {};
    for (const [runId, stats] of usage.entries()) {
      record[runId] = stats;
    }
    return record;
  }

  /**
   * Get total usage across all runs for a stream
   */
  getStreamTotals(stream: StreamTabId): TokenUsageStats | undefined {
    const runs = this.items.get(stream);
    if (!runs || runs.size === 0) {
      return undefined;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;

    for (const usage of runs.values()) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cost += usage.cost;
    }

    return { inputTokens, outputTokens, cost };
  }

  /**
   * Delete usage statistics for a stream
   */
  async deleteStream(stream: StreamTabId): Promise<void> {
    await super.delete(stream);
  }

  /**
   * Set all usage statistics (used during loading)
   */
  setAll(
    stats: Map<StreamTabId, RunUsageMap> | Map<StreamTabId, TokenUsageStats>,
  ): void {
    const normalized: Map<StreamTabId, RunUsageMap> = new Map();

    for (const [stream, value] of stats.entries()) {
      if (value instanceof Map) {
        normalized.set(stream, new Map(value));
        continue;
      }

      if (!value || typeof value !== 'object') {
        continue;
      }

      const candidate = value as TokenUsageStats;
      const usage = this.sanitizeUsage(candidate);
      if (
        usage.inputTokens === 0 &&
        usage.outputTokens === 0 &&
        usage.cost === 0
      ) {
        continue;
      }

      const runMap: RunUsageMap = new Map();
      runMap.set(normalizeRunId(null), usage);
      normalized.set(stream, runMap);
    }

    super.setAll(normalized);
  }

  /**
   * Calculate total usage across all streams
   */
  getTotalUsage(): TokenUsageStats {
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;

    for (const usage of this.items.values()) {
      for (const runUsage of usage.values()) {
        inputTokens += runUsage.inputTokens;
        outputTokens += runUsage.outputTokens;
        cost += runUsage.cost;
      }
    }

    return { inputTokens, outputTokens, cost };
  }

  /**
   * Get streams with usage statistics
   */
  getStreamsWithUsage(): StreamTabId[] {
    return this.keys();
  }

  /**
   * Check if stream has usage statistics
   */
  hasUsage(stream: StreamTabId): boolean {
    return this.has(stream);
  }

  /**
   * Load usage statistics from persistence
   */
  async load(): Promise<void> {
    await super.load();
    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  /** Normalize loaded usage records */
  protected override serialize(value: RunUsageMap, _key: StreamTabId): unknown {
    return Object.fromEntries(value.entries());
  }

  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<RunUsageMap> {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const entries = Object.entries(data as Record<string, unknown>);
    const looksLikeRunMap = entries.every(
      ([, value]) => value && typeof value === 'object',
    );

    if (!looksLikeRunMap) {
      const candidate = data as Partial<TokenUsageStats>;
      const normalized = this.sanitizeUsage({
        inputTokens: candidate.inputTokens ?? NaN,
        outputTokens: candidate.outputTokens ?? NaN,
        cost: candidate.cost ?? NaN,
      });
      const map: RunUsageMap = new Map();
      if (
        normalized.inputTokens !== 0 ||
        normalized.outputTokens !== 0 ||
        normalized.cost !== 0
      ) {
        map.set(normalizeRunId(null), normalized);
      }
      return map;
    }

    const runMap: RunUsageMap = new Map();
    for (const [runId, rawUsage] of entries) {
      if (!rawUsage || typeof rawUsage !== 'object') {
        continue;
      }
      const candidate = rawUsage as Partial<TokenUsageStats>;
      runMap.set(
        runId,
        this.sanitizeUsage({
          inputTokens: candidate.inputTokens ?? NaN,
          outputTokens: candidate.outputTokens ?? NaN,
          cost: candidate.cost ?? NaN,
        }),
      );
    }
    return runMap;
  }

  private sanitizeUsage(usage: TokenUsageStats): TokenUsageStats {
    return {
      inputTokens: this.toSafeNumber(usage.inputTokens),
      outputTokens: this.toSafeNumber(usage.outputTokens),
      cost: this.toSafeNumber(usage.cost),
    };
  }

  private toSafeNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }
}
