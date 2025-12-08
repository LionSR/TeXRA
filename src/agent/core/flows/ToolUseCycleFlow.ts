// Third-party imports (none needed)

// Local imports - core flow primitives
import { BaseNode, Node, Flow } from '@agent/node';
import { isRemoteAgent } from '@agent/index';
import {
  BaseCycleState,
  resetCycleState,
  CycleDebugContext,
  CycleDebugFileOptions,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';

// Internal imports - use core ToolTypes as single source of truth
import {
  extractToolAttachments,
  type ExtractedToolAttachments,
} from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type { FileInteractionState } from '@agent/core/AgentWorkspaceState';
import type { ToolResult } from '@agent/core/ToolTypes';
import { toolResult } from '@agent/core/ToolTypes';
import {
  formatProviderHttpError,
  extractErrorContext,
} from '@common/errors/sdkErrorUtils';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
// Type imports
import type { ToolDefinition } from '@model';
import { withToolEditApprovalContext } from '@tools/approval/toolEditApprovalContext';
import { WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type RetryState,
  type FallbackResult,
  clearRetryError,
  getNodeRetryConfig,
  determineFallbackAction,
  applyFallbackResult,
} from './RetryState';
import { createRetryWaitNode } from './BaseRetryWaitNode';
import type {
  ToolUseCycleOptions,
  ToolUseCycleServices,
  ToolUseCycleParams,
} from './CycleServices';

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

/**
 * Shared state for tool-use cycle flows.
 *
 * This contains only MUTABLE state that flows through nodes.
 * Services (options, store) are accessed via `_params.services`.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface)
 * - Immutable services: `_params.services` (ToolUseCycleServices)
 */
export interface ToolUseCycleShared<_C = unknown> {
  /** Runtime state for this cycle */
  state: ToolUseCycleState;
  /** Retry state for model invocation errors */
  retryState: RetryState;
}

/**
 * Prepares a tool-use cycle by checking interruptions and setting up debug context.
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUsePrepNode<C> extends BaseNode<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  async prep(_shared: ToolUseCycleShared<C>): Promise<{
    interrupted: boolean;
    debugContext: CycleDebugContext;
    debugFileOptions: CycleDebugFileOptions;
  }> {
    const { options, store } = this._params.services;
    const interrupted = Boolean(await options.checkInterruption());
    const debugContext: CycleDebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.context.executionId,
      isRemote: isRemoteAgent(options.agentName),
    };
    const debugFileOptions: CycleDebugFileOptions = {
      continuationCount: store.round.roundIndex,
      baseName: 'tooluse',
    };
    return { interrupted, debugContext, debugFileOptions };
  }

  async post(
    shared: ToolUseCycleShared<C>,
    prepRes: {
      interrupted: boolean;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    },
  ): Promise<string | undefined> {
    const { state } = shared;

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

/**
 * Data extracted by prep() for tool-use call.
 * This is the ONLY data exec() should use (PocketFlow compliance).
 *
 * Note: Services (modelHandler, client, etc.) are accessed via this._params.services,
 * which is the correct PocketFlow pattern for immutable configuration.
 */
interface ToolUseCallPrepResult {
  shouldStop: boolean;
  messages: import('@agent/modelHandlers/types/ProviderMessage').ProviderMessage[];
}

/**
 * Result type for tool-use call.
 * - Success: Contains response from model
 * - Fallback: From execFallback when all auto-retries exhausted
 * - Skipped: When shouldStop is true
 */
type ToolUseCallResult =
  | {
      kind: 'success';
      response: unknown;
      responseTime?: number;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    }
  | { kind: 'fallback'; result: FallbackResult }
  | { kind: 'skipped' };

/**
 * Handles model invocation for tool-use cycles with PocketFlow's built-in retry.
 *
 * Uses PocketFlow Node for auto-retry:
 * - maxRetries and wait configured from user settings
 * - exec() throws on error, Node retries automatically
 * - execFallback() called when all auto-retries exhausted
 *
 * Flow transitions:
 * - AWAIT_RETRY: Manual retry (goes to RetryWaitNode)
 * - default: Continue to next node on success
 * - COMPLETE: Non-retryable error or user abort
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUseCallNode<C> extends Node<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  constructor() {
    const config = getNodeRetryConfig();
    super(config.maxRetries, config.wait);
  }

  /**
   * Extract data from shared for exec().
   * PocketFlow compliance: exec() should only use prepRes, not shared.
   */
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseCallPrepResult> {
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      messages: state.messages,
    };
  }

  /**
   * Read fresh retry config before starting the retry loop.
   *
   * This enables config changes to take effect without rebuilding the flow.
   * Config is read once at the start of _exec(), before any retries begin,
   * so the same config applies to all retry attempts within a single execution.
   *
   * Note: PocketFlow flows are single-threaded per request, so concurrent
   * mutation is not a concern here.
   */
  async _exec(prepRes: unknown): Promise<unknown> {
    const config = getNodeRetryConfig();
    this.maxRetries = config.maxRetries;
    this.wait = config.wait;
    return super._exec(prepRes);
  }

  async exec(prepRes: ToolUseCallPrepResult): Promise<ToolUseCallResult> {
    const { options, store } = this._params.services;

    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    const debugContext: CycleDebugContext = {
      logger: options.logger,
      modelName: options.modelName,
      executionId: options.context.executionId,
      isRemote: isRemoteAgent(options.agentName),
    };
    const debugFileOptions: CycleDebugFileOptions = {
      continuationCount: store.round.roundIndex,
      baseName: 'tooluse_response',
    };

    const abortController = new AbortController();
    // Set signal on Node so retry loop can detect user cancellation
    this.signal = abortController.signal;
    options.setAbortController(abortController);

    const start = Date.now();
    try {
      options.modelHandler.setOutputStreaming(true);
      const response = await options.modelHandler.createResponse({
        client: options.client,
        messages: prepRes.messages,
        temperature: options.agentSetting.temperature ?? 0,
        signal: abortController.signal,
        tools: options.agentSetting.tools as ToolDefinition[] | undefined,
      });

      const responseTime = (Date.now() - start) / 1000;

      return {
        kind: 'success',
        response,
        responseTime,
        debugContext,
        debugFileOptions,
      };
    } finally {
      options.setAbortController(null);
    }
    // Note: Errors from createResponse() are caught by PocketFlow Node's
    // retry loop in _exec(), which calls execFallback() when exhausted.
  }

  /**
   * Called by PocketFlow Node when all auto-retries are exhausted.
   * Determines whether to offer manual retry or fail.
   */
  async execFallback(
    _prepRes: ToolUseCallPrepResult,
    error: Error,
  ): Promise<ToolUseCallResult> {
    const formatted = formatProviderHttpError(error);
    // Extract enriched context attached by requestExecutor (operation name, model)
    const context = extractErrorContext(error);
    const fallbackResult = determineFallbackAction(
      formatted.retryable,
      formatted.message,
      formatted.statusCode,
      context,
    );
    return { kind: 'fallback', result: fallbackResult };
  }

  async post(
    shared: ToolUseCycleShared<C>,
    _prepRes: ToolUseCallPrepResult,
    execRes: ToolUseCallResult,
  ): Promise<string | undefined> {
    const { options } = this._params.services;
    const { state, retryState } = shared;

    // Handle skipped (shouldStop was true before invocation)
    if (execRes.kind === 'skipped') {
      options.logger.debug(
        'Tool-use call skipped: shouldStop was already true',
      );
      return FlowTransition.COMPLETE;
    }

    // Handle fallback (all auto-retries exhausted)
    if (execRes.kind === 'fallback') {
      const transition = applyFallbackResult(
        execRes.result,
        retryState,
        options.logger,
        'Tool-use call',
      );

      // Set state flags on failure
      if (execRes.result.outcome === 'fail') {
        state.shouldStop = true;
      }

      return transition;
    }

    // Handle success
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
}

