/**
 * ToolUseFlowContext - Factory and helpers for tool-use flow services.
 * Services pass context values directly; nodes call helpers without closures.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';

import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { ToolDefinition } from '@model';
import { getDefaultToolRegistry } from '@tools/registry';
import { buildInitialToolUsePrompts } from '@utils/prompt';
import {
  ToolUseSessionLifecycle,
  type IToolUseSession,
} from './ToolUseSessionLifecycle';

import type { ToolUseServices, PrepareStateResult } from './ToolUseServices';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Configuration for creating tool-use flow services.
 *
 * Extends BaseFlowContextInit with tool-use specific fields.
 */
export interface ToolUseFlowContextInit<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Narrow setting to tool-use specific type */
  setting: AgentToolUseSetting;

  /** Optional tool registry override */
  toolRegistry?: IToolRegistry;

  /** Optional snapshot for session resume */
  resumeSnapshot?: ToolUseSessionSnapshot | null;

  /** Optional usage tracking callback */
  getUsageRecorder?: () => RoundFinalizedCallback;
}

// ============================================================================
// Context Object (simple object, not a class)
// ============================================================================

/**
 * Tool-use flow context returned by factory function.
 * Contains services and lifecycle methods.
 *
 * Note: streamTabId is accessed via services.executionContext.streamId
 * (single source of truth).
 */
export interface ToolUseFlowContext<C = unknown> {
  /** Services for flow execution */
  services: ToolUseServices<C>;

  /** Session lifecycle manager */
  session: ToolUseSessionLifecycle;

  /** Interrupt the session */
  interrupt(): void;

  /** Dispose context resources */
  dispose(): void;
}

// ============================================================================
// Helper Functions (called directly by nodes, no closure wrappers)
// ============================================================================

/**
 * Prepare initial state for tool-use session (new or resumed from snapshot).
 *
 * Returns individual state slices directly instead of wrapping in AgentSharedStore.
 * This eliminates the convert→pass→convert overhead pattern.
 */
export async function prepareInitialState<C>(
  services: ToolUseServices<C>,
): Promise<PrepareStateResult> {
  const { modelHandler, prompt, userVarChannels, logger, snapshot } = services;

  if (snapshot) {
    logger.debug('Resuming tool-use session from saved state.');

    // Reconstruct state slices directly from snapshot (v2 schema - no wrapper)
    const runState = AgentRunState.fromSnapshot(snapshot.run);
    const workspaceState = AgentWorkspaceState.fromSnapshot(snapshot.workspace);
    // User channels from snapshot with frozen input
    const userChannels = {
      input: Object.freeze({ ...snapshot.user.input }),
      transient: { ...snapshot.user.transient },
    };

    return {
      messages: snapshot.messages,
      runState,
      workspaceState,
      userChannels,
      shouldSkipCycle: true,
    };
  }

  // Create fresh state for new sessions
  const runState = new AgentRunState();
  const workspaceState = AgentWorkspaceState.create();

  const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
    await buildInitialToolUsePrompts(prompt, userVarChannels.transient, logger);

  const messages = await modelHandler.initializeMessages(
    userPrefix,
    userRequest,
    undefined,
    systemPrompt ? `${systemPrompt}\n${instructionSuffix}` : instructionSuffix,
  );

  return {
    messages,
    runState,
    workspaceState,
    userChannels: userVarChannels,
    shouldSkipCycle: false,
  };
}

/** Apply a follow-up message to the conversation. */
export async function applyFollowUpMessage<C>(
  services: ToolUseServices<C>,
  followUp: string,
  messages: ProviderMessage[],
): Promise<ProviderMessage[]> {
  services.logger.userMessage(followUp);
  return await services.modelHandler.createUserFollowUpMessages(
    messages,
    followUp,
  );
}

// ============================================================================
// Factory Function
// ============================================================================

/** Creates a ToolUseFlowContext with services and lifecycle methods. */
export function createToolUseFlowContext<C = unknown>(
  init: ToolUseFlowContextInit<C>,
): ToolUseFlowContext<C> {
  const {
    setting,
    logger,
    toolRegistry: customRegistry,
    resumeSnapshot,
    executionContext,
  } = init;

  // Single source of truth: get streamTabId from execution context
  const streamTabId = executionContext.streamId;

  const toolRegistry = customRegistry ?? getDefaultToolRegistry();
  const sessionLifecycle = new ToolUseSessionLifecycle(streamTabId);

  // Resolve tools once at construction time
  const toolConfigs = Array.isArray(setting.tools) ? setting.tools : [];
  const resolvedTools: ToolDefinition[] = [];
  for (const t of toolConfigs) {
    const def = typeof t === 'string' ? { name: t } : t;
    if (!toolRegistry.has(def.name)) {
      logger.warn(`Tool "${def.name}" not found in registry`);
      continue;
    }
    resolvedTools.push(def);
  }

  // Spread init directly - it already contains setting, logger, etc.
  const services: ToolUseServices<C> = {
    ...init,
    toolRegistry, // May differ from init if defaulted
    session: sessionLifecycle,
    resolvedTools,
    snapshot: resumeSnapshot ?? null,
    getUsageRecorder: init.getUsageRecorder ?? (() => async () => {}),
  };

  return {
    services,
    session: sessionLifecycle,

    interrupt(): void {
      init.onInterrupt?.();
      retryCoordinator.clearRequest(streamTabId);
      sessionLifecycle.interrupt();
    },

    dispose(): void {
      sessionLifecycle.dispose();
    },
  };
}
