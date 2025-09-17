// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSessionKind, AgentSetting } from '../core/AgentDataclass';
import { ToolState } from '../core/ToolState';
import { runToolUseCycle } from '../core/ToolUseCycle';
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
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { bus } from '@eventBus/ProgressEventBus';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';

export class BaseToolUseAgent extends BaseAgent {
  private toolRegistry: Record<string, BaseTool<any>>;
  private followUpQueue: string[] = [];
  private followUpResolver: ((v: string | null) => void) | null = null;
  private messages: ProviderMessage[] = [];
  private toolState: ToolState | null = null;
  private resumeSnapshot: ToolUseSessionSnapshot | null = null;
  private hasPersistedSnapshot = false;

  constructor(
    modelHandler: IModelHandler,
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

  public appendFollowUp(text: string): void {
    if (this.followUpResolver) {
      this.followUpResolver(text);
      this.followUpResolver = null;
    } else {
      this.followUpQueue.push(text);
    }
  }

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
        this.logger.info('Resuming tool-use session from saved state.');
        this.messages = (this.resumeSnapshot.messages ?? []) as ProviderMessage[];
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

      const cycleOptions = {
        modelHandler: this.modelHandler,
        agentSetting: resolvedSetting,
        agentPrompt: this.agentPrompt,
        userVars: this.userVars,
        logger: this.logger,
        client: this.client,
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
    if (this.followUpQueue.length > 0) {
      return;
    }
    const stream = this.getStreamTabId();
    const executionId = this.getExecutionId();
    const state = this.toolState;

    if (
      state &&
      executionId &&
      ToolUseSessionManager.isPersistenceEnabled() &&
      this.followUpQueue.length === 0
    ) {
      await ToolUseSessionManager.saveSnapshot({
        executionId,
        streamId: stream,
        agentName: this.agentConfig.agent,
        model: this.agentConfig.model,
        agentSessionKind: AgentSessionKind.ToolUse,
        messages: this.messages,
        toolState: state,
      });

      if (this.followUpQueue.length > 0) {
        await ToolUseSessionManager.deleteSnapshot(executionId);
        this.hasPersistedSnapshot = false;
        return;
      }

      this.hasPersistedSnapshot = true;
    }

    bus.emit('updateStreamStatus', {
      stream,
      status: 'waiting',
    });
  }

  private async markRunning(): Promise<void> {
    bus.emit('updateStreamStatus', {
      stream: this.getStreamTabId(),
      status: 'running',
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
