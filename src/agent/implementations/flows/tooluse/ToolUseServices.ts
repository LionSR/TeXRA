/**
 * Service interfaces for tool-use flow.
 *
 * Following the PocketFlow pattern:
 * - Services are injected via flow.setServices()
 * - Nodes access services via this.services
 * - shared contains mutable runtime state only
 *
 * ToolUseServices extends BaseFlowServices with tool-use specific
 * dependencies (tool registry, session, cycle operations).
 */

import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { AgentRunState } from '@agent/core/AgentState';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import type { AgentLogger } from '@logger/AgentLogger';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { IToolUseSession } from './ToolUseSessionLifecycle';

// Note: RunCycleResult was removed - ToolUseCycleNode now directly runs ToolUseCycleFlow

/**
 * Result of preparing initial state for a tool-use session.
 */
export interface PrepareStateResult {
  messages: ProviderMessage[];
  store: AgentSharedStore;
  shouldSkipCycle: boolean;
  runState: AgentRunState;
}

/**
 * Services for tool-use flow nodes.
 *
 * Extends BaseFlowContextInit directly with tool-use specific dependencies:
 * - toolRegistry: Available tools for the agent
 * - session: Session lifecycle management (follow-ups, status)
 * - Operations: prepareState, buildCycleOptions, applyFollowUpMessage
 *
 * Note: ToolUseCycleNode directly instantiates ToolUseCycleFlow (no runCycle indirection).
 * Persistence is handled automatically by PersistedFlow after each node.
 */
export interface ToolUseServices<C = unknown> extends BaseFlowContextInit<C> {
  /** Logger for debugging and progress */
  readonly logger: AgentLogger;

  /** Execution context (IDs, storage key, etc.) */
  readonly context: AgentExecutionContext;
  /** Narrow setting to tool-use specific type */
  readonly setting: AgentToolUseSetting;

  /** Registry of available tools */
  readonly toolRegistry: IToolRegistry;

  /** Session lifecycle for follow-ups and status management */
  readonly session: IToolUseSession;

  // =========================================================================
  // Cycle Operations
  // These are agent-specific operations that nodes invoke via services.
  // =========================================================================

  /**
   * Prepare initial state for the tool-use session.
   * Handles both new sessions and resumed sessions from snapshots.
   */
  readonly prepareState: () => Promise<PrepareStateResult>;

  /**
   * Build cycle options for tool-use execution.
   */
  readonly buildCycleOptions: (
    store: AgentSharedStore,
  ) => ToolUseCycleOptions<C>;

  /**
   * Apply a follow-up message to the conversation.
   */
  readonly applyFollowUpMessage: (
    message: string,
    conversation: ProviderMessage[],
  ) => Promise<ProviderMessage[]>;
}

/**
 * Flow params type for tool-use flows.
 * Alias for base FlowParams - reserved for future use.
 */
export type { FlowParams as ToolUseFlowParams } from '../common';
