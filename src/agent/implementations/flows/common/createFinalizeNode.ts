/**
 * Finalize node - standard cleanup node for agent flows.
 *
 * Handles the finalization pattern:
 * 1. Collect any existing error from lifecycle
 * 2. Run beforeEnd() hook (optional, override in subclass)
 * 3. Call hooks.end(status)
 * 4. Call hooks.cleanup()
 * 5. Fail with primary error or complete
 *
 * Error aggregation: Both end() and cleanup() run even if one fails.
 * This ensures cleanup always happens.
 */

// Core imports
import { BaseNode } from '@agent/node';

// Constants
import { END_GROUP_STATUS } from '@logger/messageTypes';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';
import type { AgentRunShared } from './AgentRunFlowRunner';

// ============================================================================
// Types
// ============================================================================

/**
 * Context extracted in prep() and passed to exec() and hooks.
 * Contains only the fields needed for finalization.
 */
export interface FinalizeContext<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
  Agent extends object,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}

/** Helper type to extract context from AgentRunShared */
type ContextOf<Shared extends AgentRunShared<any, any, any, any>> =
  FinalizeContext<Shared['lifecycle'], Shared['hooks'], Shared['agent']>;

// ============================================================================
// StandardFinalizeNode
// ============================================================================

/**
 * Standard finalize node with error aggregation.
 *
 * PocketFlow pattern:
 * - prep(): Set phase, extract context
 * - exec(): Run finalize + cleanup with error collection
 * - post(): No routing (terminal node)
 *
 * Extension point (override in subclass):
 * - beforeEnd(): Run operations before hooks.end()
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
 *     await ctx.agent.clearPersistedSnapshot();
 *   }
 * }
 * ```
 */
export class StandardFinalizeNode<
  Shared extends AgentRunShared<any, any, any, any>,
> extends BaseNode<Shared> {
  constructor(protected readonly phase: Shared['lifecycle']['phase']) {
    super();
  }

  async prep(shared: Shared): Promise<ContextOf<Shared>> {
    shared.lifecycle.setPhase(this.phase);
    return {
      lifecycle: shared.lifecycle,
      hooks: shared.hooks,
      agent: shared.agent,
    };
  }

  /**
   * Override for pre-end operations (e.g., clear snapshots).
   * Called before hooks.end().
   */
  protected async beforeEnd(_context: ContextOf<Shared>): Promise<void> {
    // Default: no-op
  }

  async exec(context: ContextOf<Shared>): Promise<void> {
    // Primary error is the one that caused us to finalize
    const primaryError = context.lifecycle.error;

    // Compute status based on error state
    const status =
      primaryError || context.lifecycle.status === 'error'
        ? END_GROUP_STATUS.ERROR
        : END_GROUP_STATUS.STOPPED;

    // Run finalize: beforeEnd → end (collect error if fails)
    let finalizeError: unknown;
    try {
      await this.beforeEnd(context);
      await context.hooks.end(status);
    } catch (error) {
      finalizeError = error;
    }

    // Run cleanup (always, even if finalize failed)
    // Cleanup errors are logged but don't override primary/finalize error
    try {
      await context.hooks.cleanup();
    } catch {
      // Cleanup failed - primary error takes precedence
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
