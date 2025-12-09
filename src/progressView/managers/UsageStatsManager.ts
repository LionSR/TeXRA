// Third-party imports
import { z } from 'zod';

// Local imports - identifiers
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
// Types - import canonical type (schema defines structure)
import {
  type PersistedUsageStats,
  PersistedUsageStatsSchema,
} from '@agent/types/UsageTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createSingleValueRunMapSchema } from '@progressView/persistence/schemaUtils';

// --- Zod Schemas for Usage Stats ---

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

/** Coerces optional number, defaulting non-finite values to undefined */
const OptionalFiniteNumber = z
  .union([z.number(), z.undefined()])
  .transform((n) => (n !== undefined && Number.isFinite(n) ? n : undefined));

/**
 * Schema for parsing PersistedUsageStats with safe number coercion.
 * Extends the canonical schema shape with coercion for persistence resilience.
 * Supports both legacy (3-field) and extended (10-field) formats.
 */
const PersistedUsageStatsParsingSchema = z
  .object({
    // Required fields (always present)
    inputTokens: FiniteNumber,
    outputTokens: FiniteNumber,
    cost: FiniteNumber,
    // Extended fields (optional, may not be present in legacy data)
    responseTimeMs: OptionalFiniteNumber,
    cachedInputTokens: OptionalFiniteNumber,
    cacheCreationTokens: OptionalFiniteNumber,
    percentageCached: OptionalFiniteNumber,
    reasoningTokens: OptionalFiniteNumber,
    toolUsePromptTokens: OptionalFiniteNumber,
    serverToolRequests: OptionalFiniteNumber,
  })
  .catch({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    responseTimeMs: undefined,
    cachedInputTokens: undefined,
    cacheCreationTokens: undefined,
    percentageCached: undefined,
    reasoningTokens: undefined,
    toolUsePromptTokens: undefined,
    serverToolRequests: undefined,
  });

// Compile-time assertion: ensure parsing schema produces type compatible with PersistedUsageStats
type _AssertSchemaCompatible =
  z.infer<typeof PersistedUsageStatsParsingSchema> extends PersistedUsageStats
    ? true
    : never;
const _assertCompatible: _AssertSchemaCompatible = true;

/** Checks if usage stats are all zeros (effectively empty) */
function isEmptyUsage(usage: PersistedUsageStats): boolean {
  return (
    usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cost === 0
  );
}

/** Keys for optional extended metrics that get summed during aggregation */
const EXTENDED_METRIC_KEYS = [
  'responseTimeMs',
  'cachedInputTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'toolUsePromptTokens',
  'serverToolRequests',
] as const;

type ExtendedMetricKey = (typeof EXTENDED_METRIC_KEYS)[number];

/**
 * Aggregates multiple usage stats into a single total.
 * Sums all numeric fields; computes percentageCached from aggregated cache values.
 */
function aggregateUsageStats(
  usageItems: Iterable<PersistedUsageStats>,
): PersistedUsageStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  const extendedTotals: Record<ExtendedMetricKey, number> = {
    responseTimeMs: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    toolUsePromptTokens: 0,
    serverToolRequests: 0,
  };
  let hasExtendedMetrics = false;

  for (const usage of usageItems) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cost += usage.cost;

    for (const key of EXTENDED_METRIC_KEYS) {
      const value = usage[key];
      if (value !== undefined) {
        extendedTotals[key] += value;
        hasExtendedMetrics = true;
      }
    }
  }

  // Calculate percentageCached from aggregated cache values
  const totalCacheableTokens =
    extendedTotals.cachedInputTokens + extendedTotals.cacheCreationTokens;
  const percentageCached =
    hasExtendedMetrics && totalCacheableTokens > 0
      ? (extendedTotals.cachedInputTokens / totalCacheableTokens) * 100
      : undefined;

  return {
    inputTokens,
    outputTokens,
    cost,
    ...(hasExtendedMetrics && {
      responseTimeMs: extendedTotals.responseTimeMs || undefined,
      cachedInputTokens: extendedTotals.cachedInputTokens || undefined,
      cacheCreationTokens: extendedTotals.cacheCreationTokens || undefined,
      percentageCached,
      reasoningTokens: extendedTotals.reasoningTokens || undefined,
      toolUsePromptTokens: extendedTotals.toolUsePromptTokens || undefined,
      serverToolRequests: extendedTotals.serverToolRequests || undefined,
    }),
  };
}

/** Schema for run map format: { runId: PersistedUsageStats } */
const UsageDataSchema = createSingleValueRunMapSchema(
  PersistedUsageStatsParsingSchema,
  {
    isEmpty: isEmptyUsage,
  },
);

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
type RunUsageMap = Map<string, PersistedUsageStats>;

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
    usage: PersistedUsageStats,
  ): Promise<void> {
    const normalized = PersistedUsageStatsParsingSchema.parse(usage);
    const current =
      this.items.get(stream) ?? new Map<string, PersistedUsageStats>();
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
  async deleteRunUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Promise<void> {
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
   * Get total usage across all runs for a stream.
   * Returns aggregate totals; extended metrics are summed where available.
   */
  getStreamTotals(stream: StreamTabId): PersistedUsageStats | undefined {
    const runs = this.items.get(stream);
    if (!runs || runs.size === 0) {
      return undefined;
    }
    return aggregateUsageStats(runs.values());
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
    stats:
      | Map<StreamTabId, RunUsageMap>
      | Map<StreamTabId, PersistedUsageStats>,
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

      const usage = PersistedUsageStatsParsingSchema.parse(value);
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
   * Calculate total usage across all streams.
   * Returns aggregate totals; extended metrics are summed where available.
   */
  getTotalUsage(): PersistedUsageStats {
    const items = this.items;
    const allUsage = (function* () {
      for (const runMap of items.values()) {
        yield* runMap.values();
      }
    })();

    return aggregateUsageStats(allUsage);
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
    const usage: PersistedUsageStats = PersistedUsageStatsParsingSchema.parse({
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
      new Map<string, PersistedUsageStats>();
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
    return UsageDataSchema.parse(data);
  }
}
