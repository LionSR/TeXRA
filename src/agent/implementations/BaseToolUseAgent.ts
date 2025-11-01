// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import {
  AgentPrompt,
  AgentSetting,
  AgentType,
  AgentCategory,
  resolveAgentSessionDescriptor,
} from '../core/AgentDataclass';
import { ToolState } from '../core/ToolState';
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
import type {
  AgentLifecycleHooks,
  ToolUseLifecycleHooks,
} from '@agent/implementations/flows/common/AgentLifecycleController';
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
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
  private messages: ProviderMessage[] = [];
  private toolState: ToolState | null = null;
  private readonly toolUseLifecycle: ToolUseLifecycleHooks;

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    executionId?: ExecutionId,
  ) {
    super(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      executionId,
    );
    this.toolRegistry = DEFAULT_TOOL_REGISTRY;
    this.toolUseLifecycle = this.lifecycle.configureToolUseLifecycle({
      getExecutionId: () => this.getExecutionId(),
      getMessages: () => this.messages,
      getToolState: () => this.toolState,
      getSessionDescriptor: () => this.getSessionMetadata(),
      getAgentIdentifier: () => ({
        agentName: this.agentConfig.agent,
        modelName: this.agentConfig.model,
      }),
    });
  }

  protected override registerRunningAgent(streamTabId: StreamTabId): void {
    registerToolUseAgent(streamTabId, this);
  }

  protected override unregisterRunningAgent(streamTabId: StreamTabId): void {
    unregisterToolUseAgent(streamTabId);
  }

  public override getSessionMetadata() {
    return resolveAgentSessionDescriptor(
      AgentType.ToolUse,
      AgentCategory.ToolUse,
    );
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
    this.toolUseLifecycle.appendFollowUp(text);
  }

  /**
   * Configures the agent to resume from a persisted snapshot
   * @param snapshot - The snapshot to resume from
   */
  public resumeFromSnapshot(snapshot: ToolUseSessionSnapshot): void {
    this.toolUseLifecycle.resumeFromSnapshot(snapshot);
  }

  public override interrupt(): void {
    super.interrupt();
    void this.toolUseLifecycle.clearPersistedSnapshot();
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
        }) satisfies ToolUseRunState<C>,
      createFlow: () => createToolUseRunFlow<C>(),
      extendHooks: (baseHooks: AgentLifecycleHooks) => ({
        ...baseHooks,
        start: async () => undefined,
        init: (runGroupId) => this.init(runGroupId, { createGroup: false }),
        prepareState: () => this.prepareInitialSessionState(),
        buildCycleOptions: (toolState) =>
          this.buildToolUseCycleOptions(toolState),
        runCycle: (options, messages) =>
          runToolUseCycle({
            options,
            messages,
          }),
        checkInterruption: () => this.lifecycle.checkInterruption(),
        hasQueuedFollowUp: () => this.toolUseLifecycle.hasQueuedFollowUp(),
        enterWaitingState: () => this.toolUseLifecycle.enterWaitingState(),
        clearPersistedSnapshot: () =>
          this.toolUseLifecycle.clearPersistedSnapshot(),
        waitForFollowUp: () => this.toolUseLifecycle.waitForFollowUp(),
        markRunning: () => this.toolUseLifecycle.markRunning(),
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
    toolState: ToolState;
    shouldSkipCycle: boolean;
  }> {
    const resumeSnapshot = this.toolUseLifecycle.consumeResumeSnapshot();
    if (resumeSnapshot) {
      this.logger.debug('Resuming tool-use session from saved state.');
      const rawMessages = resumeSnapshot.messages ?? [];
      if (!Array.isArray(rawMessages)) {
        throw new Error('Invalid snapshot: messages must be an array');
      }

      const messages = rawMessages as ProviderMessage[];
      let toolState: ToolState;

      try {
        toolState =
          ToolUseSessionManager.hydrateToolStateFromSnapshot(resumeSnapshot);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error while hydrating tool state';
        this.logger.warn(
          `Failed to hydrate tool state from snapshot: ${message}`,
        );
        toolState = new ToolState();
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

    const toolState = new ToolState();

    this.messages = messages;
    this.toolState = toolState;

    return {
      messages,
      toolState,
      shouldSkipCycle: false,
    };
  }

  private buildToolUseCycleOptions(
    toolState: ToolState,
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
    };
  }
}
