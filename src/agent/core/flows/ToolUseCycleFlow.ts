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
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
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
// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';
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
import {
  type RetryState,
  type RetryCallbacks,
  clearRetryError,
  resetRetryState,
  recordRetryError,
  shouldAutoRetry,
  shouldOfferManualRetry,
  computeBackoffDelay,
} from './RetryState';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import { sleep } from '@utils/helpers';
import { bus } from '@eventBus/ProgressEventBus';
import {
  registerManualRetry,
  clearManualRetry,
} from '@agent/runtime/ManualRetryController';

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

function parseToolInput(
  raw: unknown,
  callId: string,
  logger: AgentLogger,
): unknown {
  if (raw === null) {
    logger.warn(`Tool call ${callId}: Received null input, using empty object`);
    return {};
  }

  if (typeof raw === 'boolean' || typeof raw === 'number') {
    logger.warn(
      `Tool call ${callId}: Received primitive input (${String(raw)}), passing through`,
    );
    return raw;
  }

  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.warn(
      `Tool call ${callId}: Failed to parse input as JSON, using raw string`,
      { data: error },
    );
    return raw;
  }
}

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
  toolCalls?: SdkToolCall[];
  text?: string;
}

function resetToolUseState(state: ToolUseCycleState): void {
  resetCycleState(state, []);
  state.response = undefined;
  state.toolCalls = undefined;
  state.text = undefined;
}

export interface ToolUseCycleContext<C = unknown> {
  options: ToolUseCycleOptions<C>;
  state: ToolUseCycleState;
  store: AgentSharedStore;
  /** Retry state for model invocation errors. */
  retryState: RetryState;
  /** Callbacks for manual retry control from UI. */
  retryCallbacks: RetryCallbacks;
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
      isRemote: options.agentName
        ? RemoteAgentRegistry.isRemote(options.agentName)
        : false,
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

/**
 * Result type for tool-use call that captures both success and error cases.
 */
type ToolUseCallResult =
  | {
      success: true;
      response: unknown;
      responseTime?: number;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    }
  | { success: false; error: unknown };

/**
 * Handles model invocation for tool-use cycles with integrated retry support.
 */
class ToolUseCallNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<ToolUseCycleContext<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleContext<C>): Promise<ToolUseCallResult> {
    const { options, state, store, retryState } = context;
    if (state.shouldStop) {
      return {
        success: true,
        response: undefined,
        debugContext: {} as CycleDebugContext,
        debugFileOptions: {} as CycleDebugFileOptions,
      };
    }

    // Increment attempt counter
    retryState.attemptCount++;

    const debugContext: CycleDebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.context.executionId,
      isRemote: options.agentName
        ? RemoteAgentRegistry.isRemote(options.agentName)
        : false,
    };
    const debugFileOptions: CycleDebugFileOptions = {
      continuationCount: store.round.roundIndex,
      baseName: 'tooluse_response',
    };

    const abortController = new AbortController();
    options.setAbortController(abortController);

    const start = Date.now();
    try {
      options.modelHandler.setOutputStreaming(true);
      const response = await options.modelHandler.createResponse({
        client: options.client,
        messages: state.messages,
        temperature: options.agentSetting.temperature ?? 0,
        signal: abortController.signal,
        tools: options.agentSetting.tools as ToolDefinition[] | undefined,
      });

      const responseTime = (Date.now() - start) / 1000;

      return {
        success: true,
        response,
        responseTime,
        debugContext,
        debugFileOptions,
      };
    } catch (error) {
      return { success: false, error };
    } finally {
      options.setAbortController(null);
    }
  }

  async post(
    shared: ToolUseCycleContext<C>,
    prepRes: ToolUseCycleContext<C>,
    execRes: ToolUseCallResult,
  ): Promise<string | undefined> {
    const { options, state, retryState } = shared;

    // Handle successful invocation
    if (execRes.success) {
      clearRetryError(retryState);

      if (!execRes.response) {
        state.shouldStop = true;
        return FlowTransition.COMPLETE;
      }

      state.response = execRes.response;
      state.responseTime = execRes.responseTime;

      await maybeSaveDebugObject({
        context: execRes.debugContext,
        fileOptions: execRes.debugFileOptions,
        object: execRes.response,
        objectType: 'response',
      });

      return undefined; // Continue to process node
    }

    // Handle error - determine retry strategy
    const formatted = formatProviderHttpError(execRes.error);
    recordRetryError(retryState, formatted.message, formatted.statusCode);

    // Auto-retry available?
    if (shouldAutoRetry(retryState)) {
      const delay = computeBackoffDelay(retryState);
      options.logger.warn(
        `Retrying tool-use call after ${delay}ms (attempt ${retryState.attemptCount}/${retryState.maxAutoAttempts}): ${formatted.message}`,
        {
          messageType: MESSAGE_TYPES.PROGRESS_STATUS,
          data: {
            attempt: retryState.attemptCount,
            maxAttempts: retryState.maxAutoAttempts,
            statusCode: formatted.statusCode,
          },
        },
      );
      await sleep(delay);
      return FlowTransition.RETRY;
    }

    // Manual retry available?
    if (shouldOfferManualRetry(retryState)) {
      retryState.awaitingManualRetry = true;
      options.logger.error(`Tool-use call failed: ${formatted.message}`, {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: { statusCode: formatted.statusCode, retryable: true },
      });
      return FlowTransition.AWAIT_RETRY;
    }

    // Non-retryable error
    options.logger.error(
      `Tool-use call failed (not retryable): ${formatted.message}`,
      {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: { statusCode: formatted.statusCode, retryable: false },
      },
    );
    state.shouldStop = true;
    return FlowTransition.COMPLETE;
  }
}

class ToolUseProcessNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<ToolUseCycleContext<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleContext<C>): Promise<
    SkippableNodeResult<{
      toolCalls?: SdkToolCall[];
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

    const thinking = options.modelHandler.processThinkingBlock(
      state.response,
      store.workspace,
    );
    const useStreaming = options.modelHandler.getStreamingConfig();
    if (thinking && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinking);
      if (formatted.trim().length > 0) {
        options.logger.info(formatted, {
          groupId,
          messageType: MESSAGE_TYPES.THINKING,
        });
      }
    }

    const toolCalls = options.modelHandler.extractToolUse(state.response);
    const {
      response: text,
      usage,
      stopReason,
    } = options.modelHandler.extractResponse(state.response, '');

    if (text) {
      options.logger.debug(`Model response: ${text.slice(0, 100)}`, {
        groupId,
      });
      if (!useStreaming) {
        const formatted = await xmlUtils.formatContent(text);
        options.logger.info(formatted, {
          groupId,
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        });
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

    if (!toolCalls || toolCalls.length === 0 || endTurn) {
      state.toolCalls = undefined;
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

    state.toolCalls = toolCalls;
    state.text = text ?? undefined;
    state.stopReason = stopReason;

    return {
      skipped: false,
      value: {
        toolCalls,
        stopReason,
        text: text ?? undefined,
        endTurn: false,
      },
    };
  }

  async post(
    shared: ToolUseCycleContext<C>,
    _prepRes: unknown,
    execRes: SkippableNodeResult<{
      toolCalls?: SdkToolCall[];
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

  async exec(
    context: ToolUseCycleContext<C>,
  ): Promise<SkippableNodeResult<{ calls: SdkToolCall[] }>> {
    const { options, state, store } = context;
    if (state.shouldStop || !state.toolCalls || state.toolCalls.length === 0) {
      return { skipped: true };
    }

    const groupId = options.logger.withCurrentGroup((id) => id);

    if (await options.checkInterruption()) {
      state.shouldStop = true;
      return { skipped: true };
    }

    return {
      skipped: false,
      value: { calls: state.toolCalls },
    };
  }

  async post(
    _shared: ToolUseCycleContext<C>,
    prepRes: ToolUseCycleContext<C>,
    execRes: SkippableNodeResult<{ calls: SdkToolCall[] }>,
  ): Promise<string | undefined> {
    const { options, state, store } = prepRes;
    const groupId = options.logger.withCurrentGroup((id) => id);
    if (execRes.skipped) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { calls } = execRes.value;

    const assistantText = state.text ?? '';

    for (const [index, call] of calls.entries()) {
      const tool = options.toolRegistry[call.name];
      let result: ToolResult;
      const parsedInput = parseToolInput(
        call.input,
        call.callId,
        options.logger,
      );
      if (!tool) {
        result = toolResult({
          error: `Unknown tool ${call.name}`,
          isError: true,
        });
      } else {
        try {
          result = await withToolEditApprovalContext(
            {
              streamId: options.logger.channelId,
              executionId: options.context.executionId,
              toolCallId: call.callId,
            },
            () => tool.call(parsedInput),
          );
        } catch (err) {
          const { message, diagnostics } = normalizeToolCallError(
            call.name,
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
        toolName: call.name,
        input: parsedInput ?? call.raw,
        output: sanitizeToolResultForLog(result),
        isError: Boolean(result.isError),
      };
      options.logger.info('', {
        groupId,
        messageType: MESSAGE_TYPES.TOOL_USE,
        data: toolUseLog,
      });

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
          call,
          buildToolResultPayload(result),
          store.workspace,
          index === 0 && assistantText.length > 0 ? assistantText : undefined,
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
    }

    state.toolCalls = [];

    return FlowTransition.CONTINUE;
  }
}
/**
 * Specialized retry wait node for tool-use cycle.
 * Handles manual retry by waiting for UI callback.
 */
class ToolUseRetryWaitNode<C> extends BaseNode<ToolUseCycleContext<C>> {
  async prep(shared: ToolUseCycleContext<C>): Promise<ToolUseCycleContext<C>> {
    return shared;
  }

  async exec(context: ToolUseCycleContext<C>): Promise<'retry' | 'cancel'> {
    const { retryState, options, retryCallbacks } = context;
    const streamId = options.context.streamId;

    // Log waiting status
    options.logger.info('Waiting for manual retry', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: { error: retryState.lastError, awaitingManualRetry: true },
    });

    // Emit waiting status to UI
    bus.emit('updateStreamStatus', { stream: streamId, status: 'waiting' });

    // Wait for external signal via callbacks
    return new Promise<'retry' | 'cancel'>((resolve) => {
      retryCallbacks.triggerRetry = () => {
        clearManualRetry(streamId);
        retryCallbacks.triggerRetry = undefined;
        retryCallbacks.cancelRetry = undefined;
        resolve('retry');
      };
      retryCallbacks.cancelRetry = () => {
        clearManualRetry(streamId);
        retryCallbacks.triggerRetry = undefined;
        retryCallbacks.cancelRetry = undefined;
        resolve('cancel');
      };

      // Register with ManualRetryController for UI-triggered retries
      registerManualRetry(streamId, {
        run: async () => retryCallbacks.triggerRetry?.(),
        logger: options.logger,
        operation: 'Tool-use call',
      });
    });
  }

  async post(
    shared: ToolUseCycleContext<C>,
    _prepRes: ToolUseCycleContext<C>,
    execRes: 'retry' | 'cancel',
  ): Promise<string | undefined> {
    const { retryState, options, state } = shared;
    const streamId = options.context.streamId;

    if (execRes === 'retry') {
      resetRetryState(retryState);
      options.logger.info('Manual retry triggered', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      bus.emit('updateStreamStatus', { stream: streamId, status: 'resuming' });
      return FlowTransition.RETRY;
    }

    // User cancelled
    options.logger.info('Retry cancelled by user', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });
    bus.emit('updateStreamStatus', { stream: streamId, status: 'stopped' });
    state.shouldStop = true;
    return FlowTransition.COMPLETE;
  }
}

export function createToolUseCycleFlow<C>(): Flow<ToolUseCycleContext<C>> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ToolUseCallNode<C>();
  const retryWaitNode = new ToolUseRetryWaitNode<C>();
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  // Main flow: prep → call → process → dispatch
  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);

  // Retry transitions from call node:
  // - RETRY: Loop back to call for auto-retry
  // - AWAIT_RETRY: Go to retry wait node for manual retry
  callNode.on(FlowTransition.RETRY, callNode);
  callNode.on(FlowTransition.AWAIT_RETRY, retryWaitNode);

  // Retry wait node transitions:
  // - RETRY: Loop back to call node after user triggers retry
  // - COMPLETE: Exit flow if user cancels
  retryWaitNode.on(FlowTransition.RETRY, callNode);

  // Dispatch can loop back to prep for next tool cycle
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleContext<C>>(prepNode);
}
