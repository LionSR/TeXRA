// Local imports - agent
import type { IModelHandler } from '@agent/modelHandlers';

// Internal imports
import { runToolUseCycle } from '@agent/core/ToolUseCycle';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
// Internal imports
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import {
  AgentPrompt,
  AgentSetting,
  type AgentToolUseSetting,
} from '@agent/core/AgentDataclass';
// Type imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import {
  createToolUseRunFlow,
  createInitialToolUseState,
  type ToolUseRunShared,
} from '@agent/implementations/flows/ToolUseRunFlow';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse';
// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { type ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import {
  registerToolUseAgent,
  unregisterToolUseAgent,
} from '@agent/toolUse/ToolUseAgentRegistry';
import {
  ToolUseSessionLifecycle,
  type IToolUseSession,
} from '@agent/toolUse/ToolUseSessionLifecycle';

// Type imports
import type { IToolRegistry } from '@agent/core/ToolTypes';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';
import type { ToolDefinition } from '@model';

// Internal imports - use IToolRegistry from core (single source of truth)
import { getDefaultToolRegistry } from '@tools/registry';
import { buildInitialToolUsePrompts } from '@utils/prompt';

// Local file imports
import { BaseAgent } from './BaseAgent';

export interface BaseToolUseAgentOptions {
  /**
   * Optional tool registry to use. Defaults to getDefaultToolRegistry().
   * Enables dependency injection for testing and custom tool sets.
   */
  toolRegistry?: IToolRegistry;
}

