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
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { IToolUseSession } from '@agent/toolUse/ToolUseSessionLifecycle';
import type { BaseFlowServices } from '@agent/implementations/flows/common';

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
 * Result of running a tool-use cycle.
 */
export interface RunCycleResult {
  failedWithError: boolean;
  errorMessage?: string;
  userCancelled: boolean;
}

/**
 * Services provided by BaseToolUseAgent for flow nodes.
 *
 * Extends BaseFlowServices with tool-use specific dependencies:
 * - toolRegistry: Available tools for the agent
 * - session: Session lifecycle management (persistence, follow-ups)
 * - Operations: prepareState, buildCycleOptions, runCycle, persistCheckpoint
 *
 * The agent becomes a "service provider" - it holds these but doesn't
 * execute logic. Nodes do the work using these services.
 */
export interface ToolUseServices<C = unknown> extends BaseFlowServices<C> {
  /** Registry of available tools */
  readonly toolRegistry: IToolRegistry;

  /** Session lifecycle for persistence and follow-ups */
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
  readonly buildCycleOptions: (store: AgentSharedStore) => ToolUseCycleOptions<C>;

  /**
   * Run a single tool-use cycle.
   */
  readonly runCycle: (
    options: ToolUseCycleOptions<C>,
    messages: ProviderMessage[],
    store: AgentSharedStore,
  ) => Promise<RunCycleResult>;

  /**
   * Persist checkpoint for session recovery.
   */
  readonly persistCheckpoint: (
    messages: ProviderMessage[],
    store: AgentSharedStore,
  ) => Promise<void>;

  /**
   * Apply a follow-up message to the conversation.
   */
  readonly applyFollowUpMessage: (
    message: string,
    conversation: ProviderMessage[],
  ) => Promise<ProviderMessage[]>;
}

/**
 * Params type for tool-use flow nodes.
 *
 * With native services support, params is now separate from services:
 * - services: Immutable dependencies (set via flow.setServices())
 * - params: Per-execution parameters (can vary per batch item)
 *
 * For tool-use flow, params is currently empty but reserved for future use.
 */
export interface ToolUseFlowParams {
  [key: string]: unknown;
}
