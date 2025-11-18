// Third-party imports
import { z } from 'zod';

// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import {
  BaseCycleState,
  resetCycleState,
  CycleDebugContext,
  CycleDebugFileOptions,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
// Internal imports
import { resolveUsageProvider } from '@agent/core/UsageProviderUtils';
// Type imports
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
// Type imports
import type { DebugObjectType } from '@agent/utils/debugMessageSaver';
// Internal imports
import { sanitizeToolResultForLog } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
// Type imports
import type { ToolDefinition } from '@model';
// Internal imports
import { ToolResult, toolResult } from '@tools/result';
import { withToolEditApprovalContext } from '@tools/approval/toolEditApprovalContext';
import { WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { FlowTransition } from './FlowTransitions';

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

interface NormalizedToolCall {
  callId: string;
  name: string;
  input: unknown;
  raw: RawToolCallPayload;
}

const RawToolCallPayloadSchema = z
  .object({
    call_id: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_use_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional(),
      })
      .optional(),
    input: z.unknown().optional(),
    args: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    arguments: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
  })
  .superRefine((value, ctx) => {
    const trimmed = (val?: string | null) =>
      typeof val === 'string' ? val.trim() : '';

    if (
      !trimmed(value.call_id) &&
      !trimmed(value.tool_call_id) &&
      !trimmed(value.tool_use_id) &&
      !trimmed(value.id)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['call_id'],
        message: 'Tool call is missing an identifier.',
      });
    }

    if (!trimmed(value.name) && !trimmed(value.function?.name ?? '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: 'Tool call is missing a name.',
      });
    }
  });

type RawToolCallPayload = z.infer<typeof RawToolCallPayloadSchema>;

const ToolCallPayloadSchema =
  RawToolCallPayloadSchema.transform<NormalizedToolCall>((payload) => {
    const trim = (value?: string | null) =>
      typeof value === 'string' ? value.trim() : '';

    const callId = [
      payload.call_id,
      payload.tool_call_id,
      payload.tool_use_id,
      payload.id,
    ]
      .map((candidate) => trim(candidate))
      .find((candidate) => candidate.length > 0);

    if (!callId) {
      throw new Error('Tool call is missing an identifier.');
    }

    const name = [payload.name, payload.function?.name]
      .map((candidate) => trim(candidate))
      .find((candidate) => candidate.length > 0);

    if (!name) {
      throw new Error('Tool call is missing a name.');
    }

    const argumentSources: Array<unknown> = [
      payload.input,
      payload.args,
      payload.arguments,
      payload.function?.arguments,
    ];

    let input: unknown = {};
    for (const candidate of argumentSources) {
      if (candidate === undefined || candidate === null) {
        continue;
      }
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (!trimmed) {
          continue;
        }
        try {
          input = JSON.parse(trimmed);
        } catch {
          input = trimmed;
        }
        break;
      }
      input = candidate;
      break;
    }

    return {
      callId,
      name,
      input,
      raw: payload,
    };
  });

