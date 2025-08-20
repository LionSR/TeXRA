// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting } from '../core/AgentDataclass';
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

export class BaseToolUseAgent extends BaseAgent {
  private toolRegistry: Record<string, BaseTool<any>>;
  private followUpQueue: string[] = [];
  private followUpResolver: ((v: string | null) => void) | null = null;
  private messages: ProviderMessage[] = [];
  private toolState: ToolState | null = null;

  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    super(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath);
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
        this.logger.warn(
          `Tool "${def.name}" not found in registry`,
          this.runGroupId,
        );
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
  }

  public async run(): Promise<void> {
    await this.startRunGroup();
    try {
      await this.init(this.runGroupId);
      await this.initializeClient();

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
        await runToolUseCycle(cycleOptions, this.messages, this.runGroupId);
        if (this.checkInterruption()) break;
        const followUp = await this.waitForFollowUp();
        if (!followUp || this.checkInterruption()) break;
        this.logger.userMessage(followUp, this.runGroupId);
        this.messages = await this.modelHandler.createUserFollowUpMessages(
          this.messages,
          followUp,
        );
      }

      this.endRunGroup('stopped');
    } catch (err) {
      this.endRunGroup('error');
      throw err;
    } finally {
      this.cleanup();
    }
  }
}
