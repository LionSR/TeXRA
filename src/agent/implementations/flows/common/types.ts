import type { BaseAgent } from '@agent/implementations/BaseAgent';

export interface AgentRunLifecycleBase {
  phase: string;
  status: 'pending' | 'running' | 'error' | 'completed';
  error?: unknown;
}

export interface AgentRunBaseHooks {
  start(): Promise<string | undefined>;
  init(runGroupId: string | undefined): Promise<void>;
  initializeClient(): Promise<void>;
  end(status: 'stopped' | 'error'): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export interface AgentRunShared<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentRunLifecycleBase,
  Hooks extends AgentRunBaseHooks,
> {
  agent: A;
  state: State;
  lifecycle: Lifecycle;
  hooks: Hooks;
}
