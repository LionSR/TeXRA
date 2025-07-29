// Utility to run iterative tool-use cycles

// Third-party imports
import { encode as encodeHtml } from 'he';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - agent components
import type { AgentSetting, AgentPrompt } from './AgentDataclass';
import type { ToolDefinition } from '@model';
import type { IModelHandler } from '../modelHandlers';
import { BaseTool } from '@tools/core/base';
import { ToolResult } from '@tools/result';
import xmlUtils from '@utils/text/xmlUtils';

export interface ToolUseCycleOptions {
  /** Model handler for API interactions */
  modelHandler: IModelHandler;
  /** Agent settings with tool configuration */
  agentSetting: AgentSetting;
  /** Prompt configuration for the agent */
  agentPrompt: AgentPrompt;
  /** User variables resolved from YAML */
  userVars: Record<string, any>;
  /** Logger instance for progress output */
  logger: AgentLogger;
  /** Provider client object */
  client: any;
  /** Registry mapping tool names to implementations */
  toolRegistry: Record<string, BaseTool<any>>;
  /** Check if the agent run has been interrupted */
  checkInterruption: () => Promise<boolean> | boolean;
  /** Pass abort controllers back to the agent */
  setAbortController: (ctrl: AbortController | null) => void;
}

/**
 * Execute a tool-use interaction loop until the model returns no tool calls or
 * signals end of turn.
 */
export async function runToolUseCycle(
  options: ToolUseCycleOptions,
  messages: any[],
  groupId?: string,
): Promise<void> {
  const {
    modelHandler,
    agentSetting,
    logger,
    client,
    toolRegistry,
    checkInterruption,
    setAbortController,
  } = options;

  while (true) {
    if (await checkInterruption()) {
      break;
    }

    const abortController = new AbortController();
    setAbortController(abortController);
    let response: any;
    const startTime = Date.now();
    try {
      response = await modelHandler.createResponse(
        client,
        messages,
        agentSetting.temperature ?? 0,
        undefined,
        agentSetting.endTag,
        abortController.signal,
        agentSetting.tools as ToolDefinition[],
      );
    } finally {
      setAbortController(null);
    }
    const responseTime = (Date.now() - startTime) / 1000;
    if (!response) {
      break;
    }

    const thinking = modelHandler.processThinkingBlock(response, groupId);
    if (thinking) {
      const formatted = await xmlUtils.formatContent(thinking);
      logger.info(formatted, groupId, MESSAGE_TYPES.THINKING);
    }

    const toolInfo = modelHandler.extractToolUse(response);
    const [text, usage, stopReason] = modelHandler.extractResponse(
      response,
      agentSetting.endTag,
    );
    if (text) {
      logger.debug(`Model response: ${text.slice(0, 100)}`, groupId);
      logger.info(encodeHtml(text), groupId);
    }
    if (usage) {
      const normalized = modelHandler.computeResponseUsage(usage, responseTime);
      const stats = {
        inputTokens: normalized.totalInputTokens,
        outputTokens: normalized.totalOutputTokens,
        cost: normalized.cost,
        elapsedTime: normalized.responseTime,
      };
      logger.statistics(stats, groupId);
    }

    if (!toolInfo || stopReason === 'end_turn') {
      break;
    }

    logger.info(encodeHtml(toolInfo), groupId, MESSAGE_TYPES.TOOL_USE);

    let parsed: any;
    try {
      parsed = JSON.parse(toolInfo);
    } catch (err) {
      logger.error(
        `Malformed tool JSON: ${err instanceof Error ? err.message : String(err)}`,
        groupId,
      );
      break;
    }

    const id = parsed.id || parsed.tool_use_id || parsed.tool_call_id;
    const name = parsed.name || parsed.function?.name;
    if (!id || !name) {
      logger.error(
        `Tool JSON missing id or name: id=${String(id)} name=${String(name)}`,
        groupId,
      );
      break;
    }
    let input = parsed.input;
    if (!input && parsed.function?.arguments) {
      try {
        input = JSON.parse(parsed.function.arguments);
      } catch {
        input = parsed.function.arguments;
      }
    }

    const tool = toolRegistry[name];
    let result: ToolResult;
    if (!tool) {
      result = new ToolResult({ error: `Unknown tool ${name}`, isError: true });
    } else {
      try {
        result = await tool.call(input);
      } catch (err) {
        result = new ToolResult({
          error:
            err instanceof Error
              ? `${name}: ${err.message}`
              : `${name}: ${String(err)}`,
          isError: true,
        });
      }
    }

    logger.info(
      encodeHtml(JSON.stringify(result, null, 2)),
      groupId,
      MESSAGE_TYPES.TOOL_USE,
    );

    // Build provider-specific message containing the tool result
    const resultObj: Record<string, unknown> = {};
    if (result.output !== undefined) resultObj.output = result.output;
    if (result.error !== undefined) resultObj.error = result.error;
    if (result.base64Image !== undefined)
      resultObj.base64Image = result.base64Image;
    if (result.system !== undefined) resultObj.system = result.system;

    const followUp = modelHandler.createFollowUpMessage(id, name, resultObj);
    messages.push(followUp);
  }
}
