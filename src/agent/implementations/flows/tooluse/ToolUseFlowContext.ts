/**
 * ToolUseFlowContext - Simple factory function for tool-use flow services.
 *
 * Creates all services needed by ToolUseRunFlow:
 * - Session lifecycle management (follow-ups, status)
 * - Tool registry and resolution
 * - Cycle execution options
 *
 * Note: Persistence is handled automatically by PersistedFlow.
 */

import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentSharedStore, ToolUseStore } from '@agent/core/AgentSharedStore';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ToolUseCycleOptions } from '@agent/core/flows/CycleServices';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';

import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { createToolUseStore } from '@agent/core/AgentSharedStore';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { ToolDefinition } from '@model';
import { getDefaultToolRegistry } from '@tools/registry';
import { buildInitialToolUsePrompts } from '@utils/prompt';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';

import { buildBaseFlowServices, buildBaseCycleOptions } from '../common';
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

  /** Stream tab ID for registry tracking */
  streamTabId: StreamTabId;

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
 */
export interface ToolUseFlowContext<C = unknown> {
  /** Services for flow execution */
  services: ToolUseServices<C>;

  /** Stream tab ID for this session */
  streamTabId: StreamTabId;

  /** Session lifecycle manager */
  session: ToolUseSessionLifecycle;

  /** Interrupt the session */
  interrupt(): void;

