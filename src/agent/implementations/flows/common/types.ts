import { z } from 'zod';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

/**
 * Agent lifecycle status - single source of truth for agent run state.
 */
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

export interface AgentLifecycleState<Phase extends string> {
  phase: Phase;
  status: AgentLifecycleStatus;
  error?: unknown;
}

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
