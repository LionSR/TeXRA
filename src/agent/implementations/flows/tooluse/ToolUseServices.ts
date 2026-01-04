/**
 * Service interfaces for tool-use flow.
 *
 * Following the PocketFlow pattern:
 * - Services are injected via flow.setServices()
 * - Nodes access services via this.services
 * - shared contains mutable runtime state only
 *
 * Architecture (refactored - no closure wrappers):
 * - Services pass context values directly (resolvedTools, snapshot, etc.)
 * - Nodes call helper functions directly with services context
 * - Eliminates closure indirection for cleaner call stacks
 */

import type { AgentRunState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import type { AgentLogger } from '@logger/AgentLogger';
import type { BaseFlowContextInit } from '../common/BaseFlowServices';
import type { IToolUseSession } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

/**
 * Result of preparing initial state for a tool-use session.
 *
 * Returns individual state slices directly instead of wrapping in AgentSharedStore.
 * This eliminates the convert→pass→convert overhead pattern.
 */
export interface PrepareStateResult {
  messages: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  shouldSkipCycle: boolean;
}

/**
 * Services for tool-use flow nodes.
 *
 * Extends BaseFlowContextInit directly with tool-use specific dependencies.
 * Nodes call helper functions directly with these context values (no closures).
 *
 * Refactored architecture:
 * - resolvedTools: Pre-resolved tool definitions (computed once at creation)
 * - snapshot: Resume snapshot for session recovery (null for fresh start)
 * - Nodes import and call helper functions directly
 *
 * Note: ToolUseCycleNode directly instantiates ToolUseCycleFlow (no runCycle indirection).
 * Persistence is handled automatically by PersistedFlow after each node.
 */
export interface ToolUseServices<C = unknown>
  extends BaseFlowContextInit<C> {
  /** Logger (executionContext.logger) */
  readonly logger: AgentLogger;

  /** Narrow setting to tool-use specific type */
  readonly setting: AgentToolUseSetting;

  /** Registry of available tools */
  readonly toolRegistry: IToolRegistry;

  /** Session lifecycle for follow-ups and status management */
  readonly session: IToolUseSession;

  /** Pre-resolved tool definitions (computed once at context creation) */
  readonly resolvedTools: ToolDefinition[];

  /** Resume snapshot for session recovery (null for fresh start) */
  readonly snapshot: ToolUseSessionSnapshot | null;

  /**
   * Get usage recorder callback for tracking round statistics.
   * Returns a callback that will be invoked when a round finalizes.
   */
  readonly getUsageRecorder: () => RoundFinalizedCallback;
}

/**
 * Flow params type for tool-use flows.
 * Alias for base FlowParams - reserved for future use.
 */
export type { FlowParams as ToolUseFlowParams } from '../common';
