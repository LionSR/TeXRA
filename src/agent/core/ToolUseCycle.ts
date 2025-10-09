// Local imports - agent
import type { IModelHandler } from '../modelHandlers';
import type { ProviderMessage } from '../modelHandlers/types/ProviderMessage';

// Local imports - agent components
import type { AgentSetting, AgentPrompt } from './AgentDataclass';
import { ToolState } from './ToolState';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
// Utility to run iterative tool-use cycles

// Third-party imports

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ToolDefinition } from '@model';
import { BaseTool } from '@tools/core/base';
import { ToolResult, toolResult } from '@tools/result';
import { sanitizeToolResultForLog } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

export interface ToolUseCycleOptions<C = unknown> {
  /** Model handler for API interactions */
  modelHandler: IModelHandler<any, any, any, any, C>;
  /** Agent settings with tool configuration */
  agentSetting: AgentSetting;
  /** Prompt configuration for the agent */
  agentPrompt: AgentPrompt;
  /** User variables resolved from YAML */
  userVars: Record<string, any>;
  /** Logger instance for progress output */
  logger: AgentLogger;
  /** Provider client object */
  client: C;
  /** Registry mapping tool names to implementations */
  toolRegistry: Record<string, BaseTool<any>>;
  /** Check if the agent run has been interrupted */
  checkInterruption: () => Promise<boolean> | boolean;
  /** Pass abort controllers back to the agent */
  setAbortController: (ctrl: AbortController | null) => void;
  /** Runtime state tracking for tools */
  toolState?: ToolState;
  /** Name of the model used for this run */
  modelName?: string;
}

/**
 * Execute a tool-use interaction loop until the model returns no tool calls or
 * signals end of turn.
 */
export async function runToolUseCycle<C = unknown>(
  options: ToolUseCycleOptions<C>,
  messages: ProviderMessage[],
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
    toolState,
    modelName,
  } = options;

  let iteration = 0;

  while (true) {
    if (await checkInterruption()) {
      break;
    }

    await maybeSaveDebugObject({
      object: messages,
      objectType: 'messages',
      context: {
        logger,
        modelName,
        groupId,
      },
      fileOptions: {
        continuationCount: iteration,
        baseName: 'tooluse',
      },
    });

    const abortController = new AbortController();
    setAbortController(abortController);
    let response: any;
    const startTime = Date.now();
    try {
      modelHandler.setOutputStreaming(true);
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
    await maybeSaveDebugObject({
      object: response,
      objectType: 'response',
      context: {
        logger,
        modelName,
        groupId,
      },
      fileOptions: {
        continuationCount: iteration,
        baseName: 'tooluse_response',
      },
    });
    const responseTime = (Date.now() - startTime) / 1000;
    if (!response) {
      break;
    }

    const thinking = modelHandler.processThinkingBlock(
      response,
      groupId,
      toolState,
    );
    const useStreaming = modelHandler.getStreamingConfig();
    if (thinking && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinking);
      if (formatted.trim().length > 0) {
        logger.info(formatted, groupId, MESSAGE_TYPES.THINKING);
      }
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
      if (!useStreaming) {
        const formatted = await xmlUtils.formatContent(text);
        logger.info(formatted, groupId, MESSAGE_TYPES.MODEL_RESPONSE);
      }
    }
    if (usage) {
      const normalized = modelHandler.computeResponseUsage(usage, responseTime);
      const stats: ExtendedTokenUsageStats = {
        inputTokens: normalized.totalInputTokens,
        outputTokens: normalized.totalOutputTokens,
        cost: normalized.cost,
        elapsedTime: normalized.responseTime,
      };
      logger.statistics(stats, groupId);
    }

    const endTurn = modelHandler.isEndTurnStop(stopReason);
    if (!toolInfo || endTurn) {
      if (text) {
        messages.push(modelHandler.createAssistantMessage(text));
        toolState?.updateLastResponse(text);
      }
      break;
    }

    // Parse tool info first before logging
    let parsed: any;
    try {
      parsed = JSON.parse(toolInfo);
    } catch (err) {
      const errorMsg = `Malformed tool JSON: ${err instanceof Error ? err.message : String(err)}`;

      // Log the failed tool use attempt
      const errorResult = toolResult({ error: errorMsg, isError: true });
      const toolUseLog = {
        tool: 'unknown',
        input: toolInfo,
        output: sanitizeToolResultForLog(errorResult),
      };
      logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      break;
    }

    const id =
      parsed.call_id || parsed.id || parsed.tool_use_id || parsed.tool_call_id;
    const name = parsed.name || parsed.function?.name;
    if (!name) {
      const errorMsg = `Tool JSON missing name: ${JSON.stringify(parsed)}`;

      // Log the failed tool use attempt with available info
      const errorResult = toolResult({ error: errorMsg, isError: true });
      const toolUseLog = {
        tool: 'unknown',
        input: parsed,
        output: sanitizeToolResultForLog(errorResult),
      };
      logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      break;
    }
    let input = parsed.input ?? parsed.args;
    if (!input && parsed.arguments) {
      try {
        input = JSON.parse(parsed.arguments);
      } catch {
        input = parsed.arguments;
      }
    }
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
      result = toolResult({ error: `Unknown tool ${name}`, isError: true });
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

        result = toolResult({
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
      output: sanitizeToolResultForLog(result),
    };

    logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);

    // Build provider-specific message containing the tool result
    const resultObj: Record<string, unknown> = {};
    if (result.summary !== undefined) resultObj.summary = result.summary;
    if (result.output !== undefined) resultObj.output = result.output;
    if (result.error !== undefined) resultObj.error = result.error;
    if (result.base64Image !== undefined)
      resultObj.base64Image = result.base64Image;
    if (result.system !== undefined) resultObj.system = result.system;
    if (result.isError) resultObj.isError = true;
    if (result.diagnostics !== undefined)
      resultObj.diagnostics = result.diagnostics;
    if (result.files !== undefined) resultObj.files = result.files;

    if (result.files && result.files.length > 0 && toolState) {
      const existing = toolState.mediaFiles;
      const toAdd: string[] = [];
      for (const attachment of result.files) {
        const candidate = attachment.path;
        if (typeof candidate !== 'string' || candidate.trim() === '') {
          continue;
        }
        if (existing.includes(candidate) || toAdd.includes(candidate)) {
          continue;
        }
        try {
          const exists = await WorkspaceFS.exists(candidate);
          if (exists) {
            toAdd.push(candidate);
          }
        } catch {
          // Ignore errors when checking existence; attachment metadata may still be useful
        }
      }
      if (toAdd.length > 0) {
        toolState.addMediaFiles(toAdd);
      }
    }

    const followUpMsgs = await modelHandler.createToolUseFollowUpMessages(
      id,
      name,
      parsed,
      resultObj,
      toolState,
      text,
      client,
    );
    messages.push(...followUpMsgs);

    iteration++;
  }
}
