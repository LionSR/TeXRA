import { z } from 'zod';

// Internal imports
import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local file imports
import { type NodeExecVoidResult } from './nodeExecution';

// Type imports
import type { AgentRunHooks } from './types';
import type { AgentLifecycle } from './AgentLifecycle';

export interface AgentInitShared<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
}

export interface AgentInitNodeConfig<Shared extends AgentInitShared<any, any>> {
  phase: Shared['lifecycle']['phase'];
  beforeInitialize?(shared: Shared): void | Promise<void>;
  onSuccess(shared: Shared): string | Promise<string | undefined>;
  onFailure?(
    shared: Shared,
    error: unknown,
  ): string | Promise<string | undefined>;
  failureTransition?: string;
}

type AgentInitExecResult = NodeExecVoidResult;

/**
 * Schema for AgentInitNode prep result - single source of truth.
 * Uses z.custom for runtime objects that can't be validated.
 */
const createAgentInitPrepResultSchema = <
  Shared extends AgentInitShared<any, any>,
>() =>
  z.object({
    hooks: z.custom<Shared['hooks']>(),
    shared: z.custom<Shared>(), // Needed for beforeInitialize callback
  });

type AgentInitPrepResult<Shared extends AgentInitShared<any, any>> = z.infer<
  ReturnType<typeof createAgentInitPrepResultSchema<Shared>>
>;

export class AgentInitNode<
  Shared extends AgentInitShared<any, any>,
> extends BaseNode<Shared> {
  constructor(private readonly config: AgentInitNodeConfig<Shared>) {
    super();
  }

  async prep(shared: Shared): Promise<AgentInitPrepResult<Shared>> {
    // Pure extraction - no side effects
    return { hooks: shared.hooks, shared };
  }

  async exec(
    prepRes: AgentInitPrepResult<Shared>,
  ): Promise<AgentInitExecResult> {
    try {
      const runStage = await prepRes.hooks.start();
      await prepRes.hooks.init(runStage);
      if (this.config.beforeInitialize) {
        try {
          await this.config.beforeInitialize(prepRes.shared);
        } catch (hookError) {
          const contextualError =
            hookError instanceof Error
              ? new Error(
                  `Agent initialization failed in beforeInitialize: ${hookError.message}`,
                  { cause: hookError },
                )
              : new Error(
                  `Agent initialization failed in beforeInitialize: ${String(
                    hookError,
                  )}`,
                );
          throw contextualError;
        }
      }
      await prepRes.hooks.initializeClient();
      return {};
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: Shared,
    _prepRes: AgentInitPrepResult<Shared>,
    execRes: AgentInitExecResult,
  ): Promise<string | undefined> {
    // Lifecycle transition at start of post
    shared.lifecycle.begin(this.config.phase);

    if (execRes.error) {
      shared.lifecycle.fail(execRes.error);
      if (this.config.onFailure) {
        return this.config.onFailure(shared, execRes.error);
      }
      return this.config.failureTransition ?? FlowTransition.FINALIZE;
    }

    return this.config.onSuccess(shared);
  }
}
