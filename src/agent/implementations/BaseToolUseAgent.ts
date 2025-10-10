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
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
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
  private toolState: ToolState | null = null;
  private resumeSnapshot: ToolUseSessionSnapshot | null = null;
  private hasPersistedSnapshot = false;
  private persistenceLock = false; // Lock to prevent race conditions during persistence

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
  }

  protected override registerRunningAgent(streamTabId: StreamTabId): void {
    registerToolUseAgent(streamTabId, this);
  }

  protected override unregisterRunningAgent(streamTabId: StreamTabId): void {
    unregisterToolUseAgent(streamTabId);
  }

  public override getSessionMetadata() {
    return resolveAgentSessionDescriptor(AgentType.ToolUse, AgentCategory.ToolUse);
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
    try {
      await this.init(undefined, { createGroup: false });
      await this.initializeClient();

      let shouldSkipCycle = false;

      if (this.resumeSnapshot) {
        this.logger.debug('Resuming tool-use session from saved state.');
        // Validate messages before hydrating
        const messages = this.resumeSnapshot.messages ?? [];
        if (!Array.isArray(messages)) {
          throw new Error('Invalid snapshot: messages must be an array');
        }
        // Cast with confidence after validation
        this.messages = messages as ProviderMessage[];
        this.toolState = ToolUseSessionManager.hydrateToolStateFromSnapshot(
          this.resumeSnapshot,
        );
        shouldSkipCycle = true;
        this.resumeSnapshot = null;
      } else {
        const [systemPrompt, userRequest, userPrefix] = await Promise.all([
          getSystemPromptWithRules(
            `${this.agentPrompt.systemPrompt}\n${TOOL_USE_INSTRUCTIONS}`,
            this.userVars,
          ),
          renderPrompt(this.agentPrompt.userRequest, this.userVars),
          renderPrompt(this.agentPrompt.userPrefix, this.userVars),
        ]);

        this.messages = await this.modelHandler.initializeMessages(
          userPrefix,
          userRequest,
          undefined,
          systemPrompt,
        );

        this.toolState = new ToolState();
      }

      const resolvedSetting = {
        ...this.agentSetting,
        tools: this.getTools(),
      };

      const client = this.getClientInstance();
      const cycleOptions: ToolUseCycleOptions<C> = {
        modelHandler: this.modelHandler,
        agentSetting: resolvedSetting,
        agentPrompt: this.agentPrompt,
        userVars: this.userVars,
        logger: this.logger,
        client,
        toolRegistry: this.toolRegistry,
        checkInterruption: () => this.checkInterruption(),
        setAbortController: (ctrl: AbortController | null) => {
          this.abortController = ctrl;
        },
        toolState: this.toolState,
        modelName: this.agentConfig.model,
      } as const;

      while (true) {
        if (!shouldSkipCycle) {
          await runToolUseCycle(cycleOptions, this.messages);
        } else {
          shouldSkipCycle = false;
        }

        if (this.checkInterruption()) break;

        const hasQueuedFollowUp = this.followUpQueue.length > 0;
        if (!hasQueuedFollowUp) {
          await this.enterWaitingState();
        } else {
          await this.clearPersistedSnapshot();
        }

        const followUp = await this.waitForFollowUp();
        if (!followUp || this.checkInterruption()) break;

        await this.markRunning();
        await this.clearPersistedSnapshot();

        this.logger.userMessage(followUp);
        this.messages = await this.modelHandler.createUserFollowUpMessages(
          this.messages,
          followUp,
        );
      }
    } finally {
      await this.clearPersistedSnapshot();
      this.cleanup();
    }
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
