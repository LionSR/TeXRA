// Type imports
import type { Flow } from '@agent/node';
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentRunShared, BaseFlowShared } from './types';

export type AgentRunHookOverrides = Partial<AgentRunHooks>;

/**
 * Base options for running an agent flow.
 */
type AgentRunFlowOptionsBase<Shared extends BaseFlowShared> = {
  agent: Shared['agent'];
  lifecycle: Shared['lifecycle'];
  createState(): Shared['state'];
  createFlow(): Flow<Shared>;
  hookOverrides?: AgentRunHookOverrides;
  prepareShared?(shared: Shared): void;
};

/**
 * Options when hooks need to be extended with flow-specific methods.
 */
type AgentRunFlowOptionsWithExtend<Shared extends BaseFlowShared> =
  AgentRunFlowOptionsBase<Shared> & {
    extendHooks: (baseHooks: AgentRunHooks) => Shared['hooks'];
  };

/**
 * Options when base hooks are sufficient (no extension needed).
 */
type AgentRunFlowOptionsWithoutExtend<Shared extends BaseFlowShared> =
  Shared extends AgentRunShared<any, any, any, AgentRunHooks>
    ? AgentRunFlowOptionsBase<Shared> & { extendHooks?: undefined }
    : never;

/**
 * Union of all valid options for running an agent flow.
 */
export type AgentRunFlowOptions<Shared extends BaseFlowShared> =
  | AgentRunFlowOptionsWithExtend<Shared>
  | AgentRunFlowOptionsWithoutExtend<Shared>;

function hasExtendHooks<Shared extends BaseFlowShared>(
  options: AgentRunFlowOptions<Shared>,
): options is AgentRunFlowOptionsWithExtend<Shared> {
  return (
    typeof (options as AgentRunFlowOptionsWithExtend<Shared>).extendHooks ===
    'function'
  );
}

/**
 * Execute an agent flow with the given options.
 *
 * Creates shared state, assembles hooks, runs the flow, and handles errors.
 */
export async function runAgentFlow<Shared extends BaseFlowShared>(
  options: AgentRunFlowOptions<Shared>,
): Promise<Shared> {
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
