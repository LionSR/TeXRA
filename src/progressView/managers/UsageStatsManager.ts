import { z } from 'zod';

import {
  TokenUsageStatsSchema,
  type StorageKey,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createSingleValueRunMapSchema } from '@progressView/persistence/schemaUtils';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

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
  cacheReadInputTokens: FiniteNumber.optional().prefault(0),
  cacheCreationInputTokens: FiniteNumber.optional().prefault(0),
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
const parsingKeys = new Set(
  Object.keys(TokenUsageStatsParsingBaseSchema.shape),
);
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

/** Returns zero-initialized usage stats */
function emptyUsageStats(): TokenUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/** Accumulates usage stats from an iterable into a single total */
function sumUsageStats(items: Iterable<TokenUsageStats>): TokenUsageStats {
  const total = emptyUsageStats();
  for (const usage of items) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cost += usage.cost;
    total.cacheReadInputTokens! += usage.cacheReadInputTokens ?? 0;
    total.cacheCreationInputTokens! += usage.cacheCreationInputTokens ?? 0;
  }
  return total;
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
    const existing = current.get(storageKey) ?? emptyUsageStats();
    const accumulated = sumUsageStats([existing, delta]);

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

  protected override deserialize(
    data: unknown,
    _key: StreamTabId,
  ): RunUsageMap {
    return UsageDataSchema.parse(data);
  }
}
