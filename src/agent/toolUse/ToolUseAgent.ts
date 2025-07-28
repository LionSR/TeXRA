// Agent implementation for one-shot tool use conversations

// Standard library imports
import { encode as encodeHtml } from 'he';
// Local imports - core
import { BaseAgent } from '../implementations/BaseAgent';
import type { AgentConfig } from '../core/AgentConfig';
import { AgentPrompt, AgentSetting } from '../core/AgentDataclass';
import { getSystemPromptWithRules } from '../utils/promptHelpers';
import { renderPrompt } from '../utils/promptUtils';
import type { IModelHandler } from '../modelHandlers';
import type { ToolDefinition } from '@model';
import xmlUtils from '@utils/text/xmlUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';

export class ToolUseAgent extends BaseAgent {
  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    super(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath);
  }

  private getTools(): ToolDefinition[] {
    const cfg = this.agentSetting.tools;
    let tools: ToolDefinition[] = [];

    if (Array.isArray(cfg) && cfg.length > 0) {
      if (cfg.every((t) => typeof t === 'string')) {
        tools = (cfg as string[]).map((name) => ({ name }));
      } else {
        tools = cfg as ToolDefinition[];
      }
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
        getSystemPromptWithRules(this.agentPrompt.systemPrompt, this.userVars),
        renderPrompt(this.agentPrompt.userRequest, this.userVars),
        renderPrompt(this.agentPrompt.userPrefix, this.userVars),
      ]);

      const messages = await this.modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        undefined,
        systemPrompt,
      );

      const response = await this.modelHandler.createResponse(
        this.client,
        messages,
        this.agentSetting.temperature ?? 0,
        undefined,
        this.agentSetting.endTag,
        undefined,
        this.getTools(),
      );

      const thinking = this.modelHandler.processThinkingBlock(
        response,
        this.runGroupId,
      );
      if (thinking) {
        const formatted = await xmlUtils.formatContent(thinking);
        this.logger.info(formatted, this.runGroupId, MESSAGE_TYPES.THINKING);
      }

      const toolInfo = this.modelHandler.extractToolUse(response);
      if (toolInfo) {
        this.logger.info(
          encodeHtml(toolInfo),
          this.runGroupId,
          MESSAGE_TYPES.TOOL_USE,
        );
      }

      const [text, usage] = this.modelHandler.extractResponse(
        response,
        this.agentSetting.endTag,
      );
      if (text) {
        this.logger.debug(
          `Model response: ${text.slice(0, 100)}`,
          this.runGroupId,
        );
      }
      if (usage) {
        this.logger.statistics(usage, this.runGroupId);
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
