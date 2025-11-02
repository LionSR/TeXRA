// Third-party imports
import { z } from 'zod';

// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from './FlowTransitions';

// Local imports - agent components
import { ToolState } from '@agent/core/ToolState';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';

// Local imports - model handler types
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import type { DebugObjectType } from '@agent/utils/debugMessageSaver';
import { sanitizeToolResultForLog } from '@agent/modelHandlers/utils/toolAttachmentUtils';

// Local imports - logging
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - tools
import { ToolResult, toolResult } from '@tools/result';
import type { ToolDefinition } from '@model';

// Local imports - error utilities
import { toErrorMessage } from '@common/errors/errorHandlingUtils';

// Local imports - filesystem utilities
import { WorkspaceFS } from '@utils/files';

// Local imports - text utilities
import xmlUtils from '@utils/text/xmlUtils';

// Local imports - usage types
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';

interface DebugContext {
  logger: ToolUseCycleOptions['logger'];
  modelName?: string;
  executionId?: ToolUseCycleOptions['executionId'];
}

interface DebugFileOptions {
  continuationCount: number;
  baseName: string;
}

async function maybeSaveDebug(
  debugContext: DebugContext,
  debugFileOptions: DebugFileOptions,
  object: unknown,
  objectType: DebugObjectType,
): Promise<void> {
  await maybeSaveDebugObject({
    object,
    objectType,
    context: debugContext,
    fileOptions: debugFileOptions,
  });
}

// Zod schemas for tool call validation
const ToolCallIdSchema = z.string().min(1, 'Tool call ID cannot be empty');

const ToolCallSchema = z.object({
  call_id: z.string().optional(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  input: z.any().optional(),
  args: z.any().optional(),
  arguments: z.any().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.any().optional(),
    })
    .optional(),
});

interface ToolValidationDiagnostics {
  type: 'validation_error';
  issues: any;
  formatted: Array<{
    path: string;
    message: string;
    expected?: unknown;
    received?: unknown;
    code?: string;
  }>;
}

function normalizeToolCallError(
  toolName: string,
  error: unknown,
): { message: string; diagnostics?: ToolValidationDiagnostics } {
  if (error && typeof error === 'object' && 'issues' in error) {
    const zodError = error as { issues?: any[] };
    const issues = [zodError.issues].flat().filter(Boolean);
    return {
      message: `${toolName}: Invalid parameters provided`,
      diagnostics: {
        type: 'validation_error',
        issues,
        formatted: issues.map((issue) => ({
          path: [issue?.path].flat().join('.'),
          message: issue.message,
          expected: issue.expected,
          received: issue.received,
          code: issue.code,
        })),
      },
    };
  }

  const fallbackMessage =
    error instanceof Error
      ? `${toolName}: ${error.message}`
      : `${toolName}: ${String(error)}`;

  return { message: fallbackMessage };
}

function extractToolCallId(parsed: any): string {
  const validated = ToolCallSchema.parse(parsed);
  const rawId =
    validated.call_id ??
    validated.id ??
    validated.tool_use_id ??
    validated.tool_call_id;

  if (!rawId) {
    throw new Error(
      `Tool JSON missing call identifier: ${JSON.stringify(parsed)}`,
    );
  }

  return ToolCallIdSchema.parse(rawId);
}

type ToolDispatchErrorResult = {
  handledError: true;
  toolCallId?: string;
  toolName: string;
  result: ToolResult;
  parsed?: any;
  fallbackMessage?: string;
};

export interface ToolUseCycleInputState {
  messages: ProviderMessage[];
  toolState: ToolState;
  iteration: number;
}

export interface ToolUseCycleRuntimeState {
  shouldStop: boolean;
  response?: unknown;
  responseTime?: number;
  toolInfo?: string;
  text?: string;
  stopReason?: ProviderStopReason;
}

export type ToolUseCycleState = ToolUseCycleInputState &
  ToolUseCycleRuntimeState;

function resetToolUseState(state: ToolUseCycleRuntimeState): void {
  state.shouldStop = false;
  state.response = undefined;
  state.responseTime = undefined;
  state.toolInfo = undefined;
  state.text = undefined;
  state.stopReason = undefined;
}

