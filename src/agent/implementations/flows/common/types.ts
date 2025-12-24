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
 * 1. **AgentLifecycleState<Phase>** - Tracks execution progress with phase and status
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
import { z } from 'zod';

// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { BaseAgent } from '@agent/implementations/BaseAgent';

// ============================================================================
// LIFECYCLE STATUS - Shared across all agent categories
// ============================================================================

/**
 * Agent lifecycle status - single source of truth for agent run state.
 * These statuses apply to all agent categories (workflow, tool-use, etc.)
 */
export const AGENT_LIFECYCLE_STATUS = {
  /** Flow created but not yet started */
  PENDING: 'pending',
  /** Flow is actively executing */
  RUNNING: 'running',
  /** Flow encountered an error */
  ERROR: 'error',
  /** Flow completed successfully */
  COMPLETED: 'completed',
} as const;

export const AgentLifecycleStatusSchema = z.enum([
  AGENT_LIFECYCLE_STATUS.PENDING,
  AGENT_LIFECYCLE_STATUS.RUNNING,
  AGENT_LIFECYCLE_STATUS.ERROR,
  AGENT_LIFECYCLE_STATUS.COMPLETED,
]);

export type AgentLifecycleStatus = z.infer<typeof AgentLifecycleStatusSchema>;

// ============================================================================
// LIFECYCLE STATE - Generic phase tracking
// ============================================================================

/**
 * Generic lifecycle state for agent runs.
 *
 * The Phase type parameter allows category-specific phases:
 * - Workflow: 'idle' | 'init' | 'rounds' | 'finalize'
 * - ToolUse: 'idle' | 'init' | 'prepare' | 'cycle' | 'finalize'
 *
 * @template Phase - String literal union of valid phases for this flow
 */
export interface AgentLifecycleState<Phase extends string> {
  /** Current phase in the flow */
  phase: Phase;
  /** Overall execution status */
  status: AgentLifecycleStatus;
  /** Error captured during execution, if any */
  error?: unknown;
}

// ============================================================================
// SHARED FLOW COORDINATION - Generic container for flow execution
// ============================================================================

/**
 * Generic shared state container for agent flow execution.
 *
 * This interface coordinates all the components needed during flow execution:
 * - agent: The agent instance being run
 * - state: Mutable runtime state (messages, round info, etc.)
 * - lifecycle: Phase and status tracking
 * - hooks: Callbacks for lifecycle events
 *
 * Category-specific types specialize this generic:
 * - ReflectionRunShared<C> for workflow agents
 * - ToolUseRunShared<C> for tool-use agents
 *
 * @template A - Agent type (extends BaseAgent)
 * @template State - Runtime state type (ReflectionRunState, ToolUseRunState)
 * @template Lifecycle - Lifecycle state with category-specific phases
 * @template Hooks - Hook interface with category-specific callbacks
 */
export interface AgentRunShared<
  A extends BaseAgent<any>,
  State,
  Lifecycle extends AgentLifecycleState<string>,
  Hooks extends AgentRunHooks,
> {
  /** The agent instance being executed */
  agent: A;
  /** Mutable runtime state for this flow */
  state: State;
  /** Lifecycle tracking (phase and status) */
  lifecycle: Lifecycle;
  /** Callback hooks for lifecycle events */
  hooks: Hooks;
}

// Re-export base hooks interface from core
export type { AgentRunHooks };