export class BaseToolUseAgent<C = unknown> extends BaseAgent<C> {
  private readonly toolRegistry: IToolRegistry;
  private readonly sessionLifecycle: ToolUseSessionLifecycle<C>;
  private resumeSnapshot: ToolUseSessionSnapshot | null = null;

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    context: AgentExecutionContext,
    options?: BaseToolUseAgentOptions,
  ) {
    super(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      context,
    );
    this.toolRegistry = options?.toolRegistry ?? getDefaultToolRegistry();
    this.sessionLifecycle = new ToolUseSessionLifecycle(this);
  }

  protected override registerRunningAgent(streamTabId: StreamTabId): void {
    registerToolUseAgent(streamTabId, this);
  }

  protected override unregisterRunningAgent(streamTabId: StreamTabId): void {
    unregisterToolUseAgent(streamTabId);
  }

  // =========================================================================
  // Lifecycle Overrides for Tool-Use Sessions
  // Tool-use agents have custom lifecycle: reuse stages, custom init, cleanup
  // =========================================================================

  /**
   * Tool-use agents reuse existing stages and don't create new ones during init.
   */
  public override async startAndInitRun(): Promise<void> {
    await this.init(undefined, { createStage: false });
  }

  /**
   * Tool-use cleanup also disposes the session lifecycle.
   */
  public override cleanupRun(): void {
    super.cleanupRun();
    this.sessionLifecycle.dispose();
  }

  private getTools(): ToolDefinition[] {
    const cfg = Array.isArray(this.agentSetting.tools)
      ? this.agentSetting.tools
      : [];
    const tools: ToolDefinition[] = [];
    for (const t of cfg) {
      const def = typeof t === 'string' ? { name: t } : t;
      if (!this.toolRegistry.has(def.name)) {
        this.logger.warn(`Tool "${def.name}" not found in registry`);
        continue;
      }
      tools.push(def);
    }
    if (
      this.agentConfig.toolConfig.attachDiagnostics &&
      !tools.some((t) => t.name === 'diagnostics')
    ) {
      tools.push({ name: 'diagnostics' });
    }
    return tools;
  }

  // =========================================================================
  // Session Lifecycle Access
  // =========================================================================

  /**
   * Exposes session lifecycle operations for flows and external callers.
   * Follows composition over delegation pattern.
   */
  public get session(): IToolUseSession {
    return this.sessionLifecycle;
  }

  /**
   * Sets the snapshot to restore state from during initialization.
   * Actual hydration happens in prepareInitialState().
   */
  public setResumeSnapshot(snapshot: ToolUseSessionSnapshot): void {
    this.resumeSnapshot = snapshot;
  }

  public async applyFollowUpMessage(
    followUp: string,
    messages: ProviderMessage[],
  ): Promise<ProviderMessage[]> {
    this.logger.userMessage(followUp);
    // Pure: compute and return, let flow update state
    return await this.modelHandler.createUserFollowUpMessages(
      messages,
      followUp,
    );
  }

  public override interrupt(): void {
    super.interrupt();
    this.sessionLifecycle.interrupt();
    void this.sessionLifecycle.clearPersistedSnapshot();
    this.sessionLifecycle.setStore(null);
  }

  // =========================================================================
  // Services Pattern
  // Agent = Service Provider, Flow = Execution Engine
  // =========================================================================

  /**
   * Build services for flow nodes with explicit snapshot parameter.
   *
   * Snapshot Lifecycle:
   * - snapshot is captured by closure at service creation time (in run())
   * - run() clears this.resumeSnapshot immediately after capturing
   * - This ensures the snapshot value is frozen for the entire flow execution
   * - The snapshot is only used by prepareState() to restore session state
   *
   * @param snapshot - Optional snapshot to resume from (passed explicitly for clear data flow)
   * @returns Services object for flow injection
   */
  public getServices(
    snapshot: ToolUseSessionSnapshot | null,
  ): ToolUseServices<C> {
    return {
      // Base services (from BaseFlowServices)
      modelHandler: this.modelHandler,
      logger: this.logger,
      config: this.agentConfig,
      setting: this.agentSetting as AgentToolUseSetting,
      prompt: this.agentPrompt,
      context: this.context,
      userVarChannels: this.userVarChannels,
      checkInterruption: () => this.isInterruptionRequested(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
      getClient: () => this.getClientInstance(),

      // Tool-use specific services
      toolRegistry: this.toolRegistry,
      session: this.sessionLifecycle,

      // Cycle operations (bound to agent methods)
      // Note: snapshot is captured by closure - see Snapshot Lifecycle above
      prepareState: () => this.prepareInitialState(snapshot),
      buildCycleOptions: (store) => this.createCycleOptions(store),
      runCycle: (options, messages, store) =>
        runToolUseCycle({ options, messages, store }),
      persistCheckpoint: (messages, _store) =>
        this.session.persistCheckpoint(messages),
      applyFollowUpMessage: (message, conversation) =>
        this.applyFollowUpMessage(message, conversation),
    };
  }

  /**
   * Main execution method for tool-use agents.
   *
   * Architecture:
   * - Agent owns lifecycle (init before flow, finalize in finally)
   * - Flow is pure execution (prepare → cycle → wait loop)
   * - Errors throw directly from flow; caught here for cleanup
   */
  public async run(): Promise<void> {
    // Capture and clear snapshot at start of run for explicit data flow
    const snapshot = this.resumeSnapshot;
    this.resumeSnapshot = null;

    let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
    try {
      // === INIT (agent-owns-lifecycle) ===
      // Init inside try block ensures cleanup runs even if init fails
      await this.startAndInitRun();
      await this.initializeClient();

      // Create shared state (mutable runtime state only - no lifecycle!)
      const shared: ToolUseRunShared<C> = {
        state: createInitialToolUseState<C>(),
      };

      // Create flow and inject services with explicit snapshot
      const flow = createToolUseRunFlow<C>();
      flow.setServices(this.getServices(snapshot));

      // Run the flow - errors throw directly
      await flow.run(shared);
    } catch (error) {
      status = END_GROUP_STATUS.ERROR;
      throw error;
    } finally {
      // === FINALIZE (agent-owns-lifecycle) ===
      this.endRun(status);
      await this.sessionLifecycle.clearPersistedSnapshot();
      this.cleanupRun();
    }
  }

  /**
   * Prepares the initial state for the tool-use session.
   * Handles both new sessions and resumed sessions from snapshots.
   *
   * @param snapshot - Optional snapshot to resume from (passed explicitly for clear data flow)
   *
   * Pure method: Returns data for the flow to update state.
   * Only side effect: Sets sessionLifecycle store (necessary for persistence).
   */
  public async prepareInitialState(
    snapshot: ToolUseSessionSnapshot | null,
  ): Promise<{
    messages: ProviderMessage[];
    store: AgentSharedStore;
    shouldSkipCycle: boolean;
    runState: AgentRunState;
  }> {
    if (snapshot) {
      this.logger.debug('Resuming tool-use session from saved state.');

      const messages = snapshot.messages;
      const store = createSharedStore({
        snapshot: snapshot.store,
        onRoundFinalized: this.getUsageRecorder('tool-use'),
      });

      // Side effect: sessionLifecycle needs store for persistence
      this.sessionLifecycle.setStore(store);

      return {
        messages,
        store,
        shouldSkipCycle: true,
        runState: store.run, // Resumed runState from snapshot
      };
    }

    // Create a fresh run state for new sessions
    const currentRunState = new AgentRunState();

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.agentPrompt,
        this.userVarChannels.transient,
        this.logger,
      );

    const messages = await this.modelHandler.initializeMessages(
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
      userChannels: this.getUserVarChannels(),
      onRoundFinalized: this.getUsageRecorder('tool-use'),
    });

    // Side effect: sessionLifecycle needs store for persistence
    this.sessionLifecycle.setStore(store);

    return {
      messages,
      store,
      shouldSkipCycle: false,
      runState: currentRunState, // Same runState, store shares it
    };
  }

  /**
   * Creates cycle options for tool-use execution.
   * Parallel to createResponseCycleOptions() in BaseReflectionAgent.
   */
  public createCycleOptions(store: AgentSharedStore): ToolUseCycleOptions<C> {
    const client = this.getClientInstance();
    const resolvedSetting = {
      ...this.agentSetting,
      tools: this.getTools(),
    };

    const baseOptions = this.buildCycleBaseOptions({
      agentSetting: resolvedSetting,
      agentPrompt: this.agentPrompt,
      client,
    });

    return {
      ...baseOptions,
      toolRegistry: this.toolRegistry,
      workspaceState: store.workspace,
      modelName: this.agentConfig.model,
      agentName: this.agentConfig.agent,
    };
  }
}
