// Local imports - identifiers
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
type RunUsageMap = Map<string, TokenUsageStats>;

/** Stream ID used for migrated legacy data */
const LEGACY_MIGRATION_STREAM = '_legacy_migrated_' as StreamTabId;
/** Run ID used for migrated legacy data */
const LEGACY_MIGRATION_RUN_ID = '_migrated_run_';

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
   * @param storageKey - THE key for storage operations
   */
  async setRunUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): Promise<void> {
    const normalized = this.sanitizeUsage(usage);
    const current =
      this.items.get(stream) ?? new Map<string, TokenUsageStats>();
    if (
      normalized.inputTokens === 0 &&
      normalized.outputTokens === 0 &&
      normalized.cost === 0
    ) {
      current.delete(storageKey);
    } else {
      current.set(storageKey, normalized);
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
   * @param storageKey - THE key for storage operations
   */
  async deleteRunUsage(stream: StreamTabId, storageKey: StorageKey): Promise<void> {
    const existing = this.items.get(stream);
    if (!existing) {
      return;
    }

    existing.delete(storageKey);
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

    // Migrate orphaned texra.runUsage data (legacy key never loaded before)
    await this.migrateLegacyRunUsage();

    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  /**
   * Migrates orphaned data from legacy texra.runUsage key.
   * This key was defined but never loaded, leaving data orphaned.
   * Extracts totals and stores under a _legacy_ stream, then deletes the old key.
   */
  private async migrateLegacyRunUsage(): Promise<void> {
    const LEGACY_KEY = 'texra.runUsage';

    interface LegacyRunUsageTotals {
      totalInputTokens?: number;
      totalOutputTokens?: number;
      totalCost?: number;
    }

    interface LegacyAgentRunStateJSON {
      usageAccumulator?: {
        totals?: LegacyRunUsageTotals;
      };
    }

    const legacy = this.storage.get<LegacyAgentRunStateJSON>(LEGACY_KEY);
    if (!legacy?.usageAccumulator?.totals) {
      return;
    }

    const totals = legacy.usageAccumulator.totals;
    const usage: TokenUsageStats = this.sanitizeUsage({
      inputTokens: totals.totalInputTokens ?? 0,
      outputTokens: totals.totalOutputTokens ?? 0,
      cost: totals.totalCost ?? 0,
    });

    // Skip if no meaningful data
    if (
      usage.inputTokens === 0 &&
      usage.outputTokens === 0 &&
      usage.cost === 0
    ) {
      await this.storage.update(LEGACY_KEY, undefined as never);
      return;
    }

    // Store under legacy migration identifiers
    const existing =
      this.items.get(LEGACY_MIGRATION_STREAM) ??
      new Map<string, TokenUsageStats>();
    existing.set(LEGACY_MIGRATION_RUN_ID, usage);
    this.items.set(LEGACY_MIGRATION_STREAM, existing);

    // Save migrated data and clean up legacy key
    await this.save();
    await this.storage.update(LEGACY_KEY, undefined as never);

    this.logger.info(
      `Migrated legacy usage data: ${usage.inputTokens} input, ${usage.outputTokens} output, $${usage.cost.toFixed(4)} cost`,
    );
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
