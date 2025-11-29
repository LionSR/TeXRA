// Third-party imports
import { z } from 'zod';

// Local imports - response usage types
import type {
  NormalizedUsage,
  UsageProvider,
} from '@agent/types/NormalizedUsage';
import {
  RunUsageAccumulator,
  type RunUsageAccumulatorJSON,
  type UsageSummary,
  type NativeUsagePayload,
} from './RunUsageAccumulator';

// Type imports
import type {
  AnthropicAPIResponseUsage,
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from './ResponseUsage';

export type NativeResponseUsage =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

/**
 * Migrates legacy UsageSummary format to NormalizedUsage.
 * Extracts provider-specific fields (cached tokens, reasoning tokens, etc.)
 * from the legacy format into the normalized structure.
 */
function migrateLegacyUsageSummary(
  usageSummary: UsageSummary,
  provider: UsageProvider,
  responseTimeMs: number,
  nativeUsage?: NativeUsagePayload | null,
): NormalizedUsage {
  if (!usageSummary) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      responseTimeMs,
      provider,
    };
  }

  const base: NormalizedUsage = {
    inputTokens: usageSummary.totalInputTokens,
    outputTokens: usageSummary.totalOutputTokens,
    cost: usageSummary.cost,
    responseTimeMs,
    provider,
    percentageCached:
      usageSummary.percentageCached > 0
        ? usageSummary.percentageCached
        : undefined,
    _native: nativeUsage ?? undefined,
  };

  // Extract provider-specific fields from legacy format
  if (isAnthropicUsage(usageSummary)) {
    if (usageSummary.cache_read_input_tokens) {
      base.cachedInputTokens = usageSummary.cache_read_input_tokens;
    }
    if (usageSummary.cache_creation_input_tokens) {
      base.cacheCreationTokens = usageSummary.cache_creation_input_tokens;
    }
    if (usageSummary.server_tool_use?.web_search_requests) {
      base.serverToolRequests =
        usageSummary.server_tool_use.web_search_requests;
    }
  } else if (isOpenAIUsage(usageSummary)) {
    if (usageSummary.cached_tokens > 0) {
      base.cachedInputTokens = usageSummary.cached_tokens;
    }
    if (usageSummary.reasoning_tokens > 0) {
      base.reasoningTokens = usageSummary.reasoning_tokens;
    }
    if (usageSummary.tool_use_tokens && usageSummary.tool_use_tokens > 0) {
      base.toolUsePromptTokens = usageSummary.tool_use_tokens;
    }
  }

  return base;
}

function isAnthropicUsage(
  usage: UsageSummary,
): usage is AnthropicAPIResponseUsage {
  return usage !== null && 'input_tokens' in usage;
}

function isOpenAIUsage(usage: UsageSummary): usage is OpenAIAPIResponseUsage {
  return usage !== null && 'prompt_tokens' in usage;
}

export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.number().int().nonnegative(),
  continuationCount: z.number().int().nonnegative(),
  responseTimeMs: z.number().nonnegative(),
  outputFile: z.string(),
  // New: store normalized usage directly (nullish for backward compat with old saved states)
  normalizedUsage: z.custom<NormalizedUsage>().nullish(),
  // Legacy fields for backward compatibility (deprecated)
  usageSummary: z.custom<UsageSummary>().nullable().optional(),
  nativeUsage: z.custom<NativeUsagePayload>().nullable().optional(),
  provider: z.custom<UsageProvider>().nullable().optional(),
});

/**
 * Single source of truth for ConversationRoundState serialization format.
 * Derived from the Zod schema - do not duplicate this definition.
 */
export type ConversationRoundStateSnapshot = z.infer<
  typeof ConversationRoundStateSnapshotSchema
>;

export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount: number;
  public responseTimeMs: number;
  public outputFile: string;
  /** Normalized usage data - the single source of truth */
  public normalizedUsage: NormalizedUsage | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = 0;
    this.responseTimeMs = 0;
    this.outputFile = '';
    this.normalizedUsage = null;
  }

  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  addResponseTime(durationMs: number): void {
    this.responseTimeMs += durationMs;
  }

  /**
   * Sets the normalized usage for this round.
   * This is the preferred method - use normalizeUsage() from the model handler.
   */
  setNormalizedUsage(usage: NormalizedUsage): void {
    this.normalizedUsage = usage;
  }

  clearUsage(): void {
    this.normalizedUsage = null;
  }

  toJSON(): ConversationRoundStateSnapshot {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTimeMs: this.responseTimeMs,
      outputFile: this.outputFile,
      normalizedUsage: this.normalizedUsage,
    };
  }

  static fromJSON(
    json: ConversationRoundStateSnapshot,
  ): ConversationRoundState {
    const state = new ConversationRoundState(json.roundIndex);
    state.continuationCount = json.continuationCount;
    state.responseTimeMs = json.responseTimeMs;
    state.outputFile = json.outputFile;

    // Load normalized usage if available
    if (json.normalizedUsage) {
      state.normalizedUsage = json.normalizedUsage;
    }
    // Legacy: convert old format if present (for backward compatibility)
    else if (json.usageSummary && json.provider) {
      state.normalizedUsage = migrateLegacyUsageSummary(
        json.usageSummary,
        json.provider,
        json.responseTimeMs,
        json.nativeUsage,
      );
    }

    return state;
  }
}

export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.number().int().nonnegative(),
  totalResponseTimeMs: z.number().nonnegative(),
  usageAccumulator: z.custom<RunUsageAccumulatorJSON>(),
});

/**
 * Single source of truth for AgentRunState serialization format.
 * Derived from the Zod schema - do not duplicate this definition.
 */
export type AgentRunStateSnapshot = z.infer<typeof AgentRunStateSnapshotSchema>;

export class AgentRunState {
  public totalRounds: number;
  public totalResponseTimeMs: number;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.totalRounds = 0;
    this.totalResponseTimeMs = 0;
    this.usageAccumulator = accumulator ?? new RunUsageAccumulator();
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  addResponseTime(durationMs: number): void {
    this.totalResponseTimeMs += durationMs;
  }

  /**
   * Records usage from a completed round using normalized usage.
   */
  recordRound(roundState: ConversationRoundState): void {
    if (roundState.normalizedUsage) {
      this.usageAccumulator.recordNormalizedUsage(
        roundState.roundIndex,
        roundState.normalizedUsage,
      );
    }
    this.addResponseTime(roundState.responseTimeMs);
  }

  toJSON(): AgentRunStateSnapshot {
    return {
      totalRounds: this.totalRounds,
      totalResponseTimeMs: this.totalResponseTimeMs,
      usageAccumulator: this.usageAccumulator.toJSON(),
    };
  }

  static fromJSON(
    json: AgentRunStateSnapshot | null | undefined,
  ): AgentRunState {
    if (!json) {
      return new AgentRunState();
    }

    const usageAccumulator = RunUsageAccumulator.fromJSON(
      json.usageAccumulator,
    );
    const state = new AgentRunState(usageAccumulator);
    state.totalRounds = json.totalRounds;
    state.totalResponseTimeMs = json.totalResponseTimeMs;
    return state;
  }
}

export type ProviderUsageSummary =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage;
