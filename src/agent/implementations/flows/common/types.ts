import type { AgentLifecycleHooks } from '@agent/implementations/flows/common/AgentLifecycleController';
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
  Hooks extends AgentLifecycleHooks,
> {
  agent: A;
  state: State;
  lifecycle: Lifecycle;
  hooks: Hooks;
}
