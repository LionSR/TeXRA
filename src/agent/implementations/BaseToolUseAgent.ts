// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting, AgentType } from '../core/AgentDataclass';
import { AgentRunState } from '../core/AgentState';
import { AgentWorkspaceState } from '../core/AgentWorkspaceState';
import { runToolUseCycle } from '../core/ToolUseCycle';
import type { ToolUseCycleOptions } from '../core/ToolUseCycle';
import type { IModelHandler } from '../modelHandlers';
import type { ProviderMessage } from '../modelHandlers/types/ProviderMessage';
import { buildInitialToolUsePrompts } from '../utils/PromptBuilder';
// Base class for tool-use agents

// Standard library imports

// Local imports - core
import { BaseAgent } from './BaseAgent';
import {
  createToolUseRunFlow,
  type ToolUseRunHooks,
  type ToolUseRunLifecycle,
  type ToolUseRunShared,
  type ToolUseRunState,
  type ToolUseRunPhase,
} from '@agent/implementations/flows/ToolUseRunFlow';
import { runAgentFlow } from '@agent/implementations/flows/common/AgentRunFlowRunner';
import type { AgentRunHooks } from '@agent/implementations/flows/common/types';
import { createLifecycleState } from '@agent/implementations/flows/common/lifecycle';
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { type ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionPersistence';
import {
  registerToolUseAgent,
  unregisterToolUseAgent,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseSessionLifecycle } from '@agent/toolUse/ToolUseSessionLifecycle';

export class BaseToolUseAgent<C = unknown> extends BaseAgent<C> {
  private toolRegistry: Record<string, BaseTool<any>>;
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
  ) {
    super(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      context,
    );
    this.toolRegistry = DEFAULT_TOOL_REGISTRY;
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

  private async waitForFollowUp(): Promise<string | null> {
    return this.sessionLifecycle.waitForFollowUp(() =>
      this.checkInterruption(),
    );
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
      await runAgentFlow<ToolUseRunShared<C>>({
        agent: this,
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
          prepareState: () => this.prepareInitialSessionState(),
          buildCycleOptions: (store) => this.buildToolUseCycleOptions(store),
          runCycle: (options, messages, store) =>
            runToolUseCycle({
              options,
              messages,
              store,
            }),
          checkInterruption: () => this.checkInterruption(),
          hasQueuedFollowUp: () => this.sessionLifecycle.hasQueuedFollowUp(),
          enterWaitingState: () => this.enterWaitingState(),
          clearPersistedSnapshot: () => this.clearPersistedSnapshot(),
          waitForFollowUp: () => this.waitForFollowUp(),
          markRunning: () => this.markRunning(),
          applyFollowUp: async (followUp, messages) => {
            this.logger.userMessage(followUp);
            const updatedMessages =
              await this.modelHandler.createUserFollowUpMessages(
                messages,
                followUp,
              );
            this.getActiveState().conversation = [...updatedMessages];
            return this.getActiveState().conversation;
          },
          logFinalizeWarning: (message, error) => {
            this.logger.warn(message, undefined, undefined, error);
          },
          cleanup: async () => {
            await baseHooks.cleanup();
            this.activeState = null;
            this.sessionLifecycle.dispose();
          },
        }),
      });
    } finally {
      this.activeState = null;
    }
  }

  private async prepareInitialSessionState(): Promise<{
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

  private buildToolUseCycleOptions(
    store: AgentSharedStore,
  ): ToolUseCycleOptions<C> {
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
      toolState: store.workspace,
      modelName: this.agentConfig.model,
    };
  }

  private async enterWaitingState(): Promise<void> {
    await this.sessionLifecycle.enterWaitingState(
      this.getActiveState().conversation,
    );
  }

  private async markRunning(): Promise<void> {
    await this.sessionLifecycle.markRunning();
  }

  private async clearPersistedSnapshot(): Promise<void> {
    await this.sessionLifecycle.clearPersistedSnapshot();
  }

  private getActiveState(): ToolUseRunState<C> {
    if (!this.activeState) {
      throw new Error('Tool-use run state is not initialized.');
    }
    return this.activeState;
  }
}
