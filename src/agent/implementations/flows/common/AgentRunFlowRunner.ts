/**
 * Agent flow runner - executes agent flows with lifecycle management.
 *
 * Exports:
 * - AgentRunShared: Generic shared state container for all flows
 * - AgentRunFlowOptions: Options for running agent flows
 * - runAgentFlow: Flow execution
 * - InitExecResult, NodeExecResult: Shared result types for nodes
 * - BaseRunStateSchema: Common state schema fields for extension
 *
 * Lifecycle methods (startRun, initRun, endRun, cleanupRun) are called directly
 * on the agent via IFlowAgent interface. Flow-specific hooks (e.g., prepareState,
 * buildCycleOptions) are provided directly by the caller.
 */

import { z } from 'zod';

// Type imports
import type { Flow } from '@agent/node';
import type { IFlowAgent } from '@agent/core/IAgent';
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentLifecycle } from './AgentLifecycle';

// ============================================================================
// Result Types - Shared discriminated unions for node exec methods
// ============================================================================

/**
 * Result type for init node exec methods.
 * Uses 'kind' discriminant for clarity.
 */
export type InitExecResult =
  | { kind: 'success' }
  | { kind: 'error'; error: unknown };

/**
 * Generic result type for exec methods that return a value.
 * Uses 'kind' discriminant for consistency with InitExecResult.
 */
export type NodeExecResult<T> =
  | { kind: 'success'; result: T }
  | { kind: 'error'; error: unknown };

// ============================================================================
// Schema Types - Common state schema for flow state serialization
// ============================================================================

/**
 * Base schema for agent run state, shared by all flows.
 * Use .extend() to add flow-specific fields.
 *
 * @example
 * ```typescript
 * const ToolUseRunStateSchema = BaseRunStateSchema.extend({
 *   cycleOptions: z.unknown().nullable(),
 *   store: AgentSharedStoreSnapshotSchema.nullable(),
 * });
 * ```
 */
export const BaseRunStateSchema = z.object({
  runState: AgentRunStateSnapshotSchema,
  conversation: z.array(ProviderMessageSchema),
});

// ============================================================================
// Core Types
// ============================================================================

/**
 * Generic shared state for agent flow execution.
 *
 * This is the core container that flows use to coordinate:
 * - agent: The agent instance being run (IFlowAgent for lifecycle methods)
 * - state: Flow-specific mutable runtime state
 * - lifecycle: Phase and status tracking
 * - hooks: Flow-specific callbacks (not lifecycle - those are on agent)
 *
 * Lifecycle methods (startRun, initRun, endRun, cleanupRun) are on the agent.
 * Hooks are flow-specific only (e.g., prepareState, buildCycleOptions).
 */
export interface AgentRunShared<
  A extends IFlowAgent,
  State,
  Lifecycle extends AgentLifecycle<string>,
  Hooks,
> {
  agent: A;
  state: State;
  lifecycle: Lifecycle;
  hooks: Hooks;
}

/**
 * Base type alias for flow shared state constraints.
 * Internal only - not exported from common/index.ts.
 */
type BaseFlowShared = AgentRunShared<IFlowAgent, any, AgentLifecycle<string>, unknown>;

// ============================================================================
// Flow Runner
// ============================================================================

/**
 * Options for running an agent flow.
 *
 * Simplified interface - caller provides hooks directly (no assembly pattern).
 * Lifecycle methods are called on agent directly by flow nodes.
 */
export interface AgentRunFlowOptions<Shared extends BaseFlowShared> {
  agent: Shared['agent'];
  lifecycle: Shared['lifecycle'];
  hooks: Shared['hooks'];
  createState(): Shared['state'];
  createFlow(): Flow<Shared>;
  prepareShared?(shared: Shared): void;
}

/**
 * Execute an agent flow with the given options.
 *
 * Creates shared state, runs the flow, and handles errors.
 * Lifecycle methods are called directly on agent by flow nodes.
 */
export async function runAgentFlow<Shared extends BaseFlowShared>(
  options: AgentRunFlowOptions<Shared>,
): Promise<Shared> {
  const state = options.createState();

  const shared = {
    agent: options.agent,
    state,
    lifecycle: options.lifecycle,
    hooks: options.hooks,
  } as Shared;

  options.prepareShared?.(shared);

  const flow = options.createFlow();
  await flow.run(shared);

  if (shared.lifecycle.error) {
    throw shared.lifecycle.error;
  }

  return shared;
}
