// Internal imports
import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local file imports
import { runNodeEffect, type NodeExecVoidResult } from './nodeExecution';

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

export class AgentInitNode<
  Shared extends AgentInitShared<any, any>,
> extends BaseNode<Shared> {
  constructor(private readonly config: AgentInitNodeConfig<Shared>) {
    super();
  }

  async prep(shared: Shared): Promise<Shared> {
    shared.lifecycle.begin(this.config.phase);
    return shared;
  }

  async exec(shared: Shared): Promise<AgentInitExecResult> {
    return runNodeEffect(async () => {
      const runStage = await shared.hooks.start();
      await shared.hooks.init(runStage);
      if (this.config.beforeInitialize) {
        try {
          await this.config.beforeInitialize(shared);
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
      await shared.hooks.initializeClient();
    });
  }

  async post(
    shared: Shared,
    _prepRes: Shared,
    execRes: AgentInitExecResult,
  ): Promise<string | undefined> {
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