/**
 * Processes the model response to extract tool calls and usage data.
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUseProcessNode<C> extends BaseNode<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseCycleShared<C>> {
    return shared;
  }

  async exec(shared: ToolUseCycleShared<C>): Promise<
    SkippableNodeResult<{
      toolCalls?: SdkToolCall[];
      stopReason: ProviderStopReason;
      text?: string;
      endTurn: boolean;
    }>
  > {
    const { options, store } = this._params.services;
    const { state } = shared;
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

    // Single extraction for all server tool data (single source of truth)
    const serverToolData = options.modelHandler.extractServerToolData(
      state.response,
    );

    // Log web search results to progress view
    // Skip when streaming - Anthropic handler emits during streaming for correct order
    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        options.logger.info('', {
          groupId,
          messageType: MESSAGE_TYPES.WEB_SEARCH,
          data: searchResult,
        });
      }
    }

    // Cache content blocks for use in follow-up messages
    // Always assign to clear stale blocks from previous responses
    store.workspace.serverToolContent.contentBlocks =
      serverToolData.contentBlocks;

    // Store full assistant content (excluding tool_use) to preserve original order
    // This is used in createToolUseFollowUpMessages for correct message building
    // Works with Anthropic-style responses that have a content array
    const responseContent = (state.response as { content?: unknown[] })?.content;
    store.workspace.serverToolContent.lastAssistantContent = Array.isArray(
      responseContent,
    )
      ? responseContent.filter((block) => {
          const typed = block as { type?: string } | null | undefined;
          return typed?.type !== 'tool_use';
        })
      : [];

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
      // Normalize usage once - this is the single source of truth
      const normalizedUsage = options.modelHandler.normalizeUsage(
        usage,
        state.responseTime ?? 0,
      );
      store.round.setNormalizedUsage(normalizedUsage);
    } else {
      store.round.clearUsage();
    }

    const endTurn = options.modelHandler.isEndTurnStop(stopReason);

    if (!toolCalls || toolCalls.length === 0 || endTurn) {
      state.toolCalls = undefined;
      // End turn - just preserve text. Server tool content (web_search) was already
      // logged to progress view and is not needed in message history when stopping.
      if (text) {
        state.messages.push(options.modelHandler.createAssistantMessage(text));
        store.workspace.assembly.updateLastResponse(text);
      }
      // Clear ephemeral state so stale data isn't used in subsequent requests
      store.workspace.resetServerToolContent();
      store.workspace.resetReasoning();
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
    shared: ToolUseCycleShared<C>,
    _prepRes: unknown,
    execRes: SkippableNodeResult<{
      toolCalls?: SdkToolCall[];
      stopReason: ProviderStopReason;
      text?: string;
      endTurn: boolean;
    }>,
  ): Promise<string | undefined> {
    const { store } = this._params.services;
    const { state } = shared;

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

/**
 * Result of executing a single tool call, capturing everything needed
 * for logging and message creation.
 */
