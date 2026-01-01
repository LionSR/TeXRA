/**
 * RoundPersistedFlow - Flow-level round management with persistence.
 *
 * ## Design Philosophy
 *
 * Round lifecycle is a FLOW-level concern. This class extends PersistedFlow
 * to centrally manage round transitions, including:
 * - Round counter increment (single source of truth)
 * - Round stage creation/ending
 * - Workspace reset between rounds
 *
 * ## Command-Based Round Transitions
 *
 * Nodes signal their intent via FlowTransitions, not by mutating state:
 * - `CONTINUE_NEXT_ROUND`: Round completed successfully, continue to next
 * - `FINALIZE`: All rounds complete or interrupted, exit flow
 *
 * RoundPersistedFlow reads these signals and OWNS the increment:
 * - Increments currentRound centrally (single source of truth)
 * - Triggers lifecycle hooks (stages, workspace reset)
 * - Checks bounds before incrementing
 *
 * ## Inheritance Pattern
 *
 * ```
 * Flow (base orchestration)
 *   ↓ extends
 * PersistedFlow (adds node-level persistence via step())
 *   ↓ extends
 * RoundPersistedFlow (adds round management)
 * ```
 *
 * ## What Flow Owns
 *
 * - Round counter increment (currentRound)
 * - Round stage creation/end
 * - Workspace reset between rounds
 * - Bounds checking (single source of truth)
 *
 * ## What Nodes Do
 *
 * - Signal intent (CONTINUE_NEXT_ROUND or FINALIZE)
 * - Pure domain logic (prepare context, run model, process output)
 * - Set flags like continueRounds=false to request interruption
 */

import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { AgentLogStage } from '@logger/AgentLogger';

import { BaseNode } from './index';
import {
  PersistedFlow,
  type FlowStore,
  type SerializationHooks,
} from './persisted-flow';
import { isRoundAtOrBeyondLimit } from './round-bounds';

// ============================================================================
// Round-Aware State Interface
// ============================================================================

/**
 * Minimum state interface for round-aware flows.
 *
 * Flows using RoundPersistedFlow must have shared state that includes these fields.
 * This ensures the flow can track round progression and control continuation.
 *
 * Note: This interface is intentionally minimal. Domain-specific fields like
 * `endTurn` belong in flow-specific state types (e.g., ReflectionFlowShared),
 * not here. RoundPersistedFlow only needs these core orchestration fields.
 */
export interface RoundAwareState extends Record<string, unknown> {
  /** Current round index (0-based) */
  currentRound: number;

  /** Total rounds to execute */
  totalRounds: number;

  /** Whether to continue to next round (can be set false by nodes) */
  continueRounds: boolean;
}

// ============================================================================
// Lifecycle Hooks Interface
// ============================================================================

/**
 * Context passed to lifecycle hooks.
 *
 * Access round info via shared state (no duplication):
 * - context.shared.currentRound (0-based index)
 * - context.shared.totalRounds
 * - context.shared.continueRounds
 */
export interface RoundHookContext<S extends RoundAwareState> {
  /** Current shared state (readonly in hooks) */
  shared: Readonly<S>;

  /** Current round stage (for logging) */
  roundStage: AgentLogStage | null;
}

/**
 * Lifecycle hooks for round orchestration.
 *
 * All hooks are optional and async-capable.
 */
export interface RoundLifecycleHooks<S extends RoundAwareState, Svc = unknown> {
  /**
   * Called at the start of each round, after stage is created.
   *
   * Use for:
   * - Logging round start
   * - Registering usage tracking callbacks
   * - Pre-round validation
   */
  onRoundStart?: (
    context: RoundHookContext<S>,
    services: Svc,
  ) => void | Promise<void>;

  /**
   * Called at the end of each round, before stage is closed.
   *
   * Use for:
   * - Recording round results
   * - Cleanup before next round
   * - Logging round completion
   */
  onRoundEnd?: (
    context: RoundHookContext<S>,
    services: Svc,
  ) => void | Promise<void>;

