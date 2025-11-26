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
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
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

function summarizeLineChanges(
  edits:
    | { path?: string; lineChanges?: { added?: number; removed?: number } }[]
    | undefined,
): { added: number; removed: number } | undefined {
  if (!Array.isArray(edits)) {
    return undefined;
  }

  let added = 0;
  let removed = 0;

  for (const edit of edits) {
    added += edit?.lineChanges?.added ?? 0;
    removed += edit?.lineChanges?.removed ?? 0;
  }

  return added || removed ? { added, removed } : undefined;
}

function buildToolResultPayload(
  result: ToolResult,
  fallbackLineChanges?: { added: number; removed: number },
): Record<string, unknown> {
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
  const lineChanges = result.lineChanges ?? fallbackLineChanges;
  if (lineChanges !== undefined) payload.lineChanges = lineChanges;
  if (result.edits !== undefined) payload.edits = result.edits;
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
    const tracker = store.workspace.interactions;

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
          result = await withToolFileInteractionContext(
            {
              tracker,
              streamId: options.logger.channelId,
              executionId: options.context.executionId,
              toolCallId: call.callId,
            },
            () =>
              withToolEditApprovalContext(
                {
                  streamId: options.logger.channelId,
                  executionId: options.context.executionId,
                  toolCallId: call.callId,
                },
                () => tool.call(parsedInput),
              ),
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

      const trackedEdits = tracker.recordEdits(result.edits);
      const fallbackLineChanges =
        trackedEdits.lineChanges ?? summarizeLineChanges(trackedEdits.edits);
      const lineChanges = result.lineChanges ?? fallbackLineChanges;
      const sanitizedOutput = sanitizeToolResultForLog(result);
      if (lineChanges) {
        sanitizedOutput.lineChanges = lineChanges;
      }
      const editedFiles = trackedEdits.edits.map((entry) => ({
        path: entry.path,
        ok: true,
        source: 'tool',
        sourceDisplay: 'Tool use',
      }));

      if (editedFiles.length > 0) {
        sanitizedOutput.files = editedFiles;
      }

      const toolUseLog = {
        toolName: call.name,
        input: parsedInput ?? call.raw,
        output: sanitizedOutput,
        files: editedFiles,
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
          buildToolResultPayload(result, lineChanges),
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