export interface ToolUseCycleShared<C = unknown> {
  options: ToolUseCycleOptions<C>;
  state: ToolUseCycleState;
}

class ToolUsePrepNode<C> extends BaseNode<ToolUseCycleShared<C>> {
  async prep(shared: ToolUseCycleShared<C>): Promise<{
    interrupted: boolean;
    debugContext: DebugContext;
    debugFileOptions: DebugFileOptions;
  }> {
    const { options, state } = shared;
    const interrupted = Boolean(await options.checkInterruption());
    const debugContext: DebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.executionId,
    };
    const debugFileOptions: DebugFileOptions = {
      continuationCount: state.iteration,
      baseName: 'tooluse',
    };
    return { interrupted, debugContext, debugFileOptions };
  }

  async post(
    { state }: ToolUseCycleShared<C>,
    prepRes: {
      interrupted: boolean;
      debugContext: DebugContext;
      debugFileOptions: DebugFileOptions;
    },
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    // Reset at the start of each cycle so downstream nodes observe a clean
    // runtime state before enriching it with model responses.
    resetToolUseState(state);

    await maybeSaveDebug(
      prepRes.debugContext,
      prepRes.debugFileOptions,
      state.messages,
      'messages',
    );

    return undefined;
  }
}

function buildToolResultPayload(result: ToolResult): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (result.summary !== undefined) payload.summary = result.summary;
  if (result.output !== undefined) payload.output = result.output;
  if (result.error !== undefined) payload.error = result.error;
  if (result.base64Image !== undefined)
    payload.base64Image = result.base64Image;
  if (result.system !== undefined) payload.system = result.system;
  if (result.isError) payload.isError = true;
  if (result.diagnostics !== undefined)
    payload.diagnostics = result.diagnostics;
  if (result.files !== undefined) payload.files = result.files;
  return payload;
}

class ToolUseCallNode<C> extends BaseNode<ToolUseCycleShared<C>> {
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseCycleShared<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleShared<C>): Promise<
    | { skipped: true }
    | {
        response: unknown;
        responseTime?: number;
        debugContext: DebugContext;
        debugFileOptions: DebugFileOptions;
      }
  > {
    const { options, state } = context;
    if (state.shouldStop) {
      return { skipped: true };
    }

    const debugContext: DebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.executionId,
    };
    const debugFileOptions: DebugFileOptions = {
      continuationCount: state.iteration,
      baseName: 'tooluse_response',
    };

    const abortController = new AbortController();
    options.setAbortController(abortController);

    let response: unknown;
    const start = Date.now();
    try {
      options.modelHandler.setOutputStreaming(true);
      response = await options.modelHandler.createResponse(
        options.client,
        state.messages,
        options.agentSetting.temperature ?? 0,
        undefined,
        undefined,
        abortController.signal,
        options.agentSetting.tools as ToolDefinition[] | undefined,
      );
    } finally {
      options.setAbortController(null);
    }

    const responseTime = (Date.now() - start) / 1000;

    return { response, responseTime, debugContext, debugFileOptions };
  }

  async post(
    _shared: ToolUseCycleShared<C>,
    prepRes: ToolUseCycleShared<C>,
    execRes:
      | { skipped: true }
      | {
          response: unknown;
          responseTime?: number;
          debugContext: DebugContext;
          debugFileOptions: DebugFileOptions;
        },
  ): Promise<string | undefined> {
    const { options, state } = prepRes;

    if ('skipped' in execRes) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    state.response = execRes.response;
    state.responseTime = execRes.responseTime;

    await maybeSaveDebug(
      execRes.debugContext,
      execRes.debugFileOptions,
      execRes.response,
      'response',
    );

    if (!execRes.response) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    return undefined;
  }
}

