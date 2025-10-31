import type { Flow } from '@agent/node';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

import type {
  AgentRunHooks,
  AgentRunLifecycleBase,
  AgentRunShared,
} from './types';

export type AgentRunHookOverrides = Partial<AgentRunHooks>;

export interface AgentRunFlowOptions<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentRunLifecycleBase,
  Hooks extends AgentRunHooks,
  Shared extends AgentRunShared<A, State, Lifecycle, Hooks>,
> {
  agent: A;
  lifecycle: Lifecycle;
  createState(): State;
  createFlow(): Flow<Shared>;
  extendHooks?(baseHooks: AgentRunHooks): Hooks;
  hookOverrides?: AgentRunHookOverrides;
  prepareShared?(shared: Shared): void;
}

export async function runAgentFlow<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentRunLifecycleBase,
  Hooks extends AgentRunHooks,
  Shared extends AgentRunShared<A, State, Lifecycle, Hooks>,
>(
  options: AgentRunFlowOptions<A, State, Lifecycle, Hooks, Shared>,
): Promise<Shared> {
  const state = options.createState();
  const baseHooks = options.agent.getRunHooks(options.hookOverrides);
  const hooks = options.extendHooks
    ? options.extendHooks(baseHooks)
    : (baseHooks as Hooks);

  const shared = {
    agent: options.agent,
    state,
    lifecycle: options.lifecycle,
    hooks,
  } as Shared;

  options.prepareShared?.(shared);

  const flow = options.createFlow();
  await flow.run(shared);

  if (shared.lifecycle.error) {
    throw shared.lifecycle.error;
  }

  return shared;
}