interface ToolExecutionResult {
  call: SdkToolCall;
  result: ToolResult;
  parsedInput: unknown;
  sanitizedOutput: Record<string, unknown>;
  editedFiles: Array<{
    path: string;
    ok: boolean;
    source: string;
    sourceDisplay: string;
  }>;
}

/**
 * Dispatches tool calls and processes their results.
 *
 * For Google handlers with multiple parallel calls, this node batches all
 * function calls into a single model message to properly preserve thought
 * signatures (required for Gemini 3 models).
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUseDispatchNode<C> extends BaseNode<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseCycleShared<C>> {
    return shared;
  }

  async exec(
    shared: ToolUseCycleShared<C>,
  ): Promise<SkippableNodeResult<{ calls: SdkToolCall[] }>> {
    const { options } = this._params.services;
    const { state } = shared;
    if (state.shouldStop || !state.toolCalls || state.toolCalls.length === 0) {
      return { skipped: true };
    }

    if (await options.checkInterruption()) {
      state.shouldStop = true;
      return { skipped: true };
    }

    return {
      skipped: false,
      value: { calls: state.toolCalls },
    };
  }

  /**
   * Execute a single tool call and return the result with metadata.
   */
  private async executeToolCall(
    call: SdkToolCall,
    options: ToolUseCycleOptions<C>,
    tracker: FileInteractionState,
  ): Promise<ToolExecutionResult> {
    const tool = options.toolRegistry.get(call.name);
    let result: ToolResult;
    const parsedInput = parseToolInput(call.input, call.callId, options.logger);

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
        const { message, diagnostics } = normalizeToolCallError(call.name, err);
        result = toolResult({
          error: message,
          isError: true,
          diagnostics,
        });
      }
    }

    // recordEdits computes line changes from edits array as single source of truth
    const trackedEdits = tracker.recordEdits(result.edits);

    // Set lineChanges on result directly (tool's value takes precedence)
    if (!result.lineChanges && trackedEdits.lineChanges) {
      result.lineChanges = trackedEdits.lineChanges;
    }

    const sanitizedOutput = extractToolAttachments(result).sanitizedResult;
    const editedFiles = trackedEdits.edits.map((entry) => ({
      path: entry.path,
      ok: true,
      source: 'tool',
      sourceDisplay: 'Tool use',
    }));

    // Track edited files separately (not same as attachment files)
    if (editedFiles.length > 0) {
      sanitizedOutput.editedFiles = editedFiles;
    }

    return {
      call,
      result,
      parsedInput,
      sanitizedOutput,
      editedFiles,
    };
  }

  /**
   * Log tool execution and handle media file attachments.
   */
  private async logAndProcessMediaFiles(
    execResult: ToolExecutionResult,
    options: ToolUseCycleOptions<C>,
    store: ToolUseCycleServices<C>['store'],
    groupId: string | undefined,
  ): Promise<void> {
    const { call, result, parsedInput, sanitizedOutput, editedFiles } =
      execResult;

    const toolUseLog = {
      toolName: call.name,
      input: parsedInput ?? call.raw,
      output: sanitizedOutput,
      ...(editedFiles.length > 0 && { files: editedFiles }),
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
  }

  async post(
    shared: ToolUseCycleShared<C>,
    _prepRes: ToolUseCycleShared<C>,
    execRes: SkippableNodeResult<{ calls: SdkToolCall[] }>,
  ): Promise<string | undefined> {
    const { options, store } = this._params.services;
    const { state } = shared;
    const groupId = options.logger.withCurrentGroup((id) => id);

    if (execRes.skipped) {
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { calls } = execRes.value;
    const assistantText = state.text ?? '';
    const tracker = store.workspace.interactions;

    // Step 1: Execute all tool calls and collect results
    const execResults: ToolExecutionResult[] = [];
    for (const call of calls) {
      const execResult = await this.executeToolCall(call, options, tracker);
      execResults.push(execResult);

      // Log each tool execution as it completes
      await this.logAndProcessMediaFiles(execResult, options, store, groupId);
    }

    // Step 2: Create follow-up messages
    // Extract attachments once per result (single extraction point)
    const extracted = execResults.map((er) =>
      extractToolAttachments(er.result),
    );

    // For Google handlers with multiple parallel calls, use batched method
    // to properly preserve thought signatures (required for Gemini 3 models).
    // For DeepSeek thinking mode, batching ensures reasoning_content is
    // properly included in the single assistant message with all tool calls.
    const shouldBatch =
      (options.modelHandler.isGoogle || options.modelHandler.isDeepSeek) &&
      calls.length > 1 &&
      typeof options.modelHandler.createBatchedToolUseFollowUpMessages ===
        'function';

    if (shouldBatch) {
      // Batched: All function calls in one model message, all responses in one user message
      const followUpMsgs = await options.modelHandler
        .createBatchedToolUseFollowUpMessages!(
        calls,
        extracted.map((e) => e.sanitizedResult),
        extracted.map((e) => e.attachments),
        store.workspace,
        assistantText.length > 0 ? assistantText : undefined,
      );
      state.messages.push(...followUpMsgs);
    } else {
      // Individual: Process each call separately (original behavior)
      for (const [index, execResult] of execResults.entries()) {
        const { sanitizedResult, attachments } = extracted[index];
        const followUpMsgs =
          await options.modelHandler.createToolUseFollowUpMessages(
            options.client,
            execResult.call,
            sanitizedResult,
            attachments,
            store.workspace,
            index === 0 && assistantText.length > 0 ? assistantText : undefined,
          );
        state.messages.push(...followUpMsgs);
      }
    }

    // Step 3: Handle user instructions from tool results
    for (const execResult of execResults) {
      if (
        typeof execResult.result.userInstruction === 'string' &&
        execResult.result.userInstruction.trim().length > 0
      ) {
        await options.modelHandler.createUserFollowUpMessages(
          state.messages,
          execResult.result.userInstruction,
        );
      }
    }

    state.toolCalls = [];

    return FlowTransition.CONTINUE;
  }
}
/**
 * Creates a tool-use cycle flow with services injected via params.
 *
 * The returned flow uses the services pattern:
 * - Services (options, store) are passed via `setParams({ services })`
 * - Only mutable state flows through the shared context
 *
 * @example
 * ```typescript
 * const flow = createToolUseCycleFlow<MyContext>();
 * flow.setParams({ services: { options, store } });
 * await flow.run(sharedState);
 * ```
 */
export function createToolUseCycleFlow<C>(): Flow<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ToolUseCallNode<C>();
  // Use shared retry wait node (single source of truth)
  // Note: RetryWaitNode accesses services via its own accessor pattern
  const retryWaitNode = createRetryWaitNode<ToolUseCycleShared<C>>({
    getStreamId: (_shared, params) =>
      (params as ToolUseCycleParams<C>).services.options.context.streamId,
    getLogger: (_shared, params) =>
      (params as ToolUseCycleParams<C>).services.options.logger,
    operationName: 'Tool-use call',
  });
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  // Main flow: prep → call → process → dispatch
  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);

  // Retry transition from call node:
  // - AWAIT_RETRY: Go to retry wait node for manual retry
  // Note: Auto-retry is handled internally by PocketFlow Node (maxRetries, wait)
  callNode.on(FlowTransition.AWAIT_RETRY, retryWaitNode);

  // Retry wait node transitions:
  // - MANUAL_RETRY: Loop back to call node after user triggers retry
  // - COMPLETE: Exit flow if user cancels
  retryWaitNode.on(FlowTransition.MANUAL_RETRY, callNode);

  // Dispatch can loop back to prep for next tool cycle
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleShared<C>, ToolUseCycleParams<C>>(prepNode);
}
