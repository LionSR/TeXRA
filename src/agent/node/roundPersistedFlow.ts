/**
 * RoundPersistedFlow - Flow-level round management with persistence.
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

import type { ExecutionKVStore } from '@agent/storage';
import type { StageHandle } from '@agent/trace';
import {
  EXECUTION_STATUS,
  type ExecutionStatus,
  type RetryErrorInfo,
} from '@shared/schemas';

import { BaseNode } from './index';
import { PersistedFlow } from './persistedFlow';

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
export interface RoundCallbacks<S extends RoundAwareState> {
  /**
   * Create a round stage for logging. Also receives the created stage
   * for side effects (e.g. registering usage tracking).
   */
  createRoundStage?: (
    roundIndex: number,
    parentStage: StageHandle | null,
  ) => StageHandle;

  /**
   * Called after a new round stage is created.
   * Use for registering usage tracking callbacks etc.
   */
  onStageCreated?: (stage: StageHandle) => void;

  /** Check if execution should be interrupted. */
  checkInterruption?: () => boolean;

  /** Reset workspace state for a new round. */
  resetForNextRound?: (shared: S) => void;

  /** Called when a round completes (after all nodes finish, before transition). */
  onRoundCompleted?: (roundIndex: number, shared: S) => void | Promise<void>;
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
 * Returns ExecutionStatus directly from run() — no onFlowEnd callback needed.
 */
export class RoundPersistedFlow<
  S extends RoundAwareState = RoundAwareState,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends PersistedFlow<S, P, Svc> {
  private readonly callbacks: RoundCallbacks<S>;
  private readonly parentStage: StageHandle | null;
  private currentRoundStage: StageHandle | null = null;

  constructor(
    start: BaseNode<any, any>,
    kv: ExecutionKVStore,
    options?: {
      callbacks?: RoundCallbacks<S>;
      parentStage?: StageHandle | null;
    },
    runId?: string,
  ) {
    super(start, kv, runId);
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
   * Returns the execution status directly.
   */
  async run(shared: S): Promise<ExecutionStatus> {
    let status: ExecutionStatus = EXECUTION_STATUS.COMPLETED;

    await this.init(shared);
    let currentShared = shared;

    try {
      // Create initial round stage (r0)
      this.createStage(currentShared.currentRound);

      // Execute all nodes for the current round
      currentShared = await this.executeRoundSteps(currentShared);

      // After each round, decide whether to continue to the next round.
      while (this.shouldContinueNextRound(currentShared)) {
        await this.transitionToNextRound(currentShared);
        currentShared = await this.executeRoundSteps(currentShared);
      }

      // Determine final status
      status = this.resolveTerminalStatus(currentShared);
      if (status === EXECUTION_STATUS.COMPLETED) {
        await this.callbacks.onRoundCompleted?.(
          currentShared.currentRound,
          currentShared,
        );
      }
    } finally {
      this.currentRoundStage?.end();
      this.currentRoundStage = null;
    }

    return status;
  }

  /**
   * Execute all nodes in the current round, checking for interruption
   * between each step. Returns the final shared state.
   */
  private async executeRoundSteps(shared: S): Promise<S> {
    let currentShared = shared;
    let stepResult = await this.inStage(() => this.stepWithResult());

    while (stepResult.hasMore) {
      currentShared = stepResult.shared;

      if (this.callbacks.checkInterruption?.()) {
        currentShared.continueRounds = false;
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
    return (
      !shared.lastError &&
      !this.callbacks.checkInterruption?.() &&
      shared.continueRounds &&
      shared.currentRound + 1 < shared.totalRounds
    );
  }

  /**
   * Derive terminal ExecutionStatus from shared state after the round loop exits.
   *
   * Priority:
   * 1. lastError → ERROR (node-level failure)
   * 2. interrupted / !continueRounds → INTERRUPTED (early stop)
   * 3. otherwise → COMPLETED (all rounds finished normally)
   */
  private resolveTerminalStatus(shared: S): ExecutionStatus {
    if (shared.lastError) {
      return EXECUTION_STATUS.ERROR;
    }
    if (this.callbacks.checkInterruption?.() || !shared.continueRounds) {
      return EXECUTION_STATUS.INTERRUPTED;
    }
    return EXECUTION_STATUS.COMPLETED;
  }

  /**
   * Transition to the next round: increment counter, reset state,
   * reset node history so the flow starts from the beginning again.
   */
  private async transitionToNextRound(shared: S): Promise<void> {
    // Notify round completion before ending the stage
    await this.callbacks.onRoundCompleted?.(shared.currentRound, shared);

    // End previous round stage
    this.currentRoundStage?.end();
    this.currentRoundStage = null;

    // Increment round (single source of truth)
    shared.currentRound += 1;

    // Reset state for next round
    this.callbacks.resetForNextRound?.(shared);

    // Reset node history so next stepWithResult() starts from the beginning
    await this.resetNodeHistory(shared);

    // Create new stage
    this.createStage(shared.currentRound);
  }

  /**
   * Create a round stage and notify callback.
   */
  private createStage(roundIndex: number): void {
    if (this.callbacks.createRoundStage) {
      this.currentRoundStage = this.callbacks.createRoundStage(
        roundIndex,
        this.parentStage,
      );
      this.callbacks.onStageCreated?.(this.currentRoundStage);
    }
  }
}
