/**
 * Finalize node - standard cleanup node for agent flows.
 *
 * Handles the finalization pattern:
 * 1. Collect any existing error from lifecycle
 * 2. Run beforeEnd() hook (optional, override in subclass)
 * 3. Call agent.endRun(status)
 * 4. Call agent.cleanupRun()
 * 5. Fail with primary error or complete
 *
 * Lifecycle methods are called directly on the agent (IFlowAgent interface)
 * rather than through hooks, since they have identical implementations
 * across all agent types.
 *
 * Error aggregation: Both endRun() and cleanupRun() run even if one fails.
 * This ensures cleanup always happens.
 */

// Core imports
import { BaseNode, type NonIterableObject } from '@agent/node';

// Constants
import type { IFlowAgent } from '@agent/core/IAgent';
import { END_GROUP_STATUS } from '@logger/messageTypes';

// Type imports
import type { AgentLifecycle } from './AgentLifecycle';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal shared state interface for StandardFinalizeNode.
 * Looser than AgentRunShared to support flows without hooks.
 */
interface MinimalShared {
  agent: IFlowAgent;
  lifecycle: AgentLifecycle<string>;
  hooks?: unknown;
}

/**
 * Context extracted in prep() and passed to exec() and hooks.
 * Contains agent, lifecycle, and flow-specific hooks.
 */
export interface FinalizeContext<
  Lifecycle extends AgentLifecycle<string>,
  Hooks,
  Agent extends IFlowAgent,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}

/** Helper type to extract context from shared */
type ContextOf<Shared extends MinimalShared> = FinalizeContext<
  Shared['lifecycle'],
  Shared['hooks'],
  Shared['agent']
>;

// ============================================================================
// StandardFinalizeNode
// ============================================================================

/**
 * Standard finalize node with error aggregation.
 *
 * PocketFlow pattern:
 * - prep(): Extract context from shared
 * - exec(): Set phase + run finalize + cleanup with error collection
 * - post(): No routing (terminal node)
 *
 * Note on phase setting:
 * Phase is set at start of exec() (consistent with StandardInitNode pattern).
 * This indicates "we're now in finalization phase" during cleanup work.
 *
 * Note on error handling:
 * This node uses manual try/catch instead of execFallback because:
 * 1. It's a terminal node - must complete regardless of errors
 * 2. Cleanup must always run, even if beforeEnd/end fails
 * 3. Primary error (from earlier nodes) takes precedence over finalize errors
 * 4. execFallback would only catch thrown errors, but we need guaranteed cleanup
 *
 * Extension point (override in subclass):
 * - beforeEnd(): Run operations before agent.endRun()
 *
 * @example
 * ```typescript
 * // Simple usage - just specify phase
 * const finalizeNode = new StandardFinalizeNode<MyShared>('finalize');
 *
 * // With customization - extend the class
 * class MyFinalizeNode extends StandardFinalizeNode<MyShared> {
 *   constructor() { super('finalize'); }
 *
 *   protected async beforeEnd(ctx: ContextOf<MyShared>): Promise<void> {
 *     await ctx.agent.session.clearPersistedSnapshot();
 *   }
 * }
 * ```
 */
export class StandardFinalizeNode<
  Shared extends MinimalShared,
  Params extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> extends BaseNode<Shared, Params, Svc> {
  constructor(protected readonly phase: Shared['lifecycle']['phase']) {
    super();
  }

  async prep(shared: Shared): Promise<ContextOf<Shared>> {
    return {
      lifecycle: shared.lifecycle,
      hooks: shared.hooks,
      agent: shared.agent,
    };
  }

  /**
   * Override for pre-end operations (e.g., clear snapshots).
   * Called before agent.endRun().
   */
  protected async beforeEnd(_context: ContextOf<Shared>): Promise<void> {
    // Default: no-op
  }

  async exec(context: ContextOf<Shared>): Promise<void> {
    // Set phase at start of work (consistent with StandardInitNode pattern)
    context.lifecycle.setPhase(this.phase);

    // Primary error is the one that caused us to finalize
    const primaryError = context.lifecycle.error;

    // Compute status based on error state
    const status =
      primaryError || context.lifecycle.status === 'error'
        ? END_GROUP_STATUS.ERROR
        : END_GROUP_STATUS.STOPPED;

    // Run finalize: beforeEnd → endRun (collect error if fails)
    // Lifecycle methods called directly on agent (IFlowAgent interface)
    let finalizeError: unknown;
    try {
      await this.beforeEnd(context);
      await context.agent.endRun(status);
    } catch (error) {
      finalizeError = error;
    }

    // Run cleanup (always, even if finalize failed)
    // Cleanup errors are logged but don't override primary/finalize error
    try {
      await context.agent.cleanupRun();
    } catch (cleanupError) {
      // Log cleanup error if logger is available via services
      const logger = (
        this.services as { logger?: { error: (...args: unknown[]) => void } }
      )?.logger;
      if (logger?.error) {
        logger.error(`Cleanup failed (primary error preserved): ${cleanupError}`);
      }
      // Primary error takes precedence - cleanup error is logged but not propagated
    }

    // Set final lifecycle status (first error wins)
    const error = primaryError ?? finalizeError;
    if (error) {
      context.lifecycle.fail(error);
    } else {
      context.lifecycle.complete();
    }
  }
}
