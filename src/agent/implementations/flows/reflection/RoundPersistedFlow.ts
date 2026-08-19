/**
 * RoundPersistedFlow - the reflection flow's round loop, over a PersistedFlow.
 * Rounds — including the bounded compile-repair round — are reflection-product
 * policy, so this lives here and not in the generic `@agent/node` engine.
 *
 * Extends PersistedFlow to centrally manage round transitions:
 * - Round counter increment (single source of truth)
 * - Round stage creation/ending
 * - Workspace reset between rounds
 *
 * After each full pass through the flow graph, the flow checks whether to
 * continue (based on continueRounds, bounds, and interruption) and loops
 * automatically — no dedicated decision node needed.
 *
 * Inheritance:
 * ```
 * Flow → PersistedFlow → RoundPersistedFlow
 * ```
 */

import { BaseNode } from '@agent/node';
import type { ExecutionKVStore } from '@agent/storage';
import type { StageHandle } from '@agent/trace';
import { PersistedFlow } from '@agent/node/persistedFlow';
import {
  RUN_OUTCOME,
  type RetryErrorInfo,
  type RunOutcome,
} from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';

import type { z } from 'zod';

// ============================================================================
// Round-Aware State Interface
// ============================================================================

/**
 * Minimum state interface for round-aware flows.
 * RoundPersistedFlow only needs these core orchestration fields.
 */
export interface RoundAwareState {
  /** Current round index (0-based) */
  currentRound: number;

  /** Total rounds to execute */
  totalRounds: number;

  /** Whether to continue to next round (can be set false by nodes) */
  continueRounds: boolean;

  /** Set by nodes when execution fails. Skips round completion callbacks. */
  lastError?: RetryErrorInfo;
}

// ============================================================================
// Callbacks
// ============================================================================

/**
 * Callbacks for round orchestration. All are optional.
 */
interface RoundCallbacks<S extends RoundAwareState> {
  /**
   * Create a round stage for logging. Also receives the created stage
   * for side effects (e.g. registering usage tracking).
   */
  createRoundStage?: (
    roundIndex: number,
    parentStage: StageHandle | null,
    shared: S,
  ) => StageHandle;

  /** Check if execution should be interrupted. */
  signal?: AbortSignal;

  /** Reset workspace state for a new round. */
  resetForNextRound?: (shared: S) => void;

  /**
   * Called only when the round loop would otherwise stop because
   * `currentRound + 1 >= totalRounds`. Return true to run exactly one more
   * round beyond the configured total (e.g. a compile-repair round). The
   * callback owns recording that the extra round was granted (a persisted
   * boolean on shared state) so it isn't asked again once it has said yes
   * — this is what keeps the extra round bounded to exactly one per run,
   * including across resume.
   */
  grantExtraRound?: (shared: S) => boolean;
}

// ============================================================================
// RoundPersistedFlow Class
// ============================================================================

/**
 * A PersistedFlow that manages round lifecycle automatically.
 *
 * After each full pass through the node graph, this class checks whether to
 * continue and handles incrementing, stages, resets, and bounds checking.
 *
 * Returns RunOutcome directly from run() — no onFlowEnd callback needed.
 */
export class RoundPersistedFlow<
  S extends RoundAwareState = RoundAwareState,
  Svc = unknown,
> extends PersistedFlow<S, Svc> {
  private readonly callbacks: RoundCallbacks<S>;
  private readonly parentStage: StageHandle | null;
  private currentRoundStage: StageHandle | null = null;

  constructor(
    start: BaseNode,
    kv: ExecutionKVStore,
    options?: {
      callbacks?: RoundCallbacks<S>;
      parentStage?: StageHandle | null;
      sharedSchema?: z.ZodType<S>;
    },
  ) {
    super(start, kv, undefined, options?.sharedSchema);
    this.callbacks = options?.callbacks ?? {};
    this.parentStage = options?.parentStage ?? null;
  }

  /**
   * Execute an async operation within the current round stage's context.
   * Ensures AsyncLocalStorage context is set for proper log grouping.
   */
  private async inStage<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentRoundStage) {
      return this.currentRoundStage.within(fn);
    }
    return fn();
  }

  /**
   * Run the flow with automatic round management.
   *
   * After each full pass through all nodes, the flow checks whether to
   * continue to the next round. This eliminates the need for a dedicated
   * "round complete" decision node — the flow itself owns the decision.
   *
   * Returns the canonical run outcome directly.
   */
  async run(shared: S): Promise<RunOutcome> {
    let outcome: RunOutcome = RUN_OUTCOME.FAILED;

    await this.ensureRecord(shared);
    let currentShared = shared;

    try {
      // Create initial round stage (r0)
      this.createStage(currentShared.currentRound, currentShared);

      // Execute all nodes for the current round
      currentShared = await this.executeRoundSteps();

      // After each round, decide whether to continue to the next round.
      while (this.shouldContinueNextRound(currentShared)) {
        await this.transitionToNextRound(currentShared);
        currentShared = await this.executeRoundSteps();
      }

      // Determine final outcome
      outcome = this.resolveOutcome(currentShared);
    } finally {
      this.currentRoundStage?.end(outcome);
      this.currentRoundStage = null;
    }

    return outcome;
  }

  /**
   * Execute all nodes in the current round, checking for interruption
   * between each step. Returns the final shared state.
   */
  private async executeRoundSteps(): Promise<S> {
    let stepResult = await this.inStage(() => this.stepWithResult());

    while (stepResult.hasMore) {
      if (this.callbacks.signal?.aborted) {
        stepResult.shared.continueRounds = false;
        break;
      }

      stepResult = await this.inStage(() => this.stepWithResult());
    }

    return stepResult.shared;
  }

  /**
   * Check whether to continue to the next round after all nodes complete.
   * This is the SINGLE SOURCE OF TRUTH for the continue/finalize decision.
   */
  private shouldContinueNextRound(shared: S): boolean {
    if (
      shared.lastError ||
      this.callbacks.signal?.aborted ||
      !shared.continueRounds
    ) {
      return false;
    }
    if (shared.currentRound + 1 < shared.totalRounds) return true;
    // Otherwise this would be the last round. Give the caller one chance to
    // grant a bounded extra round (e.g. a compile-repair round) instead.
    return this.callbacks.grantExtraRound?.(shared) ?? false;
  }

  /** Derive the canonical RunOutcome from the current round state. */
  private resolveOutcome(shared: S): RunOutcome {
    return deriveRunOutcome({
      failed: Boolean(shared.lastError),
      cancelled: this.callbacks.signal?.aborted || !shared.continueRounds,
    });
  }

  /**
   * Transition to the next round: increment counter, reset state, and rewind
   * the replay cursor so the flow starts from the beginning again.
   */
  private async transitionToNextRound(shared: S): Promise<void> {
    // End previous round stage
    this.currentRoundStage?.end(this.resolveOutcome(shared));
    this.currentRoundStage = null;

    // Increment round (single source of truth)
    shared.currentRound += 1;

    // Reset state for next round
    this.callbacks.resetForNextRound?.(shared);

    // Rewind the cursor so the next stepWithResult() starts from the beginning
    await this.rewindToStart(shared);

    // Create new stage
    this.createStage(shared.currentRound, shared);
  }

  /**
   * Create a round stage.
   */
  private createStage(roundIndex: number, shared: S): void {
    if (this.callbacks.createRoundStage) {
      this.currentRoundStage = this.callbacks.createRoundStage(
        roundIndex,
        this.parentStage,
        shared,
      );
    }
  }
}
