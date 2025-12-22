/**
 * Unified round context - single source of truth for per-round data.
 *
 * Replaces the parallel arrays pattern in BaseReflectionAgent:
 * - outputFile[]
 * - roundStates[]
 * - workspaceStates[]
 * - roundOutputs[]
 *
 * Each round has exactly one RoundContext containing all related data.
 */
import { z } from 'zod';

import {
  ConversationRoundState,
  ConversationRoundStateSnapshotSchema,
} from './AgentState';
import {
  AgentWorkspaceState,
  AgentWorkspaceStateSnapshotSchema,
} from './AgentWorkspaceState';
import {
  RoundOutputSchema,
  type RoundOutput,
  type AgentFileLocation,
} from '@agent/output/types';
import { AgentFileLocationSchema } from '@utils/files';

// ============================================================================
// Schema (single source of truth for serialization)
// ============================================================================

export const RoundContextSnapshotSchema = z.object({
  /** Zero-based round index */
  index: z.number(),
  /** Output file location for this round's raw model output */
  outputLocation: AgentFileLocationSchema,
  /** Additional output file locations (for multi-file outputs) */
  additionalOutputs: AgentFileLocationSchema.array().default([]),
  /** Round execution state (metrics, timing, usage) */
  roundState: ConversationRoundStateSnapshotSchema.nullable(),
  /** Workspace state (files, media, assembly) */
  workspaceState: AgentWorkspaceStateSnapshotSchema.nullable(),
  /** Processed output artifacts (after XML extraction, diffing, etc.) */
  output: RoundOutputSchema.nullable(),
});

export type RoundContextSnapshot = z.output<typeof RoundContextSnapshotSchema>;

// ============================================================================
// Runtime class
// ============================================================================

/**
 * Unified context for a single conversation round.
 *
 * Lifecycle:
 * 1. Created at round start with index and outputLocation
 * 2. Populated during execution with roundState and workspaceState
 * 3. Finalized after completion with output artifacts
 */
export class RoundContext {
  /** Zero-based round index */
  readonly index: number;

  /** Output file location for this round's raw model output */
  readonly outputLocation: AgentFileLocation;

  /** Additional output file locations (for multi-file outputs) */
  additionalOutputs: AgentFileLocation[];

  /** Round execution state - set during execution */
  roundState: ConversationRoundState | null;

  /** Workspace state - set during execution */
  workspaceState: AgentWorkspaceState | null;

  /** Processed output artifacts - set after completion */
  output: RoundOutput | null;

  constructor(params: {
    index: number;
    outputLocation: AgentFileLocation;
    additionalOutputs?: AgentFileLocation[];
    roundState?: ConversationRoundState | null;
    workspaceState?: AgentWorkspaceState | null;
    output?: RoundOutput | null;
  }) {
    this.index = params.index;
    this.outputLocation = params.outputLocation;
    this.additionalOutputs = params.additionalOutputs ?? [];
    this.roundState = params.roundState ?? null;
    this.workspaceState = params.workspaceState ?? null;
    this.output = params.output ?? null;
  }

  /**
   * Create from snapshot (deserialization).
   */
  static fromSnapshot(snapshot: RoundContextSnapshot): RoundContext {
    return new RoundContext({
      index: snapshot.index,
      outputLocation: snapshot.outputLocation,
      additionalOutputs: snapshot.additionalOutputs,
      roundState: snapshot.roundState
        ? ConversationRoundState.fromSnapshot(snapshot.roundState)
        : null,
      workspaceState: snapshot.workspaceState
        ? AgentWorkspaceState.fromSnapshot(snapshot.workspaceState)
        : null,
      output: snapshot.output,
    });
  }

  /**
   * Serialize to snapshot.
   */
  toSnapshot(): RoundContextSnapshot {
    return {
      index: this.index,
      outputLocation: this.outputLocation,
      additionalOutputs: this.additionalOutputs,
      roundState: this.roundState?.toSnapshot() ?? null,
      workspaceState: this.workspaceState?.toSnapshot() ?? null,
      output: this.output,
    };
  }

