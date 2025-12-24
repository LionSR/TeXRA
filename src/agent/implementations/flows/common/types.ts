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
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';
import type { AgentLifecycle } from './AgentLifecycle';

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

export type { AgentRunHooks };
