/**
 * Agent flow runner - executes agent flows with hooks and lifecycle management.
 *
 * Exports:
 * - AgentRunShared: Generic shared state container for all flows
 * - AgentRunFlowOptions: Options for running agent flows
 * - runAgentFlow: Flow execution with hook assembly
 * - InitExecResult, NodeExecResult: Shared result types for nodes
 * - BaseRunStateSchema: Common state schema fields for extension
 *
 * Internal only:
 * - BaseFlowShared: Type constraint alias (used internally)
 * - AgentRunHookOverrides: Hook override partial type (used internally)
 */

import { z } from 'zod';

// Type imports
import type { Flow } from '@agent/node';
import type { AgentRunHooks, IFlowAgent } from '@agent/core/IAgent';
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
 * - agent: The agent instance being run
 * - state: Flow-specific mutable runtime state
 * - lifecycle: Phase and status tracking
 * - hooks: Callbacks for lifecycle events
 *
 * The agent type constraint uses IFlowAgent to enable proper decoupling
 * from concrete agent implementations.
 */
export interface AgentRunShared<
  A extends IFlowAgent,
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
 * Internal only - not exported from common/index.ts.
 */
type BaseFlowShared = AgentRunShared<
  IFlowAgent,
  any,
  AgentLifecycle<string>,
  AgentRunHooks
>;

// ============================================================================
// Flow Runner
// ============================================================================

/** Internal type for hook override options. */
type AgentRunHookOverrides = Partial<AgentRunHooks>;

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
