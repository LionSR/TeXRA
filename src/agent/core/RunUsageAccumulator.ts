// Local imports - types
import type {
  NormalizedUsage,
  UsageProvider,
} from '@agent/types/NormalizedUsage';

// Re-export for backwards compatibility (used in AgentState legacy schema)
import type {
  AnthropicAPIResponseUsage,
  OpenAIAPIResponseUsage,
  NativeUsagePayload,
} from './ResponseUsage';

export type { NativeUsagePayload };

/**
 * @deprecated Used only for legacy JSON deserialization
 */
export type UsageSummary =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage
  | null;

/**
 * @deprecated Legacy snapshot format - used only for migration
 */
interface LegacyNativeUsageSnapshot {
  round: number;
  provider: string;
  payload: unknown;
}

/**
 * Snapshot of normalized usage for a single round.
 */
export interface NormalizedUsageSnapshot {
  round: number;
  usage: NormalizedUsage;
}

export interface RunUsageTotals {
  firstInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningTokens: number;
  totalToolUsePromptTokens: number;
  totalServerToolRequests: number;
}

export interface RunUsageAccumulatorJSON {
  totals: Partial<RunUsageTotals> & {
    /** @deprecated Legacy field name */
    totalToolUseTokens?: number;
  };
  normalizedSnapshots?: NormalizedUsageSnapshot[];
  /** @deprecated Legacy format - ignored on load */
  snapshots?: unknown[];
}

const DEFAULT_TOTALS: RunUsageTotals = {
  firstInputTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  totalReasoningTokens: 0,
  totalToolUsePromptTokens: 0,
  totalServerToolRequests: 0,
};

export class RunUsageAccumulator {
  private totals: RunUsageTotals = { ...DEFAULT_TOTALS };
  private readonly normalizedSnapshots: NormalizedUsageSnapshot[] = [];

  /**
   * Records normalized usage from a model response.
   */
  recordNormalizedUsage(round: number, usage: NormalizedUsage): void {
    if (this.totals.firstInputTokens === 0) {
      // Include cached tokens in first input count (Anthropic reports them separately)
      this.totals.firstInputTokens =
        usage.inputTokens +
        (usage.cachedInputTokens ?? 0) +
        (usage.cacheCreationTokens ?? 0);
    }

    this.totals.totalInputTokens += usage.inputTokens;
    this.totals.totalOutputTokens += usage.outputTokens;
    this.totals.totalCost += usage.cost;
    this.totals.totalCacheReadInputTokens += usage.cachedInputTokens ?? 0;
    this.totals.totalCacheCreationInputTokens += usage.cacheCreationTokens ?? 0;
    this.totals.totalReasoningTokens += usage.reasoningTokens ?? 0;
    this.totals.totalToolUsePromptTokens += usage.toolUsePromptTokens ?? 0;
    this.totals.totalServerToolRequests += usage.serverToolRequests ?? 0;

    this.normalizedSnapshots.push({ round, usage });
  }

  merge(other: RunUsageAccumulator): void {
    const otherTotals = other.getTotals();
    if (this.totals.firstInputTokens === 0) {
      this.totals.firstInputTokens = otherTotals.firstInputTokens;
    }

    this.totals.totalInputTokens += otherTotals.totalInputTokens;
    this.totals.totalOutputTokens += otherTotals.totalOutputTokens;
    this.totals.totalCost += otherTotals.totalCost;
    this.totals.totalCacheReadInputTokens +=
      otherTotals.totalCacheReadInputTokens;
    this.totals.totalCacheCreationInputTokens +=
      otherTotals.totalCacheCreationInputTokens;
    this.totals.totalReasoningTokens += otherTotals.totalReasoningTokens;
    this.totals.totalToolUsePromptTokens +=
      otherTotals.totalToolUsePromptTokens;
    this.totals.totalServerToolRequests += otherTotals.totalServerToolRequests;

    this.normalizedSnapshots.push(...other.getNormalizedSnapshots());
  }

  getTotals(): RunUsageTotals {
    return { ...this.totals };
  }

  getNormalizedSnapshots(): NormalizedUsageSnapshot[] {
    return [...this.normalizedSnapshots];
  }

  toJSON(): RunUsageAccumulatorJSON {
    return {
      totals: this.getTotals(),
      normalizedSnapshots: this.getNormalizedSnapshots(),
    };
  }

