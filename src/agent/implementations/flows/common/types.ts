import { z } from 'zod';

import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

/** Lifecycle status for agent runs. */
export const AGENT_LIFECYCLE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  ERROR: 'error',
  COMPLETED: 'completed',
} as const;

export const AgentLifecycleStatusSchema = z.enum([
  AGENT_LIFECYCLE_STATUS.PENDING,
  AGENT_LIFECYCLE_STATUS.RUNNING,
  AGENT_LIFECYCLE_STATUS.ERROR,
  AGENT_LIFECYCLE_STATUS.COMPLETED,
]);

export type AgentLifecycleStatus = z.infer<typeof AgentLifecycleStatusSchema>;

/** Generic lifecycle state with category-specific phases. */
export interface AgentLifecycleState<Phase extends string> {
  phase: Phase;
  status: AgentLifecycleStatus;
  error?: unknown;
}

/** Generic shared state for agent flow execution. */
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
