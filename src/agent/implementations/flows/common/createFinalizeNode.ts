// Local imports - core flow primitives
import { BaseNode } from '@agent/node';

// Internal imports
import { finalizeLifecycle } from './finalizeLifecycle';
import { setLifecyclePhase } from './lifecycle';

// Type imports
import type { AgentRunShared } from './types';
import type { FinalizeNodeContext } from './nodeExecution';

export interface AgentFinalizeNodeOptions<
  Shared extends AgentRunShared<any, any, any, any>,
  Status extends 'error' | 'stopped' = 'error' | 'stopped',
> {
  finalizePhase: Shared['lifecycle']['phase'];
  computeStatus(
    context: FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>,
  ): Status;
  runFinalize(
    context: FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>,
    status: Status,
  ): Promise<void>;
  runCleanup(
    context: FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>,
  ): Promise<void>;
  onSuccess?(
    context: FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>,
  ): void | Promise<void>;
  onSecondaryError?(
    context: FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>,
    error: unknown,
  ): void;
}

export function createAgentFinalizeNode<
  Shared extends AgentRunShared<any, any, any, any>,
  Status extends 'error' | 'stopped' = 'error' | 'stopped',
>(options: AgentFinalizeNodeOptions<Shared, Status>): BaseNode<Shared> {
  return new (class AgentFinalizeNode extends BaseNode<Shared> {
    async prep(
      shared: Shared,
    ): Promise<FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>> {
      setLifecyclePhase(shared.lifecycle, options.finalizePhase);
      return {
        lifecycle: shared.lifecycle,
        hooks: shared.hooks,
      } satisfies FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>;
    }

    async exec(
      context: FinalizeNodeContext<Shared['lifecycle'], Shared['hooks']>,
    ): Promise<void> {
      const status = options.computeStatus(context);
      const runOnSuccess = options.onSuccess
        ? () => {
            void options.onSuccess?.(context);
          }
        : () => {};
      const handleSecondaryError = options.onSecondaryError
        ? (error: unknown) => options.onSecondaryError?.(context, error)
        : undefined;
      await finalizeLifecycle({
        lifecycle: context.lifecycle,
        runFinalize: () => options.runFinalize(context, status),
        runCleanup: () => options.runCleanup(context),
        onSuccess: runOnSuccess,
        onSecondaryError: handleSecondaryError,
      });
    }
  })();
}
