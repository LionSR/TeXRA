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
 * Prep result for AgentInitNode - extracted from shared.
 */
interface AgentInitPrepResult<Shared extends AgentInitShared<any, any>> {
  hooks: Shared['hooks'];
  shared: Shared; // Needed for beforeInitialize callback
  lifecycle: Shared['lifecycle'];
}

export class AgentInitNode<
  Shared extends AgentInitShared<any, any>,
> extends BaseNode<Shared> {
  constructor(private readonly config: AgentInitNodeConfig<Shared>) {
    super();
  }

  async prep(shared: Shared): Promise<AgentInitPrepResult<Shared>> {
    // Pure extraction - no side effects
    return { hooks: shared.hooks, shared, lifecycle: shared.lifecycle };
  }

  async exec(
    prepRes: AgentInitPrepResult<Shared>,
  ): Promise<AgentInitExecResult> {
    // Signal phase entry before work begins (status tracking, not flow state)
    prepRes.lifecycle.begin(this.config.phase);

    try {
      const runStage = await prepRes.hooks.start();
      await prepRes.hooks.init(runStage);
      if (this.config.beforeInitialize) {
        await this.config.beforeInitialize(prepRes.shared);
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
