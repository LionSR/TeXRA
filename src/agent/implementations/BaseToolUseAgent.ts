// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import {
  AgentPrompt,
  AgentSessionKind,
  AgentSetting,
} from '../core/AgentDataclass';
import { ToolState } from '../core/ToolState';
import type { IModelHandler } from '../modelHandlers';
import type { ProviderMessage } from '../modelHandlers/types/ProviderMessage';
// Base class for tool-use agents

// Standard library imports

// Local imports - core
import { BaseAgent } from './BaseAgent';
import {
  createToolUseFlow,
  type ToolUseRunShared,
} from './toolUse/nodes/ToolUseFlow';
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { bus } from '@eventBus/ProgressEventBus';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';

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
    const flow = createToolUseFlow<C>();
    const shared = this.createRunShared();

    try {
      await flow.run(shared);
    } finally {
      await this.clearPersistedSnapshot();
      this.cleanup();
    }
  }

  private createRunShared(): ToolUseRunShared<C> {
    const shared: ToolUseRunShared<C> = {
      agent: this,
      agentConfig: this.agentConfig,
      agentSetting: this.agentSetting,
      agentPrompt: this.agentPrompt,
      modelHandler: this.modelHandler,
      toolRegistry: this.toolRegistry,
      logger: this.logger,
      shouldSkipCycle: false,
      cycleOptions: undefined,
      getUserVars: () => this.userVars,
      getMessages: () => this.messages,
      setMessages: (messages: ProviderMessage[]) => {
        this.messages = messages;
      },
      getToolState: () => this.toolState,
      setToolState: (state: ToolState | null) => {
        this.toolState = state;
      },
      getResumeSnapshot: () => this.resumeSnapshot,
      setResumeSnapshot: (snapshot: ToolUseSessionSnapshot | null) => {
        this.resumeSnapshot = snapshot;
      },
      waitForFollowUp: () => this.waitForFollowUp(),
      hasQueuedFollowUp: () => this.followUpQueue.length > 0,
      enterWaitingState: () => this.enterWaitingState(),
      clearPersistedSnapshot: () => this.clearPersistedSnapshot(),
      markRunning: () => this.markRunning(),
      logUserMessage: (text: string) => {
        this.logger.userMessage(text);
      },
      createUserFollowUpMessages: (
        messages: ProviderMessage[],
        followUp: string,
      ) => this.modelHandler.createUserFollowUpMessages(messages, followUp),
      checkInterruption: () => this.checkInterruption(),
      initializeClient: () => this.initializeClient(),
      getClientInstance: () => this.getClientInstance(),
      initAgent: () => this.init(undefined, { createGroup: false }),
      resolveTools: () => this.getTools(),
      setAbortController: (ctrl: AbortController | null) => {
        this.abortController = ctrl;
      },
    };

    return shared;
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
            agentSessionKind: AgentSessionKind.ToolUse,
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