  /** Dispose context resources */
  dispose(): void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolves tool definitions from setting at construction time.
 * This is computed once and cached to avoid repeated registry lookups.
 */
function resolveToolsFromSetting(
  setting: AgentToolUseSetting,
  toolRegistry: IToolRegistry,
  logger: any,
): ToolDefinition[] {
  const cfg = Array.isArray(setting.tools) ? setting.tools : [];
  const tools: ToolDefinition[] = [];
  for (const t of cfg) {
    const def = typeof t === 'string' ? { name: t } : t;
    if (!toolRegistry.has(def.name)) {
      logger.warn(`Tool "${def.name}" not found in registry`);
      continue;
    }
    tools.push(def);
  }
  return tools;
}

/**
 * Prepare initial state for the tool-use session.
 * Handles both new sessions and resumed sessions from snapshots.
 */
async function prepareInitialState<C>(
  init: ToolUseFlowContextInit<C>,
  sessionLifecycle: ToolUseSessionLifecycle,
  snapshot: ToolUseSessionSnapshot | null,
): Promise<PrepareStateResult> {
  const {
    modelHandler,
    prompt,
    userVarChannels,
    executionContext,
    getUsageRecorder,
  } = init;
  const logger = executionContext.logger;
  const onRoundFinalized = getUsageRecorder?.();

  if (snapshot) {
    logger.debug('Resuming tool-use session from saved state.');

    const messages = snapshot.messages;
    // Store is a pure data holder; onRoundFinalized is passed to flow services separately
    const store = createToolUseStore({ snapshot: snapshot.store });

    sessionLifecycle.setStore(store);

    return {
      messages,
      store,
      shouldSkipCycle: true,
      runState: store.run,
    };
  }

  // Create a fresh run state for new sessions
  const currentRunState = new AgentRunState();

  const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
    await buildInitialToolUsePrompts(prompt, userVarChannels.transient, logger);

  const messages = await modelHandler.initializeMessages(
    userPrefix,
    userRequest,
    undefined,
    systemPrompt ? `${systemPrompt}\n${instructionSuffix}` : instructionSuffix,
  );

  // Store is a pure data holder; onRoundFinalized is passed to flow services separately
  // ToolUseStore doesn't include round since tool-use tracks metrics in flow state
  const store = createToolUseStore({
    runState: currentRunState,
    workspaceState: AgentWorkspaceState.create(),
    userChannels: userVarChannels,
  });

  sessionLifecycle.setStore(store);

  return {
    messages,
    store,
    shouldSkipCycle: false,
    runState: currentRunState,
  };
}

/**
 * Create cycle options for tool-use execution.
 */
function createCycleOptions<C>(
  init: ToolUseFlowContextInit<C>,
  toolRegistry: IToolRegistry,
  resolvedTools: ToolDefinition[],
  store: ToolUseStore,
): ToolUseCycleOptions<C> {
  // Use pre-resolved tools (computed at construction time)
  const resolvedSetting = {
    ...init.setting,
    tools: resolvedTools,
  };

  // Build base cycle options using helper (eliminates manual field copying)
  // Then extend with tool-use specific fields
  // Note: workspace is passed via CycleStateSlices, not duplicated in options
  return {
    ...buildBaseCycleOptions(init),
    // Override with resolved setting (includes pre-resolved tools)
    agentSetting: resolvedSetting,
    // ToolUseCycleOptions specific fields
    toolRegistry: toolRegistry,
    modelName: init.config.model,
    agentName: init.config.agent,
  };
}

/**
 * Apply a follow-up message to the conversation.
 */
async function applyFollowUpMessage<C>(
  init: ToolUseFlowContextInit<C>,
  followUp: string,
  messages: ProviderMessage[],
): Promise<ProviderMessage[]> {
  init.executionContext.logger.userMessage(followUp);
  return await init.modelHandler.createUserFollowUpMessages(messages, followUp);
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Build tool-use flow services from initialization config.
 *
 * This is the PocketFlow-native way: simple factory function that creates
 * all services eagerly and returns them as a plain object.
 */
export function buildToolUseServices<C = unknown>(
  init: ToolUseFlowContextInit<C>,
): {
  services: ToolUseServices<C>;
  sessionLifecycle: ToolUseSessionLifecycle;
  resolvedTools: ToolDefinition[];
} {
  const {
    setting,
    streamTabId,
    toolRegistry: customRegistry,
    resumeSnapshot,
  } = init;

  // Create services eagerly (no lazy initialization)
  const toolRegistry = customRegistry ?? getDefaultToolRegistry();
  const sessionLifecycle = new ToolUseSessionLifecycle(streamTabId);

  // Resolve tools once at construction time instead of on every cycle
  const resolvedTools = resolveToolsFromSetting(
    setting,
    toolRegistry,
    init.executionContext.logger,
  );

  // Capture snapshot in closure for prepareState
  const snapshot = resumeSnapshot ?? null;

  // Build base services
  const baseServices = buildBaseFlowServices(init);

  // Return complete services object
  const services: ToolUseServices<C> = {
    ...baseServices,
    setting,
    toolRegistry,
    session: sessionLifecycle,
    prepareState: () => prepareInitialState(init, sessionLifecycle, snapshot),
    buildCycleOptions: (store) =>
      createCycleOptions(init, toolRegistry, resolvedTools, store),
    applyFollowUpMessage: (message, conversation) =>
      applyFollowUpMessage(init, message, conversation),
    getUsageRecorder: init.getUsageRecorder ?? (() => async () => {}),
  };

  return { services, sessionLifecycle, resolvedTools };
}

/**
 * Creates a ToolUseFlowContext with all services and behaviors configured.
 *
 * This is the primary entry point for setting up flow execution.
 * Returns a simple object with services and lifecycle methods.
 */
export function createToolUseFlowContext<C = unknown>(
  init: ToolUseFlowContextInit<C>,
): ToolUseFlowContext<C> {
  const { services, sessionLifecycle } = buildToolUseServices(init);

  return {
    services,
    streamTabId: init.streamTabId,
    session: sessionLifecycle,

    interrupt(): void {
      // Notify runtime layer to update interrupt state
      init.onInterrupt?.();

      // Clear any pending retry request to avoid memory leaks
      retryCoordinator.clearRequest(init.streamTabId);

      // Clean up session lifecycle (PersistedFlow handles state cleanup)
      sessionLifecycle.interrupt();
      sessionLifecycle.setStore(null);
    },

    dispose(): void {
      sessionLifecycle.dispose();
    },
  };
}
