// Utility to run iterative tool-use cycles

// Third-party imports
import { encode as encodeHtml } from 'he';
import { createPartFromFunctionResponse } from '@google/genai';

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
  modelHandler: IModelHandler;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  logger: AgentLogger;
  client: any;
  toolRegistry: Record<string, BaseTool<any>>;
  checkInterruption: () => Promise<boolean> | boolean;
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
    }
    if (usage) {
      logger.statistics(usage, groupId);
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
          error: err instanceof Error ? err.message : String(err),
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

    if (modelHandler.isAnthropic) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify(resultObj),
          },
        ],
      });
    } else if (modelHandler.isOpenaiCompatible) {
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify(resultObj),
      });
    } else if (modelHandler.isGoogle) {
      const part = createPartFromFunctionResponse(id, name, resultObj);
      messages.push({ role: 'user', parts: [part] });
    } else {
      messages.push({ role: 'user', content: JSON.stringify(resultObj) });
    }
  }
}
