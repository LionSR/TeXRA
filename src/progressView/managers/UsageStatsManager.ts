// Third-party imports
import { z } from 'zod';

// Local imports - identifiers
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
// Types - import canonical type (schema defines structure)
import { type TokenUsageStats } from '@agent/types/UsageTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { WorkspaceStateKey } from '@common/state/stateManager';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createSingleValueRunMapSchema } from '@progressView/persistence/schemaUtils';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import { ManagerLogger } from './ManagerLogger';

// --- Zod Schemas for Usage Stats ---

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

/**
 * Schema for parsing TokenUsageStats with safe number coercion.
 * Extends the canonical schema shape with coercion for persistence resilience.
 */
const TokenUsageStatsParsingSchema = z
  .object({
    inputTokens: FiniteNumber,
    outputTokens: FiniteNumber,
    cost: FiniteNumber,
  })
  .catch({ inputTokens: 0, outputTokens: 0, cost: 0 });

// Compile-time assertion: ensure parsing schema produces type compatible with TokenUsageStats
type _AssertSchemaCompatible =
  z.infer<typeof TokenUsageStatsParsingSchema> extends TokenUsageStats
    ? true
    : never;
const _assertCompatible: _AssertSchemaCompatible = true;

/** Checks if usage stats are all zeros (effectively empty) */
function isEmptyUsage(usage: TokenUsageStats): boolean {
  return (
    usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cost === 0
  );
}

/** Schema for run map format: { runId: { inputTokens, outputTokens, cost } } */
const UsageDataSchema = createSingleValueRunMapSchema(
  TokenUsageStatsParsingSchema,
  {
    isEmpty: isEmptyUsage,
  },
);

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
type RunUsageMap = Map<string, TokenUsageStats>;

export class UsageStatsManager extends PersistentMapManager<
  StreamTabId,
  RunUsageMap
> {
  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.USAGE_STATS, storage, ['texra.usageStats']);
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
    const normalized = TokenUsageStatsParsingSchema.parse(usage);
    const current =
      this.items.get(stream) ?? new Map<string, TokenUsageStats>();
    if (isEmptyUsage(normalized)) {
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

      const usage = TokenUsageStatsParsingSchema.parse(value);
      if (isEmptyUsage(usage)) {
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
   * Load usage statistics from persistence
   */
  async load(): Promise<void> {
    await super.load();

    if (this.items.size > 0) {
      ManagerLogger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  /** Normalize loaded usage records */
  protected override serialize(value: RunUsageMap, _key: StreamTabId): unknown {
    return mapToRecord(value);
  }

  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<RunUsageMap> {
    return UsageDataSchema.parse(data);
  }
}