class ToolUseProcessNode<C> extends BaseNode<ToolUseCycleShared<C>> {
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseCycleShared<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleShared<C>): Promise<
    | { skipped: true }
    | {
        toolInfo?: string;
        stopReason: ProviderStopReason;
        text?: string;
        endTurn: boolean;
      }
  > {
    const { options, state } = context;
    if (state.shouldStop || !state.response) {
      return { skipped: true };
    }

    const groupId = options.logger.getActiveGroupId();

    const thinking = options.modelHandler.processThinkingBlock(
      state.response,
      groupId,
      state.toolState,
    );
    const useStreaming = options.modelHandler.getStreamingConfig();
    if (thinking && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinking);
      if (formatted.trim().length > 0) {
        options.logger.info(formatted, groupId, MESSAGE_TYPES.THINKING);
      }
    }

    const toolInfo = options.modelHandler.extractToolUse(state.response);
    const [text, usage, stopReason] = options.modelHandler.extractResponse(
      state.response,
      '',
    );

    if (text) {
      options.logger.debug(`Model response: ${text.slice(0, 100)}`, groupId);
      if (!useStreaming) {
        const formatted = await xmlUtils.formatContent(text);
        options.logger.info(formatted, groupId, MESSAGE_TYPES.MODEL_RESPONSE);
      }
    }

    if (usage) {
      const normalized = options.modelHandler.computeResponseUsage(
        usage,
        state.responseTime ?? 0,
      );
      const stats: ExtendedTokenUsageStats = {
        inputTokens: normalized.totalInputTokens,
        outputTokens: normalized.totalOutputTokens,
        cost: normalized.cost,
        elapsedTime: normalized.responseTime,
      };
      options.logger.statistics(stats, groupId);
    }

    const endTurn = options.modelHandler.isEndTurnStop(stopReason);

    if (!toolInfo || endTurn) {
      if (text) {
        state.messages.push(options.modelHandler.createAssistantMessage(text));
        state.toolState.updateLastResponse(text);
      }
      state.shouldStop = true;
      return { stopReason, text, endTurn: true };
    }

    state.toolInfo = toolInfo;
    state.text = text ?? undefined;
    state.stopReason = stopReason;

    return { toolInfo, stopReason, text: text ?? undefined, endTurn: false };
  }

  async post(
    _shared: ToolUseCycleShared<C>,
    _prepRes: unknown,
    execRes:
      | { skipped: true }
      | {
          toolInfo?: string;
          stopReason: ProviderStopReason;
          text?: string;
          endTurn: boolean;
        },
  ): Promise<string | undefined> {
    if ('skipped' in execRes) {
      return FlowTransition.COMPLETE;
    }

    if (execRes.endTurn) {
      return FlowTransition.COMPLETE;
    }

    return undefined;
  }
}

class ToolUseDispatchNode<C> extends BaseNode<ToolUseCycleShared<C>> {
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseCycleShared<C>> {
    return shared;
  }

