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
  AgentType,
} from '@agent/core/AgentDataclass';
// Type imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import { buildInitialToolUsePrompts } from '@agent/utils/PromptBuilder';
import {
  createToolUseRunFlow,
  type ToolUseRunShared,
  type ToolUseRunState,
  type ToolUseRunPhase,
} from '@agent/implementations/flows/ToolUseRunFlow';
// Type imports
import type { AgentRunHooks } from '@agent/implementations/flows/common/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { createLifecycleState } from '@agent/implementations/flows/common/lifecycle';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { type ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionPersistence';
import {
  registerToolUseAgent,
  unregisterToolUseAgent,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseSessionLifecycle } from '@agent/toolUse/ToolUseSessionLifecycle';

// Type imports
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';

// Internal imports
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';

// Local file imports
import { BaseAgent } from './BaseAgent';

export interface BaseToolUseAgentOptions {
  /** Optional tool registry to use. Defaults to DEFAULT_TOOL_REGISTRY. */
  toolRegistry?: IToolRegistry;
}

export class BaseToolUseAgent<C = unknown> extends BaseAgent<C> {
  private readonly toolRegistry: IToolRegistry;
  private readonly sessionLifecycle: ToolUseSessionLifecycle<C>;
  private resumeSnapshot: ToolUseSessionSnapshot | null = null;
  private activeState: ToolUseRunState<C> | null = null;

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
    this.toolRegistry = options?.toolRegistry ?? DEFAULT_TOOL_REGISTRY;
    this.sessionLifecycle = new ToolUseSessionLifecycle(this);
  }

  protected override registerRunningAgent(streamTabId: StreamTabId): void {
    registerToolUseAgent(streamTabId, this);
  }

  protected override unregisterRunningAgent(streamTabId: StreamTabId): void {
    unregisterToolUseAgent(streamTabId);
  }

  private getTools(): ToolDefinition[] {
    const cfg = Array.isArray(this.agentSetting.tools)
      ? this.agentSetting.tools
      : [];
    const tools: ToolDefinition[] = [];
    for (const t of cfg) {
      const def = typeof t === 'string' ? { name: t } : t;
      if (!this.toolRegistry[def.name]) {
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
    const updatedMessages = await this.modelHandler.createUserFollowUpMessages(
      messages,
      followUp,
    );
    this.getActiveState().conversation = [...updatedMessages];
    return this.getActiveState().conversation;
  }

  public override interrupt(): void {
    super.interrupt();
    this.sessionLifecycle.interrupt();
    void this.sessionLifecycle.clearPersistedSnapshot();
    this.sessionLifecycle.setStore(null);
  }

  public async run(): Promise<void> {
    const lifecycle = createLifecycleState<ToolUseRunPhase>('idle');

    try {
      await this.executeAgentRunFlow<ToolUseRunShared<C>>({
        lifecycle,
        hookOverrides: {
          start: async () => undefined,
        },
        createState: () => {
          const state: ToolUseRunState<C> = {
            conversation: [],
            cycleOptions: null,
            shouldSkipCycle: false,
            store: null,
            runState: new AgentRunState(),
          };
          this.activeState = state;
          return state;
        },
        createFlow: () => createToolUseRunFlow<C>(),
        extendHooks: (baseHooks: AgentRunHooks) => ({
          ...baseHooks,
          init: (runStage) => this.init(runStage, { createStage: false }),
          prepareState: () => this.prepareInitialState(),
          buildCycleOptions: (store) => this.createCycleOptions(store),
          runCycle: (options, messages, store) =>
            runToolUseCycle({ options, messages, store }),
          checkInterruption: () => this.checkInterruption(),
          hasQueuedFollowUp: () => this.hasQueuedFollowUp(),
          enterWaitingState: () => this.enterWaitingState(),
          clearPersistedSnapshot: () => this.clearPersistedSnapshot(),
          waitForFollowUp: () => this.waitForFollowUp(),
          markRunning: () => this.markRunning(),
          applyFollowUp: (followUp, messages) =>
            this.applyFollowUpMessage(followUp, messages),
          persistCheckpoint: (messages, store) =>
            this.persistCheckpoint(messages, store),
          logFinalizeWarning: (message, error) =>
            this.logger.warn(message, { data: error }),
          cleanup: async () => {
            await baseHooks.cleanup();
            this.sessionLifecycle.dispose();
          },
        }),
      });
    } finally {
      this.activeState = null;
    }
  }

  /**
   * Prepares the initial state for the tool-use session.
   * Handles both new sessions and resumed sessions from snapshots.
   * Parallel to beginRound() + prepare methods in BaseReflectionAgent.
   */
  public async prepareInitialState(): Promise<{
    messages: ProviderMessage[];
    store: AgentSharedStore;
    shouldSkipCycle: boolean;
  }> {
    const state = this.getActiveState();
    if (this.resumeSnapshot) {
      this.logger.debug('Resuming tool-use session from saved state.');
      const snapshot = this.resumeSnapshot;
      this.resumeSnapshot = null;

      const messages = snapshot.messages;
      const store = createSharedStore({
        snapshot: snapshot.store,
        onRoundFinalized: this.getUsageRecorder('tool-use'),
      });

      state.conversation = [...messages];
      state.store = store;
      state.runState = store.run;
      state.shouldSkipCycle = true;

      this.sessionLifecycle.setStore(store);

      return { messages, store, shouldSkipCycle: true };
    }

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.agentPrompt,
        this.userVars,
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
      roundIndex: state.runState.totalRounds,
      runState: state.runState,
      workspaceState: new AgentWorkspaceState(),
      userChannels: this.getUserVarChannels(),
      onRoundFinalized: this.getUsageRecorder('tool-use'),
    });

    state.conversation = [...messages];
    state.store = store;
    state.shouldSkipCycle = false;

    this.sessionLifecycle.setStore(store);

    return { messages, store, shouldSkipCycle: false };
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

  public async enterWaitingState(): Promise<void> {
    await this.sessionLifecycle.enterWaitingState(
      this.getActiveState().conversation,
    );
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

  private getActiveState(): ToolUseRunState<C> {
    if (!this.activeState) {
      throw new Error('Tool-use run state is not initialized.');
    }
    return this.activeState;
  }
}