function normalizeToolCallError(
  toolName: string,
  error: unknown,
): { message: string; diagnostics?: ToolValidationDiagnostics } {
  if (error && typeof error === 'object' && 'issues' in error) {
    const zodError = error as { issues?: any[] };
    const issues = Array.isArray(zodError.issues) ? zodError.issues : [];
    return {
      message: `${toolName}: Invalid parameters provided`,
      diagnostics: {
        type: 'validation_error',
        issues,
        formatted: issues.map((issue) => ({
          path: Array.isArray(issue.path) ? issue.path.join('.') : '',
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

type ToolDispatchErrorResult = {
  handledError: true;
  toolCallId?: string;
  toolName: string;
  result: ToolResult;
  raw?: unknown;
  fallbackMessage?: string;
};

export interface ToolUseCycleState extends BaseCycleState {
  response?: unknown;
  toolInfo?: string;
  text?: string;
}

function resetToolUseState(state: ToolUseCycleState): void {
  resetCycleState(state, ['response', 'toolInfo', 'text']);
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  state: ToolUseCycleState;
  store: AgentSharedStore;
}

class ToolUsePrepNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<{
    interrupted: boolean;
    debugContext: CycleDebugContext;
    debugFileOptions: CycleDebugFileOptions;
  }> {
    const { options, state, store } = shared;
    const interrupted = Boolean(await options.checkInterruption());
    const debugContext: CycleDebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.context.executionId,
    };
    const debugFileOptions: CycleDebugFileOptions = {
      continuationCount: store.round.roundIndex,
      baseName: 'tooluse',
    };
    return { interrupted, debugContext, debugFileOptions };
  }

  async post(
    { state }: ToolUseCycleContext<C>,
    prepRes: {
      interrupted: boolean;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    },
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    // Reset at the start of each cycle so downstream nodes observe a clean
    // runtime state before enriching it with model responses.
    resetToolUseState(state);

    await maybeSaveDebugObject({
      context: prepRes.debugContext,
      fileOptions: prepRes.debugFileOptions,
      object: state.messages,
      objectType: 'messages',
    });

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
  if (result.userInstruction !== undefined)
    payload.userInstruction = result.userInstruction;
  if (result.userPatch !== undefined) payload.userPatch = result.userPatch;
  if (result.isError) payload.isError = true;
  if (result.diagnostics !== undefined)
    payload.diagnostics = result.diagnostics;
  if (result.files !== undefined) payload.files = result.files;
  return payload;
}

class ToolUseCallNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<ToolUseCycleContext<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleContext<C>): Promise<
    SkippableNodeResult<{
      response: unknown;
      responseTime?: number;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    }>
  > {
    const { options, state, store } = context;
    if (state.shouldStop) {
      return { skipped: true };
    }

    const debugContext: CycleDebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.context.executionId,
    };
    const debugFileOptions: CycleDebugFileOptions = {
      continuationCount: store.round.roundIndex,
      baseName: 'tooluse_response',
    };

    const abortController = new AbortController();
    options.setAbortController(abortController);

    let response: unknown;
    const start = Date.now();
    try {
      options.modelHandler.setOutputStreaming(true);
      response = await options.modelHandler.createResponse({
        client: options.client,
        messages: state.messages,
        temperature: options.agentSetting.temperature ?? 0,
        signal: abortController.signal,
        tools: options.agentSetting.tools as ToolDefinition[] | undefined,
      });
    } finally {
      options.setAbortController(null);
    }

    const responseTime = (Date.now() - start) / 1000;

    return {
      skipped: false,
      value: { response, responseTime, debugContext, debugFileOptions },
    };
  }

  async post(
    _shared: ToolUseCycleContext<C>,
    prepRes: ToolUseCycleContext<C>,
    execRes: SkippableNodeResult<{
      response: unknown;
      responseTime?: number;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    }>,
  ): Promise<string | undefined> {
    const { options, state } = prepRes;

    if (execRes.skipped) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { response, responseTime, debugContext, debugFileOptions } =
      execRes.value;

    state.response = response;
    state.responseTime = responseTime;

    await maybeSaveDebugObject({
      context: debugContext,
      fileOptions: debugFileOptions,
      object: response,
      objectType: 'response',
    });

    if (!response) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    return undefined;
  }
}

class ToolUseProcessNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<ToolUseCycleContext<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleContext<C>): Promise<
    SkippableNodeResult<{
      toolInfo?: string;
      stopReason: ProviderStopReason;
      text?: string;
      endTurn: boolean;
    }>
  > {
    const { options, state, store } = context;
    if (state.shouldStop || !state.response) {
      return { skipped: true };
    }

    const groupId = options.logger.withCurrentGroup((id) => id);

    const hadThinking = Boolean(store.workspace?.reasoning.thinkingAdded);
    const thinking = options.modelHandler.processThinkingBlock(
      state.response,
      store.workspace,
    );
    const useStreaming = options.modelHandler.getStreamingConfig();
    if (thinking && !useStreaming && !hadThinking) {
      const formatted = await xmlUtils.formatContent(thinking);
      if (formatted.trim().length > 0) {
        options.logger.info(formatted, groupId, MESSAGE_TYPES.THINKING);
      }
    }

    const toolInfo = options.modelHandler.extractToolUse(state.response);
    const {
      response: text,
      usage,
      stopReason,
    } = options.modelHandler.extractResponse(state.response, '');

    if (text) {
      options.logger.debug(`Model response: ${text.slice(0, 100)}`, groupId);
      if (!useStreaming) {
        const formatted = await xmlUtils.formatContent(text);
        options.logger.info(formatted, groupId, MESSAGE_TYPES.MODEL_RESPONSE);
      }
    }

    if (state.responseTime !== undefined) {
      store.round.addResponseTime(state.responseTime);
    }

    if (usage) {
      const provider = resolveUsageProvider(options.modelHandler);
      const summary = options.modelHandler.computeResponseUsage(
        usage,
        state.responseTime ?? 0,
      );
      store.round.setUsage({
        summary,
        nativeUsage: usage,
        provider,
      });
    } else {
      store.round.clearUsage();
    }

    const endTurn = options.modelHandler.isEndTurnStop(stopReason);

    if (!toolInfo || endTurn) {
      if (text) {
        state.messages.push(options.modelHandler.createAssistantMessage(text));
        store.workspace.assembly.updateLastResponse(text);
      }
      state.shouldStop = true;
      return {
        skipped: false,
        value: { stopReason, text, endTurn: true },
      };
    }

    state.toolInfo = toolInfo;
    state.text = text ?? undefined;
    state.stopReason = stopReason;

    return {
      skipped: false,
      value: { toolInfo, stopReason, text: text ?? undefined, endTurn: false },
    };
  }

  async post(
    shared: ToolUseCycleContext<C>,
    _prepRes: unknown,
    execRes: SkippableNodeResult<{
      toolInfo?: string;
      stopReason: ProviderStopReason;
      text?: string;
      endTurn: boolean;
    }>,
  ): Promise<string | undefined> {
    const { options, state, store } = shared;

    if (execRes.skipped) {
      store.round.clearUsage();
      return FlowTransition.COMPLETE;
    }

    const completedRound = store.round;
    await store.finalizeRound();
    store.run.incrementRounds();

    const nextRoundIndex = completedRound.roundIndex + 1;

    if (execRes.value.endTurn) {
      state.shouldStop = true;
      state.stopReason = execRes.value.stopReason;
      store.resetRound(nextRoundIndex);
      return FlowTransition.COMPLETE;
    }

    store.resetRound(nextRoundIndex);
    return undefined;
  }
}

class ToolUseDispatchNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<ToolUseCycleContext<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleContext<C>): Promise<
    SkippableNodeResult<
      | {
          raw: RawToolCallPayload;
          name: string;
          input: unknown;
          toolCallId: string;
        }
      | ToolDispatchErrorResult
    >
  > {
    const { options, state, store } = context;
    if (state.shouldStop || !state.toolInfo) {
      return { skipped: true };
    }

    const groupId = options.logger.withCurrentGroup((id) => id);

    if (await options.checkInterruption()) {
      state.shouldStop = true;
      return { skipped: true };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(state.toolInfo);
    } catch (error) {
      const errorMsg = `Malformed tool JSON: ${toErrorMessage(error)}`;
      const errorResult = toolResult({ error: errorMsg, isError: true });
      const toolUseLog = {
        tool: 'unknown',
        input: state.toolInfo,
        output: sanitizeToolResultForLog(errorResult),
      };
      options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      return {
        skipped: false,
        value: {
          handledError: true,
          toolName: 'unknown',
          result: errorResult,
          fallbackMessage:
            'I could not understand the tool request. Please resend valid JSON with call_id, name, and arguments.',
        },
      };
    }

    const parsed = ToolCallPayloadSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const { message, diagnostics } = normalizeToolCallError(
        'unknown',
        parsed.error,
      );
      const errorResult = toolResult({
        error: message,
        isError: true,
        diagnostics,
      });
      const toolUseLog = {
        tool: 'unknown',
        input: parsedJson,
        output: sanitizeToolResultForLog(errorResult),
      };
      options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);
      return {
        skipped: false,
        value: {
          handledError: true,
          toolName: 'unknown',
          result: errorResult,
          raw: parsedJson,
          fallbackMessage: message,
        },
      };
    }

    const payload = parsed.data;
    return {
      skipped: false,
      value: {
        raw: payload.raw,
        name: payload.name,
        input: payload.input,
        toolCallId: payload.callId,
      },
    };
  }

  async post(
    _shared: ToolUseCycleContext<C>,
    prepRes: ToolUseCycleContext<C>,
    execRes: SkippableNodeResult<
      | {
          raw: RawToolCallPayload;
          name: string;
          input: unknown;
          toolCallId: string;
        }
      | ToolDispatchErrorResult
    >,
  ): Promise<string | undefined> {
    const { options, state, store } = prepRes;
    const groupId = options.logger.withCurrentGroup((id) => id);
    if (execRes.skipped) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    if ('handledError' in execRes.value) {
      const { toolCallId, result, fallbackMessage, toolName, raw } =
        execRes.value;
      const workspace = store.workspace;

      if (toolCallId) {
        const followUpMessages =
          await options.modelHandler.createToolUseFollowUpMessages(
            options.client,
            toolCallId,
            toolName,
            raw,
            buildToolResultPayload(result),
            workspace,
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
          workspace.assembly.updateLastResponse(String(fallback));
        }
      } else if (fallbackMessage) {
        const assistantMessage =
          options.modelHandler.createAssistantMessage(fallbackMessage);
        state.messages.push(assistantMessage);
        workspace.assembly.updateLastResponse(fallbackMessage);
      }

      state.shouldStop = false;

      if (fallbackMessage) {
        options.logger.warn(fallbackMessage, groupId);
      }

      return FlowTransition.CONTINUE;
    }

    const normalResult = execRes.value;
    const tool = options.toolRegistry[normalResult.name];
    let result: ToolResult;
    if (!tool) {
      result = toolResult({
        error: `Unknown tool ${normalResult.name}`,
        isError: true,
      });
    } else {
      try {
        result = await withToolEditApprovalContext(
          {
            streamId: options.logger.channelId,
            executionId: options.context.executionId,
            toolCallId: normalResult.toolCallId,
          },
          () => tool.call(normalResult.input),
        );
      } catch (err) {
        const { message, diagnostics } = normalizeToolCallError(
          normalResult.name,
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
      tool: normalResult.name,
      input: normalResult.input ?? normalResult.raw,
      output: sanitizeToolResultForLog(result),
    };
    options.logger.info('', groupId, MESSAGE_TYPES.TOOL_USE, toolUseLog);

    if (result.files && result.files.length > 0) {
      const existing = store.workspace.media.files;
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
        store.workspace.media.addMediaFiles(toAdd);
      }
    }

    const followUpMsgs =
      await options.modelHandler.createToolUseFollowUpMessages(
        options.client,
        normalResult.toolCallId,
        normalResult.name,
        normalResult.raw,
        buildToolResultPayload(result),
        store.workspace,
        state.text ?? '',
      );

    state.messages.push(...followUpMsgs);
    if (
      typeof result.userInstruction === 'string' &&
      result.userInstruction.trim().length > 0
    ) {
      await options.modelHandler.createUserFollowUpMessages(
        state.messages,
        result.userInstruction,
      );
    }

    return FlowTransition.CONTINUE;
  }
}
export function createToolUseCycleFlow<C>(): Flow<ToolUseCycleContext<C>> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ToolUseCallNode<C>();
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);

  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleContext<C>>(prepNode);
}
