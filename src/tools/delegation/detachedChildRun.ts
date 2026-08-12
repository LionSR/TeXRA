/**
 * Shared detached-child launch choreography for delegation launch sites.
 *
 * Every detached child run (delegate_agent/subagent, delegate_multi_agents)
 * starts with the same lifecycle: hold the owned-execution lease launch guard
 * while starting the child run loop, and attach a completion error trace so a
 * late loop failure is diagnosed. Callers keep their own execution-id
 * derivation, registration, approval wiring, and result shaping; this module
 * owns only the guard-and-trace skeleton so its invariant (a throw inside the
 * guard releases the lease; a late loop failure is surfaced) lives in one
 * place.
 */

// Local imports
import { runWithOwnedExecutionLeaseLaunchGuard } from '@agent/storage/executionLease';
import {
  startChildRunLoop,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

// Local file imports
import type { ChildStream } from './childStream';

/** The strategy + stream wiring a launch site supplies inside the guard. */
interface DetachedChildRunLaunch<TTurn> {
  /**
   * Pre-reserved child stream for the loop to own/finalize. Native strategies
   * omit this — `executeAgent` already owns handle creation for every turn.
   */
  readonly childStream?: ChildStream;
  /** Provider-specific run strategy for the child loop. */
  readonly strategy: ChildRunStrategy<TTurn>;
  /**
   * Attach a completion error trace so a late loop failure is diagnosed. Omit
   * when the caller awaits completion in-band (no unhandled rejection).
   */
  readonly onLoopFailed?: (error: unknown) => void;
}

export interface DetachedChildRunInput<TTurn> {
  readonly executionId: ExecutionId;
  readonly parentStreamId: StreamTabId;
  /** The child stream tab id the run is registered under. */
  readonly childStreamId: StreamTabId;
  readonly agentName: string;
  /** Roll the child's final cost into the parent's usage totals. */
  readonly recordCost?: (totalCostUsd: number | undefined) => void;
  /**
   * Build the strategy (and any attempt-scoped setup) INSIDE the lease launch
   * guard: a throw here must release the owned-execution lease. A function
   * (rather than a pre-built value) so the build runs lazily inside the guard.
   */
  readonly buildLaunch: () => Promise<DetachedChildRunLaunch<TTurn>>;
}

/**
 * Run the shared detached-child launch choreography: hold the owned-execution
 * lease launch guard while starting the child run loop, and attach the
 * completion error trace. Returns the launched loop's stream id and completion
 * so in-band callers can await it.
 */
export async function startDetachedChildRunLoop<TTurn>(
  input: DetachedChildRunInput<TTurn>,
): Promise<{ childStreamId: StreamTabId; completion: Promise<void> }> {
  return runWithOwnedExecutionLeaseLaunchGuard(input.executionId, async () => {
    const { childStream, strategy, onLoopFailed } = await input.buildLaunch();
    const { completion } = startChildRunLoop({
      ...(childStream !== undefined && { childStream }),
      childStreamId: input.childStreamId,
      parentStreamId: input.parentStreamId,
      executionId: input.executionId,
      agentName: input.agentName,
      strategy,
      ...(input.recordCost !== undefined && { recordCost: input.recordCost }),
    });
    if (onLoopFailed) void completion.catch(onLoopFailed);
    return {
      childStreamId: childStream?.childStreamId ?? input.childStreamId,
      completion,
    };
  });
}
