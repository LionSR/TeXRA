// Type imports
import type { Flow } from '@agent/node';
import type { BaseAgent } from '@agent/implementations/BaseAgent';
import type {
  AgentRunHooks,
  AgentLifecycleState,
  AgentRunShared,
} from './types';

export type AgentRunHookOverrides = Partial<AgentRunHooks>;

type AgentRunFlowOptionsBase<
  Shared extends AgentRunShared<
    BaseAgent<any>,
    any,
    AgentLifecycleState<string>,
    AgentRunHooks
  >,
> = {
  agent: Shared['agent'];
  lifecycle: Shared['lifecycle'];
  createState(): Shared['state'];
  createFlow(): Flow<Shared>;
  hookOverrides?: AgentRunHookOverrides;
  prepareShared?(shared: Shared): void;
};

type AgentRunFlowOptionsWithExtend<
  Shared extends AgentRunShared<
    BaseAgent<any>,
    any,
    AgentLifecycleState<string>,
    AgentRunHooks
  >,
> = AgentRunFlowOptionsBase<Shared> & {
  extendHooks: (baseHooks: AgentRunHooks) => Shared['hooks'];
};

type AgentRunFlowOptionsWithoutExtend<
  Shared extends AgentRunShared<
    BaseAgent<any>,
    any,
    AgentLifecycleState<string>,
    AgentRunHooks
  >,
> =
  Shared extends AgentRunShared<any, any, any, AgentRunHooks>
    ? AgentRunFlowOptionsBase<Shared> & { extendHooks?: undefined }
    : never;

export type AgentRunFlowOptions<
  Shared extends AgentRunShared<
    BaseAgent<any>,
    any,
    AgentLifecycleState<string>,
    AgentRunHooks
  >,
> =
  | AgentRunFlowOptionsWithExtend<Shared>
  | AgentRunFlowOptionsWithoutExtend<Shared>;

function hasExtendHooks<
  Shared extends AgentRunShared<
    BaseAgent<any>,
    any,
    AgentLifecycleState<string>,
    AgentRunHooks
  >,
>(
  options: AgentRunFlowOptions<Shared>,
): options is AgentRunFlowOptionsWithExtend<Shared> {
  return (
    typeof (options as AgentRunFlowOptionsWithExtend<Shared>).extendHooks ===
    'function'
  );
}

export async function runAgentFlow<
  Shared extends AgentRunShared<
    BaseAgent<any>,
    any,
    AgentLifecycleState<string>,
    AgentRunHooks
  >,
>(options: AgentRunFlowOptions<Shared>): Promise<Shared> {
  const state = options.createState();

  // Get hooks - either extend base hooks or use them directly
  const baseHooks = options.agent.getRunHooks(options.hookOverrides);
  const hooks = hasExtendHooks(options)
    ? options.extendHooks(baseHooks)
    : baseHooks;

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
