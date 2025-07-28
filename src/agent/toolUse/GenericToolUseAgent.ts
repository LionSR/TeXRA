// Agent implementation for generic tool use

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
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import { BaseTool } from '@tools/core/base';
import { ToolResult } from '@tools/anthropic/base';

export class GenericToolUseAgent extends BaseAgent {
  private toolRegistry: Record<string, BaseTool<any>>;

  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    registry: Record<string, BaseTool<any>> = DEFAULT_TOOL_REGISTRY,
  ) {
    super(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath);
    this.toolRegistry = registry;
  }

  private getTools(): ToolDefinition[] {
    const cfg = this.agentSetting.tools;
    const tools: ToolDefinition[] = [];
    for (const t of cfg) {
      tools.push(typeof t === 'string' ? { name: t } : t);
    }
    return tools;
  }

  private async runTool(name: string, input: any): Promise<ToolResult> {
    const tool = this.toolRegistry[name];
    if (!tool) {
      return new ToolResult({ error: `Unknown tool ${name}`, isError: true });
    }
    return tool.call(input);
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
        try {
          const parsed = JSON.parse(toolInfo);
          const result = await this.runTool(parsed.name, parsed.input);
          this.logger.info(
            encodeHtml(JSON.stringify(result, null, 2)),
            this.runGroupId,
            MESSAGE_TYPES.TOOL_USE,
          );
        } catch (err) {
          this.logger.error(
            `Failed to execute tool: ${err instanceof Error ? err.message : String(err)}`,
            this.runGroupId,
          );
        }
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
