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
import { WorkspaceFS } from '@utils/files';
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
    let tools: ToolDefinition[] = [];
    const cfg = this.agentSetting.tools;
    if (Array.isArray(cfg) && cfg.length > 0) {
      if (typeof cfg[0] === 'string') {
        tools = (cfg as unknown as string[]).map((n) => ({ name: n }));
      } else {
        tools = cfg as ToolDefinition[];
      }
    }
    if (this.agentConfig.toolConfig.attachDiagnostics) {
      if (!tools.some((t) => t.name === 'diagnostics')) {
        tools.push({ name: 'diagnostics' });
      }
    }
    return tools;
  }

  private extractToolUse(response: any): string | null {
    if (response?.content && Array.isArray(response.content)) {
      const tu = response.content.find((c: any) => c.type === 'tool_use');
      if (tu) {
        return encodeHtml(JSON.stringify(tu, null, 2));
      }
    }
    const openai = response?.choices?.[0]?.message?.tool_calls?.[0];
    if (openai) {
      return encodeHtml(JSON.stringify(openai, null, 2));
    }
    return null;
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

      const toolInfo = this.extractToolUse(response);
      if (toolInfo) {
        this.logger.info(toolInfo, this.runGroupId, MESSAGE_TYPES.TOOL_USE);
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
        await WorkspaceFS.writeFile(
          this.agentConfig.inputFile + '.tool.txt',
          text,
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
