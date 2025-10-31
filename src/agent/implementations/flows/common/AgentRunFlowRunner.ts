import type { Flow } from '@agent/node';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

import type {
  AgentRunBaseHooks,
  AgentRunLifecycleBase,
  AgentRunShared,
} from './types';

export type AgentRunHookOverrides = Partial<AgentRunBaseHooks>;

type AgentRunInternals<A extends BaseAgent<any>> = A & {
  startRunGroup: BaseAgent<any>['startRunGroup'];
  initializeClient: BaseAgent<any>['initializeClient'];
  endRunGroup: BaseAgent<any>['endRunGroup'];
  cleanup: BaseAgent<any>['cleanup'];
};

export function createBaseRunHooks<A extends BaseAgent<any>>(
  agent: A,
  overrides?: AgentRunHookOverrides,
): AgentRunBaseHooks {
  const agentInternals = agent as AgentRunInternals<A>;

  const baseHooks: AgentRunBaseHooks = {
    start: () => agentInternals.startRunGroup(),
    init: (runGroupId) => agent.init(runGroupId),
    initializeClient: () => agentInternals.initializeClient(),
    end: (status) => agentInternals.endRunGroup(status),
    cleanup: () => agentInternals.cleanup(),
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
