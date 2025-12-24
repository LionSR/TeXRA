// Local imports - core flow primitives
import { BaseNode } from '@agent/node';

// Local imports - constants
import { END_GROUP_STATUS } from '@logger/messageTypes';

// Internal imports
import { finalizeLifecycle } from './finalizeLifecycle';

// Type imports
import type { AgentRunShared } from './types';
import type { FinalizeNodeContext } from './nodeExecution';

/**
 * Helper type to extract finalize context from shared state.
 * Reduces verbose repetition of FinalizeNodeContext<Shared['lifecycle'], ...>.
 */
type FinalizeContext<Shared extends AgentRunShared<any, any, any, any>> =
  FinalizeNodeContext<Shared['lifecycle'], Shared['hooks'], Shared['agent']>;

export interface AgentFinalizeNodeOptions<
  Shared extends AgentRunShared<any, any, any, any>,
  Status extends string = string,
> {
  finalizePhase: Shared['lifecycle']['phase'];
  computeStatus(context: FinalizeContext<Shared>): Status;
  runFinalize(context: FinalizeContext<Shared>, status: Status): Promise<void>;
  runCleanup(context: FinalizeContext<Shared>): Promise<void>;
  onSuccess?(context: FinalizeContext<Shared>): void | Promise<void>;
  onSecondaryError?(context: FinalizeContext<Shared>, error: unknown): void;
}

export function createAgentFinalizeNode<
  Shared extends AgentRunShared<any, any, any, any>,
  Status extends string = string,
>(options: AgentFinalizeNodeOptions<Shared, Status>): BaseNode<Shared> {
  return new (class AgentFinalizeNode extends BaseNode<Shared> {
    async prep(shared: Shared): Promise<FinalizeContext<Shared>> {
      shared.lifecycle.setPhase(options.finalizePhase);
      return {
        lifecycle: shared.lifecycle,
        hooks: shared.hooks,
        agent: shared.agent,
      };
    }

    async exec(context: FinalizeContext<Shared>): Promise<void> {
      const status = options.computeStatus(context);
      await finalizeLifecycle({
        lifecycle: context.lifecycle,
        runFinalize: () => options.runFinalize(context, status),
        runCleanup: () => options.runCleanup(context),
        onSuccess: options.onSuccess
          ? () => options.onSuccess?.(context)
          : () => {},
        onSecondaryError: options.onSecondaryError
          ? (error) => options.onSecondaryError?.(context, error)
          : undefined,
      });
    }
  })();
}

/**
 * Options for creating a standard finalize node with common defaults.
 * Uses 'error' | 'stopped' status pattern that most agent flows follow.
 */
export interface StandardFinalizeNodeOptions<
  Shared extends AgentRunShared<any, any, any, any>,
> {
  /** Phase name for finalize (typically 'finalize') */
  finalizePhase: Shared['lifecycle']['phase'];
  /** Optional work before calling hooks.end() */
  beforeEnd?(context: FinalizeContext<Shared>): Promise<void>;
  /** Optional callback for secondary errors during finalization */
  onSecondaryError?(context: FinalizeContext<Shared>, error: unknown): void;
}

/**
 * Creates a standard finalize node with common patterns pre-configured.
 *
 * This factory encapsulates the common finalization pattern used across agent flows:
 * - Computes status as 'error' if lifecycle has error, otherwise 'stopped'
 * - Calls optional beforeEnd, then hooks.end(status)
 * - Calls hooks.cleanup()
 * - Sets lifecycle status to 'completed' on success
 *
 * @example
 * ```typescript
 * const finalizeNode = createStandardFinalizeNode<MyShared>({
 *   finalizePhase: 'finalize',
 *   beforeEnd: async ({ hooks }) => {
 *     await hooks.clearPersistedSnapshot();
 *   },
 * });
 * ```
 */
export function createStandardFinalizeNode<
  Shared extends AgentRunShared<any, any, any, any>,
>(options: StandardFinalizeNodeOptions<Shared>): BaseNode<Shared> {
  return createAgentFinalizeNode<Shared, 'error' | 'stopped'>({
    finalizePhase: options.finalizePhase,
    computeStatus: ({ lifecycle }) =>
      lifecycle.error || lifecycle.status === 'error'
        ? END_GROUP_STATUS.ERROR
        : END_GROUP_STATUS.STOPPED,
    runFinalize: async (context, status) => {
      if (options.beforeEnd) {
        await options.beforeEnd(context);
      }
      await context.hooks.end(status);
    },
    runCleanup: async ({ hooks }) => {
      await hooks.cleanup();
    },
    onSuccess: ({ lifecycle }) => {
      lifecycle.complete();
    },
    onSecondaryError: options.onSecondaryError,
  });
}
