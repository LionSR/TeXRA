import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

export interface AgentRunLifecycleBase {
  phase: string;
  status: 'pending' | 'running' | 'error' | 'completed';
  error?: unknown;
}

export interface AgentRunShared<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentRunLifecycleBase,
  Hooks extends AgentRunHooks,
> {
  agent: A;
  state: State;
  lifecycle: Lifecycle;
  hooks: Hooks;
}

export type { AgentRunHooks };
