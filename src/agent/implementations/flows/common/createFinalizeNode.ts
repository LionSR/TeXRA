/**
 * Finalize node - standard cleanup node for agent flows.
 *
 * Handles the finalization pattern:
 * 1. Collect any existing error from lifecycle
 * 2. Run beforeEnd() hook (optional, override in subclass)
 * 3. Call hooks.end(status)
 * 4. Call hooks.cleanup()
 * 5. Report secondary errors, fail with primary or complete
 *
 * Error aggregation: Both end() and cleanup() run even if one fails.
 * This ensures cleanup always happens. Secondary errors are reported
 * via onSecondaryError() hook.
 */

// Core imports
import { BaseNode } from '@agent/node';

// Constants
import { END_GROUP_STATUS } from '@logger/messageTypes';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';

// ============================================================================
// Types
// ============================================================================

/**
 * Shared state constraint for finalize nodes.
 */
export interface FinalizeShared<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
  Agent extends object,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}

/**
 * Context extracted in prep() and passed to exec() and hooks.
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

/** Helper type to extract context from shared */
type ContextOf<Shared extends FinalizeShared<any, any, any>> = FinalizeContext<
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
 * - prep(): Set phase, extract context
 * - exec(): Run finalize + cleanup with error collection
 * - post(): No routing (terminal node)
 *
 * Extension points (override in subclass):
 * - beforeEnd(): Run operations before hooks.end()
 * - onSecondaryError(): Handle errors after the primary error
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
 *     await ctx.hooks.clearPersistedSnapshot();
 *   }
 *
 *   protected onSecondaryError(ctx: ContextOf<MyShared>, error: unknown): void {
 *     ctx.hooks.logWarning?.('Additional error', error);
 *   }
 * }
 * ```
 */
export class StandardFinalizeNode<
  Shared extends FinalizeShared<any, any, any>,
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

  /**
   * Override to handle secondary errors (errors after the primary).
   * Called for each error beyond the first.
   */
  protected onSecondaryError(
    _context: ContextOf<Shared>,
    _error: unknown,
  ): void {
    // Default: no-op
  }

  async exec(context: ContextOf<Shared>): Promise<void> {
    const errors: unknown[] = [];

    // Collect existing error from lifecycle (from previous node failures)
    if (context.lifecycle.error) {
      errors.push(context.lifecycle.error);
    }

    // Compute status based on error state
    const status =
      context.lifecycle.error || context.lifecycle.status === 'error'
        ? END_GROUP_STATUS.ERROR
        : END_GROUP_STATUS.STOPPED;

    // Run finalize: beforeEnd → end
    try {
      await this.beforeEnd(context);
      await context.hooks.end(status);
    } catch (error) {
      errors.push(error);
    }

    // Run cleanup (always, even if finalize failed)
    try {
      await context.hooks.cleanup();
    } catch (error) {
      errors.push(error);
    }

    // Report secondary errors
    if (errors.length > 1) {
      errors.slice(1).forEach((error) => this.onSecondaryError(context, error));
    }

    // Set final lifecycle status
    const primaryError = errors[0];
    if (primaryError) {
      context.lifecycle.fail(primaryError);
    } else {
      context.lifecycle.complete();
    }
  }
}

// ============================================================================
// Backward compatibility (deprecated)
// ============================================================================

/**
 * @deprecated Use `new StandardFinalizeNode(phase)` or extend the class instead.
 * This factory is kept for backward compatibility during migration.
 */
export interface StandardFinalizeNodeOptions<
  Shared extends FinalizeShared<any, any, any>,
> {
  finalizePhase: Shared['lifecycle']['phase'];
  beforeEnd?(context: ContextOf<Shared>): Promise<void>;
  onSecondaryError?(context: ContextOf<Shared>, error: unknown): void;
}

/**
 * @deprecated Use `new StandardFinalizeNode(phase)` or extend the class instead.
 */
export function createStandardFinalizeNode<
  Shared extends FinalizeShared<any, any, any>,
>(options: StandardFinalizeNodeOptions<Shared>): BaseNode<Shared> {
  // Create an instance with overridden methods
  const node = new StandardFinalizeNode<Shared>(options.finalizePhase);

  if (options.beforeEnd) {
    const originalBeforeEnd = options.beforeEnd;
    (node as any).beforeEnd = async function (
      context: ContextOf<Shared>,
    ): Promise<void> {
      await originalBeforeEnd(context);
    };
  }

  if (options.onSecondaryError) {
    const originalOnSecondaryError = options.onSecondaryError;
    (node as any).onSecondaryError = function (
      context: ContextOf<Shared>,
      error: unknown,
    ): void {
      originalOnSecondaryError(context, error);
    };
  }

  return node;
}
