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
  Status extends string = string,
> {
  finalizePhase: Shared['lifecycle']['phase'];
  computeStatus(
    context: FinalizeNodeContext<
      Shared['lifecycle'],
      Shared['hooks'],
      Shared['agent']
    >,
  ): Status;
  runFinalize(
    context: FinalizeNodeContext<
      Shared['lifecycle'],
      Shared['hooks'],
      Shared['agent']
    >,
    status: Status,
  ): Promise<void>;
  runCleanup(
    context: FinalizeNodeContext<
      Shared['lifecycle'],
      Shared['hooks'],
      Shared['agent']
    >,
  ): Promise<void>;
  onSuccess?(
    context: FinalizeNodeContext<
      Shared['lifecycle'],
      Shared['hooks'],
      Shared['agent']
    >,
  ): void | Promise<void>;
  onSecondaryError?(
    context: FinalizeNodeContext<
      Shared['lifecycle'],
      Shared['hooks'],
      Shared['agent']
    >,
    error: unknown,
  ): void;
}

export function createAgentFinalizeNode<
  Shared extends AgentRunShared<any, any, any, any>,
  Status extends string = string,
>(options: AgentFinalizeNodeOptions<Shared, Status>): BaseNode<Shared> {
  return new (class AgentFinalizeNode extends BaseNode<Shared> {
    async prep(
      shared: Shared,
    ): Promise<
      FinalizeNodeContext<
        Shared['lifecycle'],
        Shared['hooks'],
        Shared['agent']
      >
    > {
      setLifecyclePhase(shared.lifecycle, options.finalizePhase);
      return {
        lifecycle: shared.lifecycle,
        hooks: shared.hooks,
        agent: shared.agent,
      } satisfies FinalizeNodeContext<
        Shared['lifecycle'],
        Shared['hooks'],
        Shared['agent']
      >;
    }

    async exec(
      context: FinalizeNodeContext<
        Shared['lifecycle'],
        Shared['hooks'],
        Shared['agent']
      >,
    ): Promise<void> {
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
