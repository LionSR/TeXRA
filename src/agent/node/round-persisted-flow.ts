/**
 * RoundPersistedFlow - Flow-level round stage management with persistence.
 *
 * ## Design Philosophy
 *
 * Round STAGE LIFECYCLE is a FLOW-level concern. This class extends PersistedFlow
 * to add automatic stage management at round boundaries, removing the need for
 * nodes to mutate services.roundStage.
 *
 * ## Key Insight
 *
 * The existing node graph already handles round iteration via internal looping
 * (RoundCompleteNode → PrepareContextNode via CONTINUE action). This class
 * doesn't change that - it just detects round transitions by watching
 * shared.currentRound and manages stages accordingly.
 *
 * ## Inheritance Pattern
 *
 * ```
 * Flow (base orchestration)
 *   ↓ extends
 * PersistedFlow (adds node-level persistence via step())
 *   ↓ extends
 * RoundPersistedFlow (adds round stage management)
 * ```
 *
 * ## What Moves to Flow Level
 *
 * - Round stage creation/end (was split across RoundCompleteNode + runReflectionFlow)
 * - The mutable services.roundStage field (now managed internally)
 *
 * ## What Nodes Keep
 *
 * - Round counter increment (RoundCompleteNode.post())
 * - Continuation logic (RoundCompleteNode.exec())
 * - Workspace reset (RoundCompleteNode.post())
 * - Pure domain logic (prepare context, run model, process output)
 *
 * ## How It Works
 *
 * 1. Creates initial round stage (r0) before execution
 * 2. Runs nodes via inherited step() - graph loops internally
 * 3. After each node, checks if shared.currentRound changed
 * 4. On round transition: ends old stage, creates new stage
 * 5. Ends final stage when graph completes
 */

import type { AgentLogStage } from '@logger/AgentLogger';

import { BaseNode } from './index';
import { PersistedFlow, type FlowStore } from './persisted-flow';

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
 */
export interface RoundHookContext<S extends RoundAwareState> {
  /** Current round index (0-based) */
  roundIndex: number;

  /** Total rounds configured */
  totalRounds: number;

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
}

// ============================================================================
// RoundPersistedFlow Class
// ============================================================================

/**
 * A PersistedFlow that manages round stage lifecycle automatically.
 *
 * Extends PersistedFlow to detect round transitions and manage stages.
 * The node graph still handles round iteration via internal looping
 * (RoundCompleteNode returns CONTINUE to loop back). This class just
 * watches for round transitions and creates/ends stages accordingly.
 *
 * ## Usage
 *
 * ```typescript
 * const flow = new RoundPersistedFlow(startNode, kv, {
 *   hooks: {
 *     createRoundStage: async (idx, parent) => {
 *       return await logger.stage(`r${idx}`, { parent });
 *     },
 *   },
 *   parentStage: runStage,
 * });
 *
 * await flow.run(shared);
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
  private lastKnownRound: number = 0;

  constructor(
    start: BaseNode<any, any>,
    kv: FlowStore,
    config?: RoundFlowConfig<S, Svc>,
    runId?: string,
  ) {
    super(start, kv, runId);
    this.config = config ?? {};
  }

  /**
   * Run the flow with automatic round stage management.
   *
   * Overrides PersistedFlow.run() to:
   * 1. Create initial round stage (r0)
   * 2. Run nodes via inherited step() - graph loops internally
   * 3. Detect round transitions via shared.currentRound changes
   * 4. On transition: end old stage, create new stage
   * 5. End final stage when graph completes
   */
  async run(shared: S): Promise<string | undefined> {
    const { hooks } = this.config;
    let status: 'completed' | 'interrupted' | 'error' = 'completed';

    // Initialize flow record
    await this.init(shared);

    // Track the current round
    this.lastKnownRound = shared.currentRound;

    try {
      // Create initial round stage (r0)
      if (hooks?.createRoundStage) {
        this.currentRoundStage = await hooks.createRoundStage(
          this.lastKnownRound,
          this.config.parentStage ?? null,
        );
      }

      // Hook: Initial round start
      if (hooks?.onRoundStart) {
        await hooks.onRoundStart(
          this.createHookContext(shared),
          this._services as Svc,
        );
      }

      // Execute nodes via inherited step()
      // The graph loops internally via RoundCompleteNode → PrepareContextNode
      while (await this.step()) {
        // Reload shared state to detect round transitions
        const updatedShared = await this.getShared();
        if (updatedShared) {
          // Check if round changed (RoundCompleteNode incremented currentRound)
          if (updatedShared.currentRound !== this.lastKnownRound) {
            // Round transition detected!
            await this.handleRoundTransition(updatedShared);
          }
          // Update local reference
          Object.assign(shared, updatedShared);
        }
      }

      // Hook: Final round end
      if (hooks?.onRoundEnd) {
        await hooks.onRoundEnd(
          this.createHookContext(shared),
          this._services as Svc,
        );
      }

      // Determine final status: interrupted if stopped before completing all rounds
      // RoundCompleteNode sets continueRounds=false or checkInterruption returns true
      const wasInterrupted =
        hooks?.checkInterruption?.() ||
        (!shared.continueRounds && shared.currentRound < shared.totalRounds - 1);
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
        await hooks.onFlowEnd(shared, status, this._services as Svc);
      }
    }

    return undefined;
  }

  /**
   * Handle a round transition.
   *
   * Called when shared.currentRound changes (detected after step()).
   * Ends old stage, fires hooks, creates new stage.
   */
  private async handleRoundTransition(shared: S): Promise<void> {
    const { hooks } = this.config;
    const newRound = shared.currentRound;

    // Hook: Previous round end
    if (hooks?.onRoundEnd) {
      await hooks.onRoundEnd(
        this.createHookContext(shared, this.lastKnownRound),
        this._services as Svc,
      );
    }

    // End previous round stage
    this.currentRoundStage?.end();
    this.currentRoundStage = null;

    // Update tracking
    this.lastKnownRound = newRound;

    // Reset state for next round (workspace, etc.)
    // This is called BEFORE stage creation so the new round starts fresh
    if (hooks?.resetForNextRound) {
      hooks.resetForNextRound(shared);
    }

    // Create new round stage
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

  /**
   * Create hook context from current state.
   */
  private createHookContext(
    shared: S,
    roundOverride?: number,
  ): RoundHookContext<S> {
    return {
      roundIndex: roundOverride ?? this.lastKnownRound,
      totalRounds: shared.totalRounds,
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