  static fromJSON(
    json: RunUsageAccumulatorJSON | null | undefined,
  ): RunUsageAccumulator {
    const acc = new RunUsageAccumulator();
    if (!json) return acc;

    const t = json.totals;
    acc.totals = {
      firstInputTokens: t.firstInputTokens ?? 0,
      totalInputTokens: t.totalInputTokens ?? 0,
      totalOutputTokens: t.totalOutputTokens ?? 0,
      totalCost: t.totalCost ?? 0,
      totalCacheReadInputTokens: t.totalCacheReadInputTokens ?? 0,
      totalCacheCreationInputTokens: t.totalCacheCreationInputTokens ?? 0,
      totalReasoningTokens: t.totalReasoningTokens ?? 0,
      // Handle legacy field name
      totalToolUsePromptTokens:
        t.totalToolUsePromptTokens ?? t.totalToolUseTokens ?? 0,
      totalServerToolRequests: t.totalServerToolRequests ?? 0,
    };

    if (json.normalizedSnapshots) {
      acc.normalizedSnapshots.push(...json.normalizedSnapshots);
    }
    // Migrate legacy snapshots format to normalized format
    else if (json.snapshots && Array.isArray(json.snapshots)) {
      for (const snap of json.snapshots as LegacyNativeUsageSnapshot[]) {
        const migrated = migrateLegacySnapshot(snap);
        if (migrated) {
          acc.normalizedSnapshots.push(migrated);
        }
      }
    }

    return acc;
  }
}

/**
 * Migrates a legacy native usage snapshot to normalized format.
 * Extracts tokens from native payload; cost cannot be recovered (depends on pricing).
 */
function migrateLegacySnapshot(
  legacy: LegacyNativeUsageSnapshot,
): NormalizedUsageSnapshot | null {
  if (!legacy.payload || typeof legacy.payload !== 'object') {
    return null;
  }

  const payload = legacy.payload as Record<string, unknown>;
  const provider = (legacy.provider || 'unknown') as UsageProvider;

  // Try to detect payload format and extract tokens
  // Anthropic format: input_tokens, output_tokens
  if ('input_tokens' in payload) {
    return {
      round: legacy.round,
      usage: {
        inputTokens: (payload.input_tokens as number) ?? 0,
        outputTokens: (payload.output_tokens as number) ?? 0,
        cost: 0, // Cannot recover - depends on pricing at time of request
        responseTimeMs: 0,
        provider,
        cachedInputTokens:
          (payload.cache_read_input_tokens as number) ?? undefined,
        cacheCreationTokens:
          (payload.cache_creation_input_tokens as number) ?? undefined,
        _native: payload,
      },
    };
  }

  // OpenAI format: prompt_tokens, completion_tokens
  if ('prompt_tokens' in payload) {
    const details = payload.prompt_tokens_details as
      | Record<string, unknown>
      | undefined;
    const completionDetails = payload.completion_tokens_details as
      | Record<string, unknown>
      | undefined;
    return {
      round: legacy.round,
      usage: {
        inputTokens: (payload.prompt_tokens as number) ?? 0,
        outputTokens: (payload.completion_tokens as number) ?? 0,
        cost: 0, // Cannot recover - depends on pricing at time of request
        responseTimeMs: 0,
        provider,
        cachedInputTokens: (details?.cached_tokens as number) ?? undefined,
        reasoningTokens:
          (completionDetails?.reasoning_tokens as number) ?? undefined,
        _native: payload,
      },
    };
  }

  // Google format: promptTokenCount, candidatesTokenCount
  if ('promptTokenCount' in payload) {
    return {
      round: legacy.round,
      usage: {
        inputTokens: (payload.promptTokenCount as number) ?? 0,
        outputTokens: (payload.candidatesTokenCount as number) ?? 0,
        cost: 0, // Cannot recover - depends on pricing at time of request
        responseTimeMs: 0,
        provider,
        cachedInputTokens:
          (payload.cachedContentTokenCount as number) ?? undefined,
        reasoningTokens: (payload.thoughtsTokenCount as number) ?? undefined,
        toolUsePromptTokens:
          (payload.toolUsePromptTokenCount as number) ?? undefined,
        _native: payload,
      },
    };
  }

  // Unknown format - create minimal entry preserving native payload
  return {
    round: legacy.round,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      responseTimeMs: 0,
      provider,
      _native: payload,
    },
  };
}
