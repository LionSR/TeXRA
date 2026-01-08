// Third-party imports
import { z } from 'zod';

// Local imports - identifiers
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
// Types - import canonical schema as source of truth
import {
  TokenUsageStatsSchema,
  type TokenUsageStats,
} from '@agent/types/UsageTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createSingleValueRunMapSchema } from '@progressView/persistence/schemaUtils';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

// --- Zod Schemas for Usage Stats ---

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

/**
 * Schema for parsing TokenUsageStats with safe number coercion.
 * Uses canonical schema as source of truth - compile-time assertion ensures sync.
 */
const TokenUsageStatsParsingBaseSchema = z.object({
  // Required fields from canonical schema
  inputTokens: FiniteNumber,
  outputTokens: FiniteNumber,
  cost: FiniteNumber,
  // Optional fields from canonical schema (default to 0 for accumulation)
  cacheReadInputTokens: FiniteNumber.optional().default(0),
  cacheCreationInputTokens: FiniteNumber.optional().default(0),
});

const TokenUsageStatsParsingSchema = TokenUsageStatsParsingBaseSchema.catch({
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

// Compile-time assertion: parsing schema output must be assignable to canonical type.
// This fails at compile time if TokenUsageStatsParsingSchema produces incompatible fields.
type _AssertSchemaCompatible =
  z.infer<typeof TokenUsageStatsParsingSchema> extends TokenUsageStats
    ? true
    : never;
void (true as _AssertSchemaCompatible);

// Runtime assertion: ensure all canonical keys are handled
const canonicalKeys = TokenUsageStatsSchema.keyof().options;
const parsingKeys = new Set(Object.keys(TokenUsageStatsParsingBaseSchema.shape));
const missingKeys = canonicalKeys.filter((k) => !parsingKeys.has(k));
if (missingKeys.length > 0) {
  throw new Error(
    `TokenUsageStatsParsingSchema missing keys from canonical schema: ${missingKeys.join(', ')}`,
  );
}

/** Checks if usage stats are all zeros (effectively empty) */
function isEmptyUsage(usage: TokenUsageStats): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cost === 0 &&
    (usage.cacheReadInputTokens ?? 0) === 0 &&
    (usage.cacheCreationInputTokens ?? 0) === 0
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
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.USAGE_STATS, storage);
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Accumulate usage statistics for a stream (adds deltas to existing values).
   * Returns the accumulated value to avoid race conditions from separate read.
   * @param storageKey - THE key for storage operations
   * @returns The accumulated usage, or undefined if delta was empty
   */
  async setRunUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): Promise<TokenUsageStats | undefined> {
    const delta = TokenUsageStatsParsingSchema.parse(usage);
    const current =
      this.items.get(stream) ?? new Map<string, TokenUsageStats>();

    if (isEmptyUsage(delta)) {
      // Empty delta means nothing to add - return existing if any
      return current.get(storageKey);
    }

    // Accumulate: add delta to existing values
    const existing = current.get(storageKey);
    const accumulated: TokenUsageStats = {
      inputTokens: (existing?.inputTokens ?? 0) + delta.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + delta.outputTokens,
      cost: (existing?.cost ?? 0) + delta.cost,
      cacheReadInputTokens:
        (existing?.cacheReadInputTokens ?? 0) +
        (delta.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens:
        (existing?.cacheCreationInputTokens ?? 0) +
        (delta.cacheCreationInputTokens ?? 0),
    };

    current.set(storageKey, accumulated);
    this.items.set(stream, current);

    await this.save();
    return accumulated;
  }

  /**
   * Get usage statistics for a stream (returns a copy of the map)
   */
  getRunUsage(stream: StreamTabId): RunUsageMap {
    return new Map(this.items.get(stream) ?? []);
  }

  /**
   * Get usage for a specific key without copying the entire map.
   * More efficient for single-key lookups in read-only scenarios
   * (e.g., refreshStreamSurface bulk updates, displaying current usage).
   */
  getUsageForKey(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): TokenUsageStats | undefined {
    return this.items.get(stream)?.get(storageKey);
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
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;

    for (const usage of runs.values()) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cost += usage.cost;
      cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
      cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    }

    return {
      inputTokens,
      outputTokens,
      cost,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    };
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
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;

    for (const usage of this.items.values()) {
      for (const runUsage of usage.values()) {
        inputTokens += runUsage.inputTokens;
        outputTokens += runUsage.outputTokens;
        cost += runUsage.cost;
        cacheReadInputTokens += runUsage.cacheReadInputTokens ?? 0;
        cacheCreationInputTokens += runUsage.cacheCreationInputTokens ?? 0;
      }
    }

    return {
      inputTokens,
      outputTokens,
      cost,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    };
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
    return mapToRecord(value);
  }

  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<RunUsageMap> {
    return UsageDataSchema.parse(data);
  }
}
