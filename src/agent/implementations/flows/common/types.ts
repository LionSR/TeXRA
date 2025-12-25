/**
 * Core types for agent flow execution.
 *
 * Provides the shared state container used by all agent run flows.
 */

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';
import type { AgentLifecycle } from './AgentLifecycle';

/**
 * Generic shared state for agent flow execution.
 *
 * This is the core container that flows use to coordinate:
 * - agent: The agent instance being run
 * - state: Flow-specific mutable runtime state
 * - lifecycle: Phase and status tracking
 * - hooks: Callbacks for lifecycle events
 */
export interface AgentRunShared<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
> {
  agent: A;
  state: State;
  lifecycle: Lifecycle;
  hooks: Hooks;
}

/**
 * Base type alias for flow shared state constraints.
 * Use this instead of repeating the full generic constraint.
 */
export type BaseFlowShared = AgentRunShared<
  BaseAgent<any>,
  any,
  AgentLifecycle<string>,
  AgentRunHooks
>;

// ============================================================================
// Node Result Types
// ============================================================================

/**
 * Result type for node exec methods that return a value.
 * Use inline try/catch in exec() and return { result } on success or { error } on failure.
 *
 * Note: For invocation nodes with retry support, use InvocationResult from RetryState.ts instead.
 */
export type NodeExecResult<T> =
  | { result: T; error?: undefined }
  | { error: unknown; result?: undefined };
