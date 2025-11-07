import { z } from 'zod';

import { AgentRunState } from '@agent/core/AgentState';
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

export type AgentLifecycleStatus =
  | 'pending'
  | 'running'
  | 'error'
  | 'completed';

export interface AgentLifecycleState<Phase extends string> {
  phase: Phase;
  status: AgentLifecycleStatus;
  error?: unknown;
}

export const BaseRunStateSchema = z.object({
  messages: z.array(z.any()),
  runState: z.instanceof(AgentRunState),
});

export interface AgentRunShared<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentLifecycleState<string>,
  Hooks extends AgentRunHooks,
> {
  agent: A;
  state: State;
  lifecycle: Lifecycle;
  hooks: Hooks;
}

export type { AgentRunHooks };
