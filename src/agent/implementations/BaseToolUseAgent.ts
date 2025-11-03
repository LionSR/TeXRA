// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting, AgentType } from '../core/AgentDataclass';
import { AgentRunState } from '../core/AgentState';
import { AgentWorkspaceState } from '../core/AgentWorkspaceState';
import { runToolUseCycle } from '../core/ToolUseCycle';
import type { ToolUseCycleOptions } from '../core/ToolUseCycle';
import type { IModelHandler } from '../modelHandlers';
import type { ProviderMessage } from '../modelHandlers/types/ProviderMessage';
import { getSystemPromptWithRules } from '../utils/promptHelpers';
import { renderPrompt } from '../utils/promptUtils';
import { TOOL_USE_INSTRUCTIONS } from '../utils/toolUsePrompt';
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
} from '@agent/implementations/flows/ToolUseRunFlow';
import { runAgentFlow } from '@agent/implementations/flows/common/AgentRunFlowRunner';
import type { AgentRunHooks } from '@agent/implementations/flows/common/types';
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { bus } from '@eventBus/ProgressEventBus';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';
import {
  registerToolUseAgent,
  unregisterToolUseAgent,
} from '@agent/toolUse/ToolUseAgentRegistry';

export class BaseToolUseAgent<C = unknown> extends BaseAgent<C> {
  private toolRegistry: Record<string, BaseTool<any>>;
  private followUpQueue: string[] = [];
  private followUpResolver: ((v: string | null) => void) | null = null;
  private messages: ProviderMessage[] = [];
  private toolState: AgentWorkspaceState | null = null;
  private resumeSnapshot: ToolUseSessionSnapshot | null = null;
  private hasPersistedSnapshot = false;
  private persistenceLock = false; // Lock to prevent race conditions during persistence

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
    if (this.followUpResolver) {
      this.followUpResolver(text);
      this.followUpResolver = null;
    } else {
      this.followUpQueue.push(text);
    }
    // If we're in the middle of persisting, mark for cleanup
    if (this.persistenceLock) {
      this.hasPersistedSnapshot = true; // Will trigger cleanup in the next cycle
    }
  }

  /**
   * Configures the agent to resume from a persisted snapshot
   * @param snapshot - The snapshot to resume from
   */
  public resumeFromSnapshot(snapshot: ToolUseSessionSnapshot): void {
    this.resumeSnapshot = snapshot;
    this.hasPersistedSnapshot = true;
  }

  private async waitForFollowUp(): Promise<string | null> {
    if (this.followUpQueue.length > 0) {
      return this.followUpQueue.shift()!;
    }
    if (this.isInterrupted) return null;
    return new Promise<string | null>((resolve) => {
      this.followUpResolver = resolve;
    });
  }

  public override interrupt(): void {
    super.interrupt();
    if (this.followUpResolver) {
      this.followUpResolver(null);
      this.followUpResolver = null;
    }
    void this.clearPersistedSnapshot();
  }

  public async run(): Promise<void> {
    const lifecycle: ToolUseRunLifecycle = {
      phase: 'idle',
      status: 'pending',
      error: undefined,
    };

    await runAgentFlow<ToolUseRunShared<C>>({
      agent: this,
      lifecycle,
      createState: () =>
        ({
          messages: this.messages,
          toolState: this.toolState,
          cycleOptions: null,
          shouldSkipCycle: false,
          store: null,
          runState: new AgentRunState(),
          nextRoundIndex: 0,
        }) satisfies ToolUseRunState<C>,
      createFlow: () => createToolUseRunFlow<C>(),
      extendHooks: (baseHooks: AgentRunHooks) => ({
        ...baseHooks,
        start: async () => undefined,
        init: (runGroupId) => this.init(runGroupId, { createGroup: false }),
        prepareState: () => this.prepareInitialSessionState(),
        buildCycleOptions: (toolState) =>
          this.buildToolUseCycleOptions(toolState),
        runCycle: (options, messages, store) =>
          runToolUseCycle({
            options,
            messages,
            store,
          }),
        checkInterruption: () => this.checkInterruption(),
        hasQueuedFollowUp: () => this.followUpQueue.length > 0,
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
          this.messages = updatedMessages;
          return updatedMessages;
        },
        end: async (status) => {
          await baseHooks.end(status);
        },
        cleanup: async () => {
          await baseHooks.cleanup();
        },
        logFinalizeWarning: (message, error) => {
          this.logger.warn(message, undefined, undefined, error);
        },
      }),
    });
  }

  private async prepareInitialSessionState(): Promise<{
    messages: ProviderMessage[];
    toolState: AgentWorkspaceState;
    shouldSkipCycle: boolean;
  }> {
    if (this.resumeSnapshot) {
      this.logger.debug('Resuming tool-use session from saved state.');
      const snapshot = this.resumeSnapshot;
      this.resumeSnapshot = null;

      const messages = snapshot.messages;
      let toolState: AgentWorkspaceState;

      try {
        toolState = AgentWorkspaceState.fromJSON(snapshot.toolState);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error while hydrating tool state';
        this.logger.warn(
          `Failed to hydrate tool state from snapshot: ${message}`,
        );
        toolState = new AgentWorkspaceState();
      }

      this.messages = messages;
      this.toolState = toolState;

      return {
        messages,
        toolState,
        shouldSkipCycle: true,
      };
    }

    const initialRequest = Array.isArray(this.agentPrompt.userRequest)
      ? (this.agentPrompt.userRequest[0] ?? '')
      : this.agentPrompt.userRequest;

    const [systemPrompt, userRequest, userPrefix] = await Promise.all([
      getSystemPromptWithRules(
        `${this.agentPrompt.systemPrompt}\n${TOOL_USE_INSTRUCTIONS}`,
        this.userVars,
      ),
      renderPrompt(initialRequest, this.userVars),
      renderPrompt(this.agentPrompt.userPrefix, this.userVars),
    ]);

    const messages = await this.modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemPrompt,
    );

    const toolState = new AgentWorkspaceState();

    this.messages = messages;
    this.toolState = toolState;

    return {
      messages,
      toolState,
      shouldSkipCycle: false,
    };
  }

  private buildToolUseCycleOptions(
    toolState: AgentWorkspaceState,
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
      toolState,
      modelName: this.agentConfig.model,
      onUsageRecorded: async ({ run }) => {
        await this.trackRoundUsage(run, { runKind: 'tool-use' });
      },
    };
  }

  private async enterWaitingState(): Promise<void> {
    // Early check to avoid unnecessary work
    if (this.followUpQueue.length > 0) {
      return;
    }

    const stream = this.getStreamTabId();
    const executionId = this.getExecutionId();
    const state = this.toolState;

    // Persist snapshot with lock to prevent race conditions
    if (state && executionId && ToolUseSessionManager.isPersistenceEnabled()) {
      // Acquire lock to prevent race conditions
      this.persistenceLock = true;

      try {
        // Double-check queue is still empty under lock
        if (this.followUpQueue.length === 0) {
          await ToolUseSessionManager.saveSnapshot({
            executionId,
            streamId: stream,
            agentName: this.agentConfig.agent,
            model: this.agentConfig.model,
            session: this.getSessionMetadata(),
            messages: this.messages,
            toolState: state,
          });

          // Final check after save completes
          if (this.followUpQueue.length > 0) {
            // A follow-up arrived while we were saving
            await ToolUseSessionManager.deleteSnapshot(executionId);
            this.hasPersistedSnapshot = false;
          } else {
            this.hasPersistedSnapshot = true;
          }
        }
      } finally {
        // Always release lock
        this.persistenceLock = false;
      }
    }

    bus.emit('updateStreamStatus', {
      stream,
      status: 'waiting', // Using string literal here as it's part of the bus event API
    });
  }

  private async markRunning(): Promise<void> {
    bus.emit('updateStreamStatus', {
      stream: this.getStreamTabId(),
      status: 'running', // Using string literal here as it's part of the bus event API
    });
  }

  private async clearPersistedSnapshot(): Promise<void> {
    if (!this.hasPersistedSnapshot) {
      return;
    }
    const executionId = this.getExecutionId();
    if (!executionId) {
      this.hasPersistedSnapshot = false;
      return;
    }
    try {
      await ToolUseSessionManager.deleteSnapshot(executionId);
    } finally {
      this.hasPersistedSnapshot = false;
    }
  }
}