  /**
   * Called when all rounds complete (success or interruption).
   *
   * Use for:
   * - Final cleanup
   * - Aggregate reporting
   * - Resource deallocation
   */
  onFlowEnd?: (
    shared: S,
    status: 'completed' | 'interrupted' | 'error',
    services: Svc,
  ) => void | Promise<void>;

  /**
   * Called to check if execution should be interrupted.
   *
   * If not provided, rounds continue until totalRounds or continueRounds=false.
   */
  checkInterruption?: () => boolean;

  /**
   * Called to create a round stage for logging.
   *
   * @param roundIndex - The round index (0-based)
   * @param parentStage - The parent run stage
   * @returns The created round stage
   */
  createRoundStage?: (
    roundIndex: number,
    parentStage: AgentLogStage | null,
  ) => Promise<AgentLogStage>;

  /**
   * Called to reset workspace state for a new round.
   *
   * @param shared - The shared state to mutate
   */
  resetForNextRound?: (shared: S) => void;
}

// ============================================================================
// Round Flow Configuration
// ============================================================================

/**
 * Configuration for RoundPersistedFlow.
 */
export interface RoundFlowConfig<S extends RoundAwareState, Svc = unknown> {
  /** Lifecycle hooks (all optional) */
  hooks?: RoundLifecycleHooks<S, Svc>;

  /** Parent stage for round stages (optional) */
  parentStage?: AgentLogStage | null;

  /**
   * Custom serialization hooks for shared state.
   * If not provided, uses structuredClone (requires plain JSON state).
   */
  serialization?: SerializationHooks<S>;
}

// ============================================================================
// RoundPersistedFlow Class
// ============================================================================

/**
 * A PersistedFlow that manages round lifecycle automatically.
 *
 * Extends PersistedFlow with command-based round transitions.
 * Nodes signal intent via FlowTransitions (CONTINUE_NEXT_ROUND or FINALIZE),
 * and this class handles all round management:
 *
 * - Incrementing currentRound (single source of truth)
 * - Creating/ending round stages
 * - Resetting workspace between rounds
 * - Checking bounds to prevent over-iteration
 *
 * ## Usage
 *
 * ```typescript
 * const flow = new RoundPersistedFlow(startNode, kv, {
 *   hooks: {
 *     createRoundStage: async (idx, parent) => {
 *       return await logger.stage(`r${idx}`, { parent });
 *     },
 *     resetForNextRound: (shared) => {
 *       shared.workspaceSnapshot = createFreshWorkspaceSnapshot();
 *     },
 *   },
 *   parentStage: runStage,
 * });
 *
 * await flow.run(shared);
 * // After run, use getShared() to get final state
 * const finalState = await flow.getShared();
 * ```
 *
 * @template S - Shared state type (must extend RoundAwareState)
 * @template P - Params type
 * @template Svc - Services type
 */