  /**
   * Check if this round has been executed (has round state).
   */
  get isExecuted(): boolean {
    return this.roundState !== null;
  }

  /**
   * Check if this round has been finalized (has output).
   */
  get isFinalized(): boolean {
    return this.output !== null;
  }

  /**
   * Set execution state after round completes.
   */
  setExecutionState(
    roundState: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.roundState = roundState;
    this.workspaceState = workspaceState;
  }

  /**
   * Set output after processing completes.
   */
  setOutput(output: RoundOutput): void {
    this.output = output;
  }

  /**
   * Add additional output location.
   */
  addOutputLocation(location: AgentFileLocation): void {
    this.additionalOutputs.push(location);
  }
}

// ============================================================================
// Collection helper
// ============================================================================

/**
 * Manages a collection of round contexts.
 * Provides indexed access and ensures rounds are created in order.
 */
export class RoundContextCollection {
  private readonly rounds: RoundContext[] = [];

  /**
   * Get context for a specific round index.
   * Returns undefined if round doesn't exist.
   */
  get(index: number): RoundContext | undefined {
    return this.rounds[index];
  }

  /**
   * Get context for a round, throwing if it doesn't exist.
   */
  getRequired(index: number): RoundContext {
    const context = this.rounds[index];
    if (!context) {
      throw new Error(`Round ${index} does not exist`);
    }
    return context;
  }

  /**
   * Add a new round context. Must be added in order.
   */
  add(context: RoundContext): void {
    if (context.index !== this.rounds.length) {
      throw new Error(
        `Round ${context.index} added out of order. Expected ${this.rounds.length}`,
      );
    }
    this.rounds.push(context);
  }

  /**
   * Create and add a new round context.
   */
  create(params: {
    outputLocation: AgentFileLocation;
    additionalOutputs?: AgentFileLocation[];
  }): RoundContext {
    const context = new RoundContext({
      index: this.rounds.length,
      outputLocation: params.outputLocation,
      additionalOutputs: params.additionalOutputs,
    });
    this.rounds.push(context);
    return context;
  }

  /**
   * Get the number of rounds.
   */
  get length(): number {
    return this.rounds.length;
  }

  /**
   * Get all rounds as array.
   */
  all(): readonly RoundContext[] {
    return this.rounds;
  }

  /**
   * Get the most recent round, if any.
   */
  get current(): RoundContext | undefined {
    return this.rounds.length > 0
      ? this.rounds[this.rounds.length - 1]
      : undefined;
  }

  /**
   * Iterate over all rounds.
   */
  *[Symbol.iterator](): Iterator<RoundContext> {
    yield* this.rounds;
  }

  /**
   * Serialize to snapshots.
   */
  toSnapshots(): RoundContextSnapshot[] {
    return this.rounds.map((r) => r.toSnapshot());
  }

  /**
   * Create from snapshots.
   */
  static fromSnapshots(snapshots: RoundContextSnapshot[]): RoundContextCollection {
    const collection = new RoundContextCollection();
    for (const snapshot of snapshots) {
      collection.add(RoundContext.fromSnapshot(snapshot));
    }
    return collection;
  }

  /**
   * Clear all outputs from rounds (for re-execution).
   * Preserves round structure but resets execution results.
   */
  clearOutputs(): void {
    for (const round of this.rounds) {
      round.output = null;
      round.roundState = null;
      round.workspaceState = null;
    }
  }

  /**
   * Update the output location for a specific round.
   * Used when subclasses need to override the default output locations.
   */
  updateOutputLocation(index: number, location: AgentFileLocation): void {
    const round = this.rounds[index];
    if (!round) {
      throw new Error(`Round ${index} does not exist`);
    }
    // Create a new RoundContext with updated location
    // Since outputLocation is readonly, we need to create a new context
    this.rounds[index] = new RoundContext({
      index: round.index,
      outputLocation: location,
      additionalOutputs: round.additionalOutputs,
      roundState: round.roundState,
      workspaceState: round.workspaceState,
      output: round.output,
    });
  }
}
