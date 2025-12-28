/**
 * ToolUseFlowContext - Self-contained execution context for tool-use flows.
 *
 * ## Flow-First Architecture
 *
 * This module enables tool-use flows to run WITHOUT agent class instances.
 * Similar to ReflectionFlowContext, it creates all necessary services and
 * provides them to the flow.
 *
 * ## Key Design Decisions:
 *
 * 1. **Session lifecycle decoupled** - Uses IToolUseSessionHost interface
 *    instead of requiring a BaseToolUseAgent instance.
 *
 * 2. **Services created here** - All services needed by ToolUseRunFlow
 *    are created and managed by this context.
 *
 * 3. **No agent reference** - The flow doesn't need to know about agent classes.
 */

import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { buildBaseFlowServices } from '@agent/implementations/flows/common';

import { runToolUseCycle } from '@agent/core/ToolUseCycle';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import { getDefaultToolRegistry } from '@tools/registry';
import { buildInitialToolUsePrompts } from '@utils/prompt';
import {
  ToolUseSessionLifecycle,
  type IToolUseSessionHost,
} from './ToolUseSessionLifecycle';

import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';
import type { ToolUseServices, PrepareStateResult } from './ToolUseServices';

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Configuration for creating a ToolUseFlowContext.
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
  getUsageRecorder?: () => AgentRoundFinalizedCallback;
}

// ============================================================================
// Context Class
// ============================================================================

/**
 * Self-contained execution context for tool-use flows.
 *
 * Implements IToolUseSessionHost to provide session lifecycle with
 * necessary context without requiring an agent instance.
 */
export class ToolUseFlowContext<C = unknown> implements IToolUseSessionHost {
  private readonly init: ToolUseFlowContextInit<C>;
  private readonly toolRegistry: IToolRegistry;
  private readonly sessionLifecycle: ToolUseSessionLifecycle;
  private _services: ToolUseServices<C> | null = null;

  constructor(init: ToolUseFlowContextInit<C>) {
    this.init = init;
    this.toolRegistry = init.toolRegistry ?? getDefaultToolRegistry();
    this.sessionLifecycle = new ToolUseSessionLifecycle(this);
  }

  // =========================================================================
  // IToolUseSessionHost implementation
  // =========================================================================

  get streamTabId(): StreamTabId {
    return this.init.streamTabId;
  }

  get executionId() {
    return this.init.executionContext.executionId;
  }

  get config(): AgentConfig {
    return this.init.config;
  }

  // =========================================================================
  // Service Access
  // =========================================================================

  get services(): ToolUseServices<C> {
    if (this._services) {
      return this._services;
    }

    const { setting, resumeSnapshot } = this.init;

    // Build base services from init, then add tool-use specific ones
    this._services = {
      ...buildBaseFlowServices(this.init),
      // Narrow setting type for tool-use flows
      setting,

      // Tool-use specific services
      toolRegistry: this.toolRegistry,
      session: this.sessionLifecycle,

      // Cycle operations - capture snapshot in closure
      prepareState: () => this.prepareInitialState(resumeSnapshot ?? null),
      buildCycleOptions: (store) => this.createCycleOptions(store),
      runCycle: (options, messages, store) =>
        runToolUseCycle({ options, messages, store }),
      persistCheckpoint: (messages, _store) =>
        this.sessionLifecycle.persistCheckpoint(messages),
      applyFollowUpMessage: (message, conversation) =>
        this.applyFollowUpMessage(message, conversation),
    };

    return this._services;
  }

  get session() {
    return this.sessionLifecycle;
  }

  // =========================================================================
  // Lifecycle Operations
  // =========================================================================

  /**
   * Disposes session lifecycle resources.
   */
  dispose(): void {
    this.sessionLifecycle.dispose();
  }

  /**
   * Interrupt the session.
   */
  interrupt(): void {
    this.sessionLifecycle.interrupt();
    void this.sessionLifecycle.clearPersistedSnapshot();
    this.sessionLifecycle.setStore(null);
  }

  // =========================================================================
  // State Preparation
  // =========================================================================

  private getTools(): ToolDefinition[] {
    const cfg = Array.isArray(this.init.setting.tools)
      ? this.init.setting.tools
      : [];
    const tools: ToolDefinition[] = [];
    for (const t of cfg) {
      const def = typeof t === 'string' ? { name: t } : t;
      if (!this.toolRegistry.has(def.name)) {
        this.init.executionContext.logger.warn(
          `Tool "${def.name}" not found in registry`,
        );
        continue;
      }
      tools.push(def);
    }
    return tools;
  }

  private async prepareInitialState(
    snapshot: ToolUseSessionSnapshot | null,
  ): Promise<PrepareStateResult> {
    const { modelHandler, prompt, userVarChannels, executionContext } =
      this.init;
    const logger = executionContext.logger;
    const onRoundFinalized = this.init.getUsageRecorder?.();

    if (snapshot) {
      logger.debug('Resuming tool-use session from saved state.');

      const messages = snapshot.messages;
      const store = createSharedStore({
        snapshot: snapshot.store,
        onRoundFinalized,
      });

      this.sessionLifecycle.setStore(store);

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
      await buildInitialToolUsePrompts(
        prompt,
        userVarChannels.transient,
        logger,
      );

    const messages = await modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemPrompt
        ? `${systemPrompt}\n${instructionSuffix}`
        : instructionSuffix,
    );

    const store = createSharedStore({
      roundIndex: currentRunState.totalRounds,
      runState: currentRunState,
      workspaceState: AgentWorkspaceState.create(),
      userChannels: userVarChannels,
      onRoundFinalized,
    });

    this.sessionLifecycle.setStore(store);

    return {
      messages,
      store,
      shouldSkipCycle: false,
      runState: currentRunState,
    };
  }

  private createCycleOptions(store: AgentSharedStore): ToolUseCycleOptions<C> {
    const {
      modelHandler,
      setting,
      prompt,
      config,
      executionContext,
      userVarChannels,
    } = this.init;
    const client = this.init.getClient();

    const resolvedSetting = {
      ...setting,
      tools: this.getTools(),
    };

    // Build base cycle options (AgentCycleBaseOptions + ToolUseCycleOptions)
    return {
      // AgentCycleBaseOptions
      modelHandler: modelHandler as IModelHandler<any, any, any, any, C>,
      agentSetting: resolvedSetting,
      agentPrompt: prompt,
      userVars: userVarChannels.transient,
      userVarChannels,
      logger: executionContext.logger,
      context: executionContext,
      client,
      checkInterruption: this.init.checkInterruption,
      setAbortController: this.init.setAbortController,
      // ToolUseCycleOptions specific
      toolRegistry: this.toolRegistry,
      workspaceState: store.workspace,
      modelName: config.model,
      agentName: config.agent,
    };
  }

  private async applyFollowUpMessage(
    followUp: string,
    messages: ProviderMessage[],
  ): Promise<ProviderMessage[]> {
    this.init.executionContext.logger.userMessage(followUp);
    return await this.init.modelHandler.createUserFollowUpMessages(
      messages,
      followUp,
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createToolUseFlowContext<C = unknown>(
  init: ToolUseFlowContextInit<C>,
): ToolUseFlowContext<C> {
  return new ToolUseFlowContext(init);
}