export class RoundPersistedFlow<
  S extends RoundAwareState = RoundAwareState,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends PersistedFlow<S, P, Svc> {
  private readonly config: RoundFlowConfig<S, Svc>;
  private currentRoundStage: AgentLogStage | null = null;

  constructor(
    start: BaseNode<any, any>,
    kv: FlowStore,
    config?: RoundFlowConfig<S, Svc>,
    runId?: string,
  ) {
    // Pass serialization hooks to parent PersistedFlow
    super(start, kv, runId, {
      serialization: config?.serialization,
    });
    this.config = config ?? {};
  }

  /**
   * Run the flow with automatic round management.
   *
   * Uses stepWithResult() to efficiently get both action and shared state
   * in a single storage read per step (no redundant reads).
   *
   * Note: The passed `shared` parameter is used for initialization only.
   * After run() completes, use getShared() to get the final state.
   */
  async run(shared: S): Promise<string | undefined> {
    const { hooks } = this.config;
    let status: 'completed' | 'interrupted' | 'error' = 'completed';

    // Initialize flow record with initial shared state
    await this.init(shared);

    // Current shared state reference (updated from stepWithResult)
    let currentShared = shared;

    try {
      // Create initial round stage (r0)
      if (hooks?.createRoundStage) {
        this.currentRoundStage = await hooks.createRoundStage(
          currentShared.currentRound,
          this.config.parentStage ?? null,
        );
      }

      // Hook: Initial round start
      if (hooks?.onRoundStart) {
        await hooks.onRoundStart(
          this.createHookContext(currentShared),
          this._services as Svc,
        );
      }

      // Execute nodes via stepWithResult() - single read per step
      let stepResult = await this.stepWithResult();
      while (stepResult.hasMore) {
        // Use the shared state returned by stepWithResult (authoritative)
        currentShared = stepResult.shared;

        // Handle round transition if signaled
        if (stepResult.action === FlowTransition.CONTINUE_NEXT_ROUND) {
          await this.handleContinueToNextRound(currentShared);
        }

        // Execute next step
        stepResult = await this.stepWithResult();
      }

      // Get final shared state from last step
      currentShared = stepResult.shared;

      // Hook: Final round end
      if (hooks?.onRoundEnd) {
        await hooks.onRoundEnd(
          this.createHookContext(currentShared),
          this._services as Svc,
        );
      }

      // Determine final status: interrupted if stopped before completing all rounds
      const completedAllRounds = isRoundAtOrBeyondLimit(
        currentShared.currentRound + 1,
        currentShared.totalRounds,
      );
      const wasInterrupted =
        hooks?.checkInterruption?.() ||
        (!currentShared.continueRounds && !completedAllRounds);
      if (wasInterrupted) {
        status = 'interrupted';
      }
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      // End final round stage
      this.currentRoundStage?.end();
      this.currentRoundStage = null;

      // Hook: Flow end
      if (hooks?.onFlowEnd) {
        await hooks.onFlowEnd(currentShared, status, this._services as Svc);
      }
    }

    return undefined;
  }

  /**
   * Handle continuation to next round.
   *
   * Called when a node returns CONTINUE_NEXT_ROUND.
   * This is the SINGLE SOURCE OF TRUTH for round increment.
   *
   * The increment is persisted atomically with the next step() call,
   * avoiding double-write race conditions.
   */
  private async handleContinueToNextRound(shared: S): Promise<void> {
    const { hooks } = this.config;

    // Hook: Previous round end (called before increment, so shared.currentRound is still old value)
    if (hooks?.onRoundEnd) {
      await hooks.onRoundEnd(
        this.createHookContext(shared),
        this._services as Svc,
      );
    }

    // End previous round stage
    this.currentRoundStage?.end();
    this.currentRoundStage = null;

    // === SINGLE SOURCE OF TRUTH: Flow owns the increment ===
    shared.currentRound += 1;
    const newRound = shared.currentRound;

    // Reset state for next round (workspace, etc.)
    if (hooks?.resetForNextRound) {
      hooks.resetForNextRound(shared);
    }

    // Persist the updated state (increment + reset) atomically
    await this.setShared(shared);

    // Check bounds - if we've exceeded, the step() loop will end naturally
    // because nodes will return FINALIZE when they see currentRound >= totalRounds
    if (!isRoundAtOrBeyondLimit(newRound, shared.totalRounds)) {
      // Create new round stage only if we're still in bounds
      if (hooks?.createRoundStage) {
        this.currentRoundStage = await hooks.createRoundStage(
          newRound,
          this.config.parentStage ?? null,
        );
      }

      // Hook: New round start
      if (hooks?.onRoundStart) {
        await hooks.onRoundStart(
          this.createHookContext(shared),
          this._services as Svc,
        );
      }
    }
  }

  /**
   * Create hook context from current state.
   */
  private createHookContext(shared: S): RoundHookContext<S> {
    return {
      shared,
      roundStage: this.currentRoundStage,
    };
  }

  /**
   * Get the current round stage.
   *
   * Useful for nodes that need to access the current stage without
   * going through services.
   */
  getRoundStage(): AgentLogStage | null {
    return this.currentRoundStage;
  }
}
