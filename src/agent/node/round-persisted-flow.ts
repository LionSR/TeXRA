/**
 * RoundPersistedFlow - Flow-level round management with persistence.
 *
 * Extends PersistedFlow to centrally manage round transitions:
 * - Round counter increment (single source of truth)
 * - Round stage creation/ending
 * - Workspace reset between rounds
 *
 * Nodes signal intent via FlowTransitions (CONTINUE_NEXT_ROUND or FINALIZE),
 * and this class handles all round management.
 *
 * Inheritance:
 * ```
 * Flow → PersistedFlow → RoundPersistedFlow
 * ```
 */

import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';
import type { ExecutionKVStore } from '@agent/storage';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { AgentLogStage } from '@logger/AgentLogger';

import { BaseNode } from './index';
import { PersistedFlow } from './persisted-flow';
import { isRoundAtOrBeyondLimit } from './round-bounds';

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
    parentStage: AgentLogStage | null,
  ) => Promise<AgentLogStage>;

  /**
   * Called after a new round stage is created.
   * Use for registering usage tracking callbacks etc.
   */
  onStageCreated?: (stage: AgentLogStage) => void;

  /** Check if execution should be interrupted. */
  checkInterruption?: () => boolean;

  /** Reset workspace state for a new round. */
  resetForNextRound?: (shared: S) => void;
}

// ============================================================================
// RoundPersistedFlow Class
// ============================================================================

/**
 * A PersistedFlow that manages round lifecycle automatically.
 *
 * Nodes signal intent via FlowTransitions (CONTINUE_NEXT_ROUND or FINALIZE),
 * and this class handles incrementing, stages, resets, and bounds checking.
 *
 * Returns ExecutionStatus directly from run() — no onFlowEnd callback needed.
 */
export class RoundPersistedFlow<
  S extends RoundAwareState = RoundAwareState,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends PersistedFlow<S, P, Svc> {
  private readonly callbacks: RoundCallbacks<S>;
  private readonly parentStage: AgentLogStage | null;
  private currentRoundStage: AgentLogStage | null = null;

  constructor(
    start: BaseNode<any, any>,
    kv: ExecutionKVStore,
    options?: {
      callbacks?: RoundCallbacks<S>;
      parentStage?: AgentLogStage | null;
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
   * Returns the execution status directly.
   */
  async run(shared: S): Promise<ExecutionStatus> {
    const { callbacks } = this;
    let status: ExecutionStatus = EXECUTION_STATUS.COMPLETED;

    await this.init(shared);
    let currentShared = shared;

    try {
      // Create initial round stage (r0)
      await this.createStage(currentShared.currentRound);

      // Execute nodes via stepWithResult()
      let stepResult = await this.inStage(() => this.stepWithResult());
      while (stepResult.hasMore) {
        currentShared = stepResult.shared;

        if (callbacks.checkInterruption?.()) {
          currentShared.continueRounds = false;
          break;
        }

        if (stepResult.action === FlowTransition.CONTINUE_NEXT_ROUND) {
          await this.transitionToNextRound(currentShared);
        }

        stepResult = await this.inStage(() => this.stepWithResult());
      }

      currentShared = stepResult.shared;

      // Determine final status
      const completedAllRounds = isRoundAtOrBeyondLimit(
        currentShared.currentRound + 1,
        currentShared.totalRounds,
      );
      const wasInterrupted =
        !completedAllRounds &&
        (callbacks.checkInterruption?.() || !currentShared.continueRounds);
      if (wasInterrupted) {
        status = EXECUTION_STATUS.INTERRUPTED;
      }
    } catch (error) {
      status = EXECUTION_STATUS.ERROR;
      throw error;
    } finally {
      this.currentRoundStage?.end();
      this.currentRoundStage = null;
    }

    return status;
  }

  /**
   * Handle continuation to next round.
   * This is the SINGLE SOURCE OF TRUTH for round increment.
   */
  private async transitionToNextRound(shared: S): Promise<void> {
    // End previous round stage
    this.currentRoundStage?.end();
    this.currentRoundStage = null;

    // Increment round (single source of truth)
    shared.currentRound += 1;

    // Reset state for next round
    this.callbacks.resetForNextRound?.(shared);

    // Persist the updated state atomically
    await this.setShared(shared);

    // Create new stage if still in bounds
    if (!isRoundAtOrBeyondLimit(shared.currentRound, shared.totalRounds)) {
      await this.createStage(shared.currentRound);
    }
  }

  /**
   * Create a round stage and notify callback.
   */
  private async createStage(roundIndex: number): Promise<void> {
    if (this.callbacks.createRoundStage) {
      this.currentRoundStage = await this.callbacks.createRoundStage(
        roundIndex,
        this.parentStage,
      );
      this.callbacks.onStageCreated?.(this.currentRoundStage);
    }
  }
}
