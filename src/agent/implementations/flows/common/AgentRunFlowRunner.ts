import type { Flow } from '@agent/node';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

import type {
  AgentRunBaseHooks,
  AgentRunLifecycleBase,
  AgentRunShared,
} from './types';

export type AgentRunHookOverrides = Partial<AgentRunBaseHooks>;

export function createBaseRunHooks<A extends BaseAgent<any>>(
  agent: A,
  overrides?: AgentRunHookOverrides,
): AgentRunBaseHooks {
  const baseHooks: AgentRunBaseHooks = {
    start: () => agent.startRunGroup(),
    init: (runGroupId) => agent.init(runGroupId),
    initializeClient: () => agent.initializeClient(),
    end: (status) => agent.endRunGroup(status),
    cleanup: () => agent.cleanup(),
  };

  return {
    start: overrides?.start ?? baseHooks.start,
    init: overrides?.init ?? baseHooks.init,
    initializeClient: overrides?.initializeClient ?? baseHooks.initializeClient,
    end: overrides?.end ?? baseHooks.end,
    cleanup: overrides?.cleanup ?? baseHooks.cleanup,
  };
}

export interface AgentRunFlowOptions<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentRunLifecycleBase,
  Hooks extends AgentRunBaseHooks,
  Shared extends AgentRunShared<A, State, Lifecycle, Hooks>,
> {
  agent: A;
  lifecycle: Lifecycle;
  createState(): State;
  createFlow(): Flow<Shared>;
  extendHooks?(baseHooks: AgentRunBaseHooks): Hooks;
  hookOverrides?: AgentRunHookOverrides;
  prepareShared?(shared: Shared): void;
}

export async function runAgentFlow<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentRunLifecycleBase,
  Hooks extends AgentRunBaseHooks,
  Shared extends AgentRunShared<A, State, Lifecycle, Hooks>,
>(
  options: AgentRunFlowOptions<A, State, Lifecycle, Hooks, Shared>,
): Promise<Shared> {
  const state = options.createState();
  const baseHooks = createBaseRunHooks(options.agent, options.hookOverrides);
  const hooks = options.extendHooks
    ? options.extendHooks(baseHooks)
    : (baseHooks as Hooks);

  const shared: Shared = {
    agent: options.agent,
    state,
    lifecycle: options.lifecycle,
    hooks,
  };

  options.prepareShared?.(shared);

  const flow = options.createFlow();
  await flow.run(shared);

  if (shared.lifecycle.error) {
    throw shared.lifecycle.error;
  }

  return shared;
}
