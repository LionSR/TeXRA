// Local imports - agent
import type { IModelHandler } from '@agent/modelHandlers';

// Internal imports
import { runToolUseCycle } from '@agent/core/ToolUseCycle';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
// Internal imports
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
// Type imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import {
  createToolUseRunFlow,
  type ToolUseRunShared,
  type ToolUseRunPhase,
  type ToolUseRunHooks,
} from '@agent/implementations/flows/ToolUseRunFlow';
// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { AgentLifecycle } from '@agent/implementations/flows/common/AgentLifecycle';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { type ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import {
  registerToolUseAgent,
  unregisterToolUseAgent,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseSessionLifecycle } from '@agent/toolUse/ToolUseSessionLifecycle';

// Type imports
import type { IToolRegistry } from '@agent/core/ToolTypes';
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

  /**
   * Appends a follow-up message to the queue or resolves a waiting promise
   * @param text - The follow-up message text
   */
  public appendFollowUp(text: string): void {
    this.sessionLifecycle.appendFollowUp(text);
  }

  /**
   * Configures the agent to resume from a persisted snapshot
   * @param snapshot - The snapshot to resume from
   */
  public resumeFromSnapshot(snapshot: ToolUseSessionSnapshot): void {
    this.resumeSnapshot = snapshot;
  }

  public async waitForFollowUp(): Promise<string | null> {
    return this.sessionLifecycle.waitForFollowUp(() =>
      this.checkInterruption(),
    );
  }

  public hasQueuedFollowUp(): boolean {
    return this.sessionLifecycle.hasQueuedFollowUp();
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

  public async run(): Promise<void> {
    const lifecycle = new AgentLifecycle<ToolUseRunPhase>('idle');

    // Flow-specific hooks only - lifecycle is on the agent (IFlowAgent)
    const hooks: ToolUseRunHooks<C> = {
      prepareState: () => this.prepareInitialState(),
      buildCycleOptions: (store) => this.createCycleOptions(store),
      runCycle: (options, messages, store) =>
        runToolUseCycle({ options, messages, store }),
      persistCheckpoint: (messages, store) =>
        this.persistCheckpoint(messages, store),
    };

    await this.executeAgentRunFlow<ToolUseRunShared<C>>({
      lifecycle,
      hooks,
      createState: () => ({
        conversation: [],
        cycleOptions: null,
        shouldSkipCycle: false,
        store: null,
        runState: new AgentRunState(),
      }),
      createFlow: () => createToolUseRunFlow<C>(),
    });
  }

  /**
   * Prepares the initial state for the tool-use session.
   * Handles both new sessions and resumed sessions from snapshots.
   *
   * Pure method: Returns data for the flow to update state.
   * Only side effect: Sets sessionLifecycle store (necessary for persistence).
   */
  public async prepareInitialState(): Promise<{
    messages: ProviderMessage[];
    store: AgentSharedStore;
    shouldSkipCycle: boolean;
    runState: AgentRunState;
  }> {
    if (this.resumeSnapshot) {
      this.logger.debug('Resuming tool-use session from saved state.');
      const snapshot = this.resumeSnapshot;
      this.resumeSnapshot = null;

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

  public async enterWaitingState(
    conversation: ProviderMessage[],
  ): Promise<void> {
    await this.sessionLifecycle.enterWaitingState(conversation);
  }

  public async markRunning(): Promise<void> {
    await this.sessionLifecycle.markRunning();
  }

  public async clearPersistedSnapshot(): Promise<void> {
    await this.sessionLifecycle.clearPersistedSnapshot();
  }

  public async persistCheckpoint(
    messages: ProviderMessage[],
    _store: AgentSharedStore,
  ): Promise<void> {
    await this.sessionLifecycle.persistCheckpoint(messages);
  }
}
