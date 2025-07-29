// Utility to run iterative tool-use cycles

// Third-party imports

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
        undefined, // endTag - not used in tool use scenarios
        undefined,
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
    // Note: We pass empty string for endTag because model responses in tool use
    // scenarios should not have custom end tags - they're part of the natural
    // conversation flow (not specialized content like thinking/scratchpad)
    const [text, usage, stopReason] = modelHandler.extractResponse(
      response,
      '',
    );
    if (text) {
      logger.debug(`Model response: ${text.slice(0, 100)}`, groupId);
      logger.info(text, groupId, MESSAGE_TYPES.MODEL_RESPONSE);
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

    // Parse tool info first before logging
    let parsed: any;
    try {
      parsed = JSON.parse(toolInfo);
    } catch (err) {
      const errorMsg = `Malformed tool JSON: ${err instanceof Error ? err.message : String(err)}`;

      // Log the failed tool use attempt
      const toolUseLog = {
        tool: 'unknown',
        input: toolInfo,
        output: new ToolResult({ error: errorMsg, isError: true }),
      };
      logger.info(
        JSON.stringify(toolUseLog, null, 2),
        groupId,
        MESSAGE_TYPES.TOOL_USE,
      );
      break;
    }

    const id = parsed.id || parsed.tool_use_id || parsed.tool_call_id;
    const name = parsed.name || parsed.function?.name;
    if (!name) {
      const errorMsg = `Tool JSON missing name: ${JSON.stringify(parsed)}`;

      // Log the failed tool use attempt with available info
      const toolUseLog = {
        tool: 'unknown',
        input: parsed,
        output: new ToolResult({ error: errorMsg, isError: true }),
      };
      logger.info(
        JSON.stringify(toolUseLog, null, 2),
        groupId,
        MESSAGE_TYPES.TOOL_USE,
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
        // Prepare both user-friendly error and detailed diagnostics
        let errorMessage: string;
        let diagnostics: any;

        if (err && typeof err === 'object' && 'issues' in err) {
          // This is a Zod validation error
          const zodError = err as any;
          // Simple message for the model/user
          errorMessage = `${name}: Invalid parameters provided`;
          // Detailed diagnostics for debugging
          diagnostics = {
            type: 'validation_error',
            issues: zodError.issues,
            formatted: zodError.issues?.map((issue: any) => ({
              path: issue.path.join('.'),
              message: issue.message,
              expected: issue.expected,
              received: issue.received,
              code: issue.code,
            })),
          };
        } else {
          errorMessage =
            err instanceof Error
              ? `${name}: ${err.message}`
              : `${name}: ${String(err)}`;
        }

        result = new ToolResult({
          error: errorMessage,
          isError: true,
          diagnostics,
        });
      }
    }

    // Combine tool input and output into a single log entry
    // Extract just the arguments/input based on provider format
    let toolInput = input; // Default to the already extracted input
    if (!toolInput) {
      // Fallback to the raw parsed object if input extraction failed
      toolInput = parsed;
    }

    const toolUseLog = {
      tool: name,
      input: toolInput,
      output: result,
    };

    logger.info(
      JSON.stringify(toolUseLog, null, 2),
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

    const [callMsg, resultMsg] = modelHandler.createFollowUpMessage(
      id,
      name,
      parsed,
      resultObj,
    );
    messages.push(callMsg, resultMsg);
  }
}
