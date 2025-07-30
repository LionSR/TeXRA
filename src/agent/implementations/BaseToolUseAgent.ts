// Base class for tool-use agents

// Standard library imports

// Local imports - core
import { BaseAgent } from './BaseAgent';
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting } from '../core/AgentDataclass';
import { getSystemPromptWithRules } from '../utils/promptHelpers';
import { renderPrompt } from '../utils/promptUtils';
import type { IModelHandler } from '../modelHandlers';
import type { ToolDefinition } from '@model';

import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import { BaseTool } from '@tools/core/base';
import { runToolUseCycle } from '../core/ToolUseCycle';
import { ToolState } from '../core/ToolState';
import { TOOL_USE_INSTRUCTIONS } from '../utils/toolUsePrompt';

export class BaseToolUseAgent extends BaseAgent {
  private toolRegistry: Record<string, BaseTool<any>>;

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

      const messages = await this.modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        undefined,
        systemPrompt,
      );

      const toolState = new ToolState();

      const resolvedSetting = {
        ...this.agentSetting,
        tools: this.getTools(),
      };

      await runToolUseCycle(
        {
          modelHandler: this.modelHandler,
          agentSetting: resolvedSetting,
          agentPrompt: this.agentPrompt,
          userVars: this.userVars,
          logger: this.logger,
          client: this.client,
          toolRegistry: this.toolRegistry,
          checkInterruption: () => this.checkInterruption(),
          setAbortController: (ctrl) => {
            this.abortController = ctrl;
          },
          toolState,
        },
        messages,
        this.runGroupId,
      );
      this.endRunGroup('stopped');
    } catch (err) {
      this.endRunGroup('error');
      throw err;
    } finally {
      this.cleanup();
    }
  }
}