  async exec(
    context: ToolUseCycleShared<C>,
  ): Promise<
    | { skipped: true }
    | { parsed: any; name: string; input: any; toolCallId: string }
    | ToolDispatchErrorResult
  > {
    const { options, state } = context;
    if (state.shouldStop || !state.toolInfo) {
      return { skipped: true };
    }

    const groupId = options.logger.getActiveGroupId();

    const interrupted = Boolean(await options.checkInterruption());
    if (interrupted) {
      state.shouldStop = true;
      return { skipped: true };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(state.toolInfo);
    } catch (err) {
      const errorMsg = `Malformed tool JSON: ${toErrorMessage(err)}`;
      const errorResult = toolResult({ error: errorMsg, isError: true });
      const toolUseLog = {
        tool: 'unknown',
        input: state.toolInfo,
        output: sanitizeToolResultForLog(errorResult),
      };
      options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      return {
        handledError: true,
        toolName: 'unknown',
        result: errorResult,
        fallbackMessage:
          'I could not understand the tool request. Please resend valid JSON with call_id, name, and arguments.',
      };
    }

    let toolCallId: string;
    try {
      toolCallId = extractToolCallId(parsed);
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      const errorResult = toolResult({ error: errorMsg, isError: true });
      const toolUseLog = {
        tool: parsed.name || parsed.function?.name || 'unknown',
        input: parsed,
        output: sanitizeToolResultForLog(errorResult),
      };
      options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      return {
        handledError: true,
        toolName: parsed.name || parsed.function?.name || 'unknown',
        result: errorResult,
        parsed,
        fallbackMessage:
          'The tool call is missing a valid identifier. Please include a non-empty call_id for each tool request.',
      };
    }

    const name = parsed.name || parsed.function?.name;
    if (!name) {
      const errorMsg = `Tool JSON missing name: ${JSON.stringify(parsed)}`;
      const errorResult = toolResult({ error: errorMsg, isError: true });
      const toolUseLog = {
        tool: 'unknown',
        input: parsed,
        output: sanitizeToolResultForLog(errorResult),
      };
      options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      return {
        handledError: true,
        toolCallId,
        toolName: 'unknown',
        result: errorResult,
        parsed,
        fallbackMessage:
          'The tool request did not specify which tool to call. Please provide a "name" field with the tool identifier.',
      };
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

    return { parsed, name, input, toolCallId };
  }

  async post(
    _shared: ToolUseCycleShared<C>,
    prepRes: ToolUseCycleShared<C>,
    execRes:
      | { skipped: true }
      | { parsed: any; name: string; input: any; toolCallId: string }
      | ToolDispatchErrorResult,
  ): Promise<string | undefined> {
    const { options, state } = prepRes;
    const groupId = options.logger.getActiveGroupId();
    if ('skipped' in execRes) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    if ('handledError' in execRes) {
      const { toolCallId, result, fallbackMessage, toolName, parsed } = execRes;

      if (toolCallId) {
        const followUpMessages =
          await options.modelHandler.createToolUseFollowUpMessages(
            options.client,
            toolCallId,
            toolName,
            parsed,
            buildToolResultPayload(result),
            state.toolState,
            state.text ?? '',
          );

        state.messages.push(...followUpMessages);
        const fallback =
          result.summary ??
          result.output ??
          result.error ??
          fallbackMessage ??
          '';
        if (fallback) {
          state.toolState.updateLastResponse(String(fallback));
        }
      } else if (fallbackMessage) {
        const assistantMessage =
          options.modelHandler.createAssistantMessage(fallbackMessage);
        state.messages.push(assistantMessage);
        state.toolState.updateLastResponse(fallbackMessage);
      }

      state.iteration += 1;
      state.shouldStop = false;

      if (fallbackMessage) {
        options.logger.warn(fallbackMessage, groupId);
      }

      return FlowTransition.CONTINUE;
    }

    const tool = options.toolRegistry[execRes.name];
    let result: ToolResult;
    if (!tool) {
      result = toolResult({
        error: `Unknown tool ${execRes.name}`,
        isError: true,
      });
    } else {
      try {
        result = await tool.call(execRes.input);
      } catch (err) {
        const { message, diagnostics } = normalizeToolCallError(
          execRes.name,
          err,
        );
        result = toolResult({
          error: message,
          isError: true,
          diagnostics,
        });
      }
    }

    const toolUseLog = {
      tool: execRes.name,
      input: execRes.input ?? execRes.parsed,
      output: sanitizeToolResultForLog(result),
    };
    options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);

    if (result.files && result.files.length > 0) {
      const existing = state.toolState.mediaFiles;
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
          // Ignore errors when checking existence
        }
      }
      if (toAdd.length > 0) {
        state.toolState.addMediaFiles(toAdd);
      }
    }

    const followUpMsgs =
      await options.modelHandler.createToolUseFollowUpMessages(
        options.client,
        execRes.toolCallId,
        execRes.name,
        execRes.parsed,
        buildToolResultPayload(result),
        state.toolState,
        state.text ?? '',
      );

    state.messages.push(...followUpMsgs);
    state.iteration += 1;

    return FlowTransition.CONTINUE;
  }
}

export function createToolUseCycleFlow<C>(): Flow<ToolUseCycleShared<C>> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ToolUseCallNode<C>();
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);

  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleShared<C>>(prepNode);
}
