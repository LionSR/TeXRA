// Third-party imports
import { z } from 'zod';

// Local imports - response usage types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import {
  RunUsageAccumulator,
  RunUsageAccumulatorCodec,
  RunUsageAccumulatorJSONSchema,
} from './RunUsageAccumulator';

// Type imports
import type {
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from './ResponseUsage';

export type NativeResponseUsage =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

/** Default values for ConversationRoundState */
const ROUND_STATE_DEFAULTS = {
  continuationCount: 0,
  responseTimeMs: 0,
  outputFile: '',
  normalizedUsage: null,
} as const;

export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z
    .int()
    .nonnegative()
    .default(ROUND_STATE_DEFAULTS.continuationCount),
  responseTimeMs: z
    .number()
    .nonnegative()
    .default(ROUND_STATE_DEFAULTS.responseTimeMs),
  outputFile: z.string().default(ROUND_STATE_DEFAULTS.outputFile),
  normalizedUsage: NormalizedUsageSchema.nullish().default(
    ROUND_STATE_DEFAULTS.normalizedUsage,
  ),
});

/**
 * Single source of truth for ConversationRoundState serialization format.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type ConversationRoundStateSnapshot = z.output<
  typeof ConversationRoundStateSnapshotSchema
>;

export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount: number;
  public responseTimeMs: number;
  public outputFile: string;
  public normalizedUsage: NormalizedUsage | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = ROUND_STATE_DEFAULTS.continuationCount;
    this.responseTimeMs = ROUND_STATE_DEFAULTS.responseTimeMs;
    this.outputFile = ROUND_STATE_DEFAULTS.outputFile;
    this.normalizedUsage = ROUND_STATE_DEFAULTS.normalizedUsage;
  }

  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  addResponseTime(durationMs: number): void {
    this.responseTimeMs += durationMs;
  }

  setNormalizedUsage(usage: NormalizedUsage): void {
    this.normalizedUsage = usage;
  }

  clearUsage(): void {
    this.normalizedUsage = null;
  }
}

/**
 * Codec for bi-directional serialization of ConversationRoundState.
 * Use .encode() to serialize and .decode() to deserialize.
 */
export const ConversationRoundStateCodec = z.codec(
  ConversationRoundStateSnapshotSchema,
  z.instanceof(ConversationRoundState),
  {
    decode: (
      json: ConversationRoundStateSnapshot,
    ): ConversationRoundState => {
      // Intentional re-parse: validates untrusted input and applies schema defaults
      // for legacy snapshots that may be missing fields like continuationCount
      const parsed = ConversationRoundStateSnapshotSchema.parse(json);
      const state = new ConversationRoundState(parsed.roundIndex);
      state.continuationCount = parsed.continuationCount;
      state.responseTimeMs = parsed.responseTimeMs;
      state.outputFile = parsed.outputFile;
      state.normalizedUsage = parsed.normalizedUsage ?? null;
      return state;
    },
    encode: (state: ConversationRoundState): ConversationRoundStateSnapshot => ({
      roundIndex: state.roundIndex,
      continuationCount: state.continuationCount,
      responseTimeMs: state.responseTimeMs,
      outputFile: state.outputFile,
      normalizedUsage: state.normalizedUsage,
    }),
  },
);

/** Default values for AgentRunState */
const RUN_STATE_DEFAULTS = {
  totalRounds: 0,
  totalResponseTimeMs: 0,
} as const;

export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.int().nonnegative().default(RUN_STATE_DEFAULTS.totalRounds),
  totalResponseTimeMs: z
    .number()
    .nonnegative()
    .default(RUN_STATE_DEFAULTS.totalResponseTimeMs),
  usageAccumulator: RunUsageAccumulatorJSONSchema,
});

/**
 * Single source of truth for AgentRunState serialization format.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentRunStateSnapshot = z.output<typeof AgentRunStateSnapshotSchema>;

export class AgentRunState {
  public totalRounds: number;
  public totalResponseTimeMs: number;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.totalRounds = RUN_STATE_DEFAULTS.totalRounds;
    this.totalResponseTimeMs = RUN_STATE_DEFAULTS.totalResponseTimeMs;
    this.usageAccumulator = accumulator ?? new RunUsageAccumulator();
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  addResponseTime(durationMs: number): void {
    this.totalResponseTimeMs += durationMs;
  }

  recordRound(roundState: ConversationRoundState): void {
    if (roundState.normalizedUsage) {
      this.usageAccumulator.recordNormalizedUsage(
        roundState.roundIndex,
        roundState.normalizedUsage,
      );
    }
    this.addResponseTime(roundState.responseTimeMs);
  }
}

/**
 * Codec for bi-directional serialization of AgentRunState.
 * Use .encode() to serialize and .decode() to deserialize.
 */
export const AgentRunStateCodec = z.codec(
  AgentRunStateSnapshotSchema,
  z.instanceof(AgentRunState),
  {
    decode: (json): AgentRunState => {
      // Intentional re-parse: validates untrusted input and applies schema defaults
      // for legacy snapshots that may be missing fields like totalRounds
      const parsed = AgentRunStateSnapshotSchema.parse(json);
      // Compose with nested codec
      const usageAccumulator = RunUsageAccumulatorCodec.decode(
        parsed.usageAccumulator,
      );
      const state = new AgentRunState(usageAccumulator);
      state.totalRounds = parsed.totalRounds;
      state.totalResponseTimeMs = parsed.totalResponseTimeMs;
      return state;
    },
    encode: (state): AgentRunStateSnapshot => ({
      totalRounds: state.totalRounds,
      totalResponseTimeMs: state.totalResponseTimeMs,
      usageAccumulator: RunUsageAccumulatorCodec.encode(state.usageAccumulator) as AgentRunStateSnapshot['usageAccumulator'],
    }),
  },
);
