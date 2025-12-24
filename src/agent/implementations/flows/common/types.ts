/**
 * @file Common types for agent flow execution.
 *
 * This module provides shared type infrastructure used by both workflow
 * (reflection) and tool-use agent flows. These types enable a consistent
 * execution pattern across different agent categories while allowing
 * category-specific customization.
 *
 * ## Architecture
 *
 * The flow type system is built around these key abstractions:
 *
 * 1. **AgentLifecycle<Phase>** - State machine for lifecycle management
 * 2. **AgentRunShared<A, State, Lifecycle, Hooks>** - Coordinates flow execution
 * 3. **AgentRunHooks** - Core lifecycle callbacks (start, init, end, cleanup)
 *
 * Category-specific flows (workflow, tool-use) extend these types:
 * - ReflectionRunState, ReflectionRunHooks, ReflectionRunShared
 * - ToolUseRunState, ToolUseRunHooks, ToolUseRunShared
 *
 * @see ReflectionRunFlow.ts for workflow-specific types
 * @see ToolUseRunFlow.ts for tool-use-specific types
 */

// Type imports
import type { BaseNode } from '@agent/node';
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';
import type { AgentLifecycle } from './AgentLifecycle';

// ============================================================================
// Core Flow Types
// ============================================================================

/** Generic shared state for agent flow execution. */
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
 * Link between flow nodes. Single source of truth.
 *
 * Used by buildRunFlow and createAgentRunFlow to define the flow graph.
 * When `to` is undefined, the link targets the finalize node.
 */
export interface FlowLink<Shared> {
  from: BaseNode<Shared>;
  on: string;
  to?: BaseNode<Shared>;
}

/**
 * Base type alias for flow shared state constraints.
 *
 * Use this instead of repeating the full generic constraint.
 * Reduces duplication in AgentRunFlowRunner.ts and similar files.
 */
export type BaseFlowShared = AgentRunShared<
  BaseAgent<any>,
  any,
  AgentLifecycle<string>,
  AgentRunHooks
>;

export type { AgentRunHooks };
