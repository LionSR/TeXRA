// Local imports - agent components
import { BaseAgent } from './BaseAgent';
import { renderPrompt } from '../utils/promptUtils';
import { ToolState } from '../core/ToolState';
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
import xmlUtils from '@utils/text/xmlUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { emitProgress } from '@eventBus/ProgressEventBus';

/**
 * Simple agent to make a single tool use request and log the result.
 */
export class ToolUseAgent extends BaseAgent {
  /**
   * Extract tool use entries from a response object.
   */
  private extractToolUses(response: any): any[] {
    const toolUses: any[] = [];
    if (response && Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item.type === 'tool_use') {
          toolUses.push(item);
        }
      }
    }
    const openAIToolCalls = response?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(openAIToolCalls)) {
      toolUses.push(...openAIToolCalls);
    }
    return toolUses;
  }

  public async run(): Promise<void> {
    this.runGroupId = await this.logger.startGroup(
      `Run: ${this.agentConfig.agent}@${this.agentConfig.model}`,
    );

    try {
      await this.init(this.runGroupId);
      await this.initializeClient();

      const [systemPrompt, userPrefix, userRequest] = await Promise.all([
        renderPrompt(this.agentPrompt.systemPrompt, this.userVars),
        renderPrompt(this.agentPrompt.userPrefix, this.userVars),
        renderPrompt(this.agentPrompt.userRequest, this.userVars),
      ]);

      const messages = await this.modelHandler.initializeMessages(
        userPrefix,
        userRequest,
        this.agentConfig.mediaFiles || undefined,
        systemPrompt,
      );

      const toolState = new ToolState();
      const stateRound = new AgentStateRound(0);
      const stateGlobal = new AgentStateGlobal();

      const startTime = Date.now();
      this.abortController = new AbortController();
      let responseObject: any;
      try {
        responseObject = await this.modelHandler.createResponse(
          this.client,
          messages,
          this.agentSetting.temperature || 0.0,
          systemPrompt,
          this.agentSetting.endTag,
          this.abortController.signal,
        );
      } finally {
        this.abortController = null;
      }

      if (!responseObject) {
        this.logger.warn(
          'Model response was aborted or returned no data; output may be incomplete.',
          this.runGroupId,
        );
        return;
      }

      const responseTime = (Date.now() - startTime) / 1000;
      stateRound.updateResponseTime(responseTime);

      const [textResponse, responseUsage] = this.modelHandler.extractResponse(
        responseObject,
        this.agentSetting.endTag,
      );

      const apiUsage = this.modelHandler.computeResponseUsage(
        responseUsage,
        responseTime,
      );
      stateRound.updateTokenCounts(apiUsage);
      stateGlobal.updateFromCurrRound(stateRound);

      const thinking = this.modelHandler.processThinkingBlock(
        responseObject,
        this.runGroupId,
        toolState,
      );
      if (thinking) {
        const formatted = await xmlUtils.formatContent(thinking);
        this.logger.info(formatted, this.runGroupId, MESSAGE_TYPES.THINKING);
      }

      for (const toolUse of this.extractToolUses(responseObject)) {
        this.logger.info(JSON.stringify(toolUse, null, 2), this.runGroupId);
      }

      if (textResponse) {
        this.logger.info(textResponse, this.runGroupId);
      }

      emitProgress('updateGroupUsage', {
        stream: this.logger.channelId,
        groupId: this.runGroupId,
        usage: {
          inputTokens: apiUsage.totalInputTokens,
          outputTokens: apiUsage.totalOutputTokens,
          cost: apiUsage.cost,
        },
      });

      this.logger.endGroup(this.runGroupId, 'stopped');
    } catch (error) {
      if (this.runGroupId) {
        this.logger.endGroup(this.runGroupId, 'error');
      }
      throw error;
    } finally {
      this.cleanup();
    }
  }
}
