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
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';

// Internal imports - use core ToolTypes as single source of truth
import { extractToolAttachments } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type {
  FileInteractionState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import type { ToolResult } from '@agent/core/ToolTypes';
import { toolResult } from '@agent/core/ToolTypes';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
// Type imports
import type { ToolDefinition } from '@model';
import { withToolEditApprovalContext } from '@tools/approval/toolEditApprovalContext';
import { AbsoluteFS, pathToLocation, type FileLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type RetryState,
  clearRetryError,
  getNodeRetryConfig,
  recordRetryError,
  handleManualRetryPrompt,
} from './RetryState';
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
  messages: ProviderMessage[];
}

/**
 * Result type for tool-use call.
 * - Success: Contains response from model
 * - Failed: When all retries exhausted or non-retryable error (records lastError)
 * - Cancelled: When user cancelled manual retry (does NOT record lastError)
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
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

/**
 * Handles model invocation for tool-use cycles with PocketFlow's built-in retry.
 *
 * Uses PocketFlow Node for auto-retry AND manual retry via retryPrompt:
 * - maxRetries and wait configured from user settings
 * - exec() throws on error, Node retries automatically
 * - retryPrompt() shows UI when auto-retries exhausted (if error is retryable)
 * - execFallback() called only when user cancels or error is non-retryable
 *
 * Flow transitions:
 * - default: Continue to next node on success
 * - COMPLETE: All retries exhausted, non-retryable error, or user cancelled
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUseCallNode<C> extends Node<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  /** Tracks if user cancelled manual retry (to distinguish from actual failures) */
  private _userCancelled = false;

  constructor() {
    const config = getNodeRetryConfig();
    super(config.maxRetries, config.wait);
  }

  /**
   * Reset user-cancelled flag on clone to prevent stale state.
   *
   * This override is necessary because BaseNode.clone() uses Object.assign,
   * which copies instance properties including _userCancelled. Without this
   * reset, a cloned node would inherit the cancelled state from a previous
   * execution, causing incorrect behavior in execFallback().
   */
  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    return cloned;
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

  /**
   * Manual retry prompt - called when auto-retries are exhausted.
   * Shows retry UI for retryable errors and waits for user action.
   *
   * NOTE: This must be a regular method (not an arrow function) because
   * Node.clone() uses Object.assign. Arrow functions capture `this` at
   * construction time, so they would reference the original instance
   * instead of the clone after cloning.
   *
   * @returns true to restart auto-retry loop, false to proceed to execFallback
   */
  async retryPrompt(
    _prepRes: unknown,
    error: Error,
  ): Promise<boolean> {
    const { options } = this._params.services;

    const result = await handleManualRetryPrompt(error, {
      operationName: 'Tool-use call',
      streamId: options.context.streamId,
      logger: options.logger,
    });

    // Track user cancellation to distinguish from actual failures in execFallback.
    // Note: This flag is only set when user explicitly cancelled a retryable error.
    // Non-retryable errors skip the retry UI and go directly to execFallback,
    // where _userCancelled will be false (correctly treating them as failures).
    if (result.userCancelled) {
      this._userCancelled = true;
    }

    return result.shouldRetry;
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
    // retry loop in _exec(), which calls retryPrompt() then execFallback().
  }

  /**
   * Called by PocketFlow Node when retryPrompt returns false.
   * This means either the error was non-retryable or user cancelled.
   */
  async execFallback(
    _prepRes: ToolUseCallPrepResult,
    error: Error,
  ): Promise<ToolUseCallResult> {
    // User cancelled manual retry - return 'cancelled' (not 'failed')
    // This ensures lastError is NOT recorded, distinguishing cancellation from failure
    if (this._userCancelled) {
      return { kind: 'cancelled' };
    }

    const formatted = formatProviderHttpError(error);
    // Log final failure (only for non-retryable errors - retryable ones were logged in retryPrompt)
    if (!formatted.retryable) {
      const { options } = this._params.services;
      options.logger.logErrorData(
        `Tool-use call failed (not retryable): ${formatted.message}`,
        {
          message: formatted.message,
          statusCode: formatted.statusCode,
          retryable: formatted.retryable,
        },
      );
    }
    return { kind: 'failed', message: formatted.message };
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

    // Handle user cancellation (do NOT record error - distinguishes from failure)
    if (execRes.kind === 'cancelled') {
      // Clear any previous error to ensure userCancelled detection works
      clearRetryError(retryState);
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    // Handle failure (all retries exhausted or non-retryable error)
    if (execRes.kind === 'failed') {
      // Record error for caller access
      recordRetryError(retryState, {
        message: execRes.message,
        retryable: false, // Already exhausted retries
      });
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
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
 * Data extracted by prep() for tool-use process.
 * PocketFlow compliance: exec() should only use prepRes, not shared.
 */
interface ToolUseProcessPrepResult {
  shouldStop: boolean;
  response?: unknown;
  responseTime?: number;
}

/**
 * Result of exec() containing extracted data and all values needed for post() side effects.
 * PocketFlow compliance: exec() returns computation results, post() applies side effects.
 */
interface ToolUseProcessExecResult {
  skipped: boolean;
  // Core results
  toolCalls?: SdkToolCall[];
  stopReason?: ProviderStopReason;
  text?: string;
  endTurn: boolean;
  // Data for side effects in post()
  serverToolContentBlocks?: ServerToolContentBlock[];
  lastAssistantContent?: unknown[];
  normalizedUsage?: NormalizedUsage;
  responseTime?: number;
  // Message to create if endTurn
  createAssistantMessage?: boolean;
  lastResponseUpdate?: string;
}

/**
 * Processes the model response to extract tool calls and usage data.
 *
 * PocketFlow compliance:
 * - prep(): Extracts data from shared for exec()
 * - exec(): Pure computation using prepRes and services (no side effects)
 * - post(): Applies all side effects to shared/store
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUseProcessNode<C> extends BaseNode<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  /**
   * Extract data from shared for exec().
   * PocketFlow compliance: Only extract what exec() needs.
   */
  async prep(shared: ToolUseCycleShared<C>): Promise<ToolUseProcessPrepResult> {
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      response: state.response,
      responseTime: state.responseTime,
    };
  }

  /**
   * Process response and extract tool calls.
   * PocketFlow compliance: Pure computation, no side effects on shared/store.
   * Logging is allowed as it doesn't affect flow state.
   */
  async exec(
    prepRes: ToolUseProcessPrepResult,
  ): Promise<ToolUseProcessExecResult> {
    if (prepRes.shouldStop || !prepRes.response) {
      return { skipped: true, endTurn: false };
    }

    const { options, store } = this._params.services;
    const groupId = options.logger.withCurrentGroup((id) => id);

    // Process thinking block (logging only, state stored in workspace)
    const thinking = options.modelHandler.processThinkingBlock(
      prepRes.response,
      store.workspace,
    );
    const useStreaming = options.modelHandler.getStreamingConfig();
    if (thinking && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinking);
      if (isNonEmptyString(formatted)) {
        options.logger.info(formatted, {
          groupId,
          messageType: MESSAGE_TYPES.THINKING,
        });
      }
    }

    // Extract response data
    const toolCalls = options.modelHandler.extractToolUse(prepRes.response);
    const {
      response: text,
      usage,
      stopReason,
    } = options.modelHandler.extractResponse(prepRes.response, '');

    // Single extraction for all server tool data (single source of truth)
    const serverToolData = options.modelHandler.extractServerToolData(
      prepRes.response,
    );

    // Log web search results (logging doesn't affect flow state)
    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        options.logger.info('', {
          groupId,
          messageType: MESSAGE_TYPES.WEB_SEARCH,
          data: searchResult,
        });
      }
    }

    // Extract assistant content for follow-up messages
    const lastAssistantContent = options.modelHandler.extractAssistantContent(
      prepRes.response,
    );

    // Log response text
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

    // Normalize usage if present
    let normalizedUsage: NormalizedUsage | undefined;
    if (usage) {
      normalizedUsage = options.modelHandler.normalizeUsage(
        usage,
        prepRes.responseTime ?? 0,
      );
    }

    const endTurn = options.modelHandler.isEndTurnStop(stopReason);

    if (!toolCalls || toolCalls.length === 0 || endTurn) {
      return {
        skipped: false,
        stopReason,
        text: text ?? undefined,
        endTurn: true,
        serverToolContentBlocks: serverToolData.contentBlocks,
        lastAssistantContent,
        normalizedUsage,
        responseTime: prepRes.responseTime,
        createAssistantMessage: Boolean(text),
        lastResponseUpdate: text ?? undefined,
      };
    }

    return {
      skipped: false,
      toolCalls,
      stopReason,
      text: text ?? undefined,
      endTurn: false,
      serverToolContentBlocks: serverToolData.contentBlocks,
      lastAssistantContent,
      normalizedUsage,
      responseTime: prepRes.responseTime,
    };
  }

  /**
   * Apply all side effects to shared/store.
   * PocketFlow compliance: All mutations happen here.
   */
  async post(
    shared: ToolUseCycleShared<C>,
    _prepRes: ToolUseProcessPrepResult,
    execRes: ToolUseProcessExecResult,
  ): Promise<string | undefined> {
    const { options, store } = this._params.services;
    const { state } = shared;

    if (execRes.skipped) {
      store.round.clearUsage();
      return FlowTransition.COMPLETE;
    }

    // Apply side effects: server tool content
    store.workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    store.workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    // Apply side effects: response time
    if (execRes.responseTime !== undefined) {
      store.round.addResponseTime(execRes.responseTime);
    }

    // Apply side effects: usage
    if (execRes.normalizedUsage) {
      store.round.setNormalizedUsage(execRes.normalizedUsage);
    } else {
      store.round.clearUsage();
    }

    // Finalize round
    const completedRound = store.round;
    await store.finalizeRound();
    store.run.incrementRounds();
    const nextRoundIndex = completedRound.roundIndex + 1;

    if (execRes.endTurn) {
      // Apply side effects for end turn
      state.toolCalls = undefined;
      if (execRes.createAssistantMessage && execRes.text) {
        state.messages.push(
          options.modelHandler.createAssistantMessage(execRes.text),
        );
        store.workspace.assembly.updateLastResponse(execRes.text);
      }
      // Clear ephemeral state
      store.workspace.resetServerToolContent();
      store.workspace.resetReasoning();
      state.shouldStop = true;
      state.stopReason = execRes.stopReason;
      store.resetRound(nextRoundIndex);
      return FlowTransition.COMPLETE;
    }

    // Apply side effects for continuing with tool calls
    state.toolCalls = execRes.toolCalls;
    state.text = execRes.text;
    state.stopReason = execRes.stopReason;
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
 * Data extracted by prep() for tool dispatch.
 * PocketFlow compliance: exec() should only use prepRes, not shared.
 */
interface ToolUseDispatchPrepResult {
  shouldStop: boolean;
  toolCalls: SdkToolCall[];
  text?: string;
}

/**
 * Result of exec() for tool dispatch.
 * PocketFlow compliance: exec() returns computation results, post() applies side effects.
 */
type ToolUseDispatchExecResult =
  | { skipped: true; interrupted: boolean }
  | { skipped: false; calls: SdkToolCall[] };

/**
 * Dispatches tool calls and processes their results.
 *
 * For Google handlers with multiple parallel calls, this node batches all
 * function calls into a single model message to properly preserve thought
 * signatures (required for Gemini 3 models).
 *
 * PocketFlow compliance:
 * - prep(): Extracts data from shared for exec()
 * - exec(): Pure computation using prepRes (no side effects)
 * - post(): Applies all side effects to shared/store
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUseDispatchNode<C> extends BaseNode<
  ToolUseCycleShared<C>,
  ToolUseCycleParams<C>
> {
  /**
   * Extract data from shared for exec().
   * PocketFlow compliance: Only extract what exec() needs.
   */
  async prep(
    shared: ToolUseCycleShared<C>,
  ): Promise<ToolUseDispatchPrepResult> {
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      toolCalls: state.toolCalls ?? [],
      text: state.text,
    };
  }

  /**
   * Check conditions for tool dispatch.
   * PocketFlow compliance: Pure computation, no side effects.
   */
  async exec(
    prepRes: ToolUseDispatchPrepResult,
  ): Promise<ToolUseDispatchExecResult> {
    const { options } = this._params.services;

    if (prepRes.shouldStop || prepRes.toolCalls.length === 0) {
      return { skipped: true, interrupted: false };
    }

    if (await options.checkInterruption()) {
      // Return interrupted flag - post() will apply the side effect
      return { skipped: true, interrupted: true };
    }

    return {
      skipped: false,
      calls: prepRes.toolCalls,
    };
  }

  /**
   * Execute a single tool call and return the result with metadata.
   */
  private async executeToolCall(
    call: SdkToolCall,
    options: ToolUseCycleOptions<C>,
    tracker: FileInteractionState,
    todoState: TodoState,
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
            todoState,
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
      const toAdd: FileLocation[] = [];
      for (const attachment of result.files) {
        const candidate = attachment.path;
        if (typeof candidate !== 'string' || candidate.trim() === '') {
          continue;
        }
        // Convert to FileLocation - pathToLocation handles both absolute and relative paths,
        // including external paths outside the workspace
        const location = pathToLocation(candidate);
        try {
          // Use AbsoluteFS for file existence check to support external paths
          const exists = await AbsoluteFS.exists(location.absolutePath);
          if (exists) {
            toAdd.push(location);
          }
        } catch (_err) {
          // Ignore errors when checking existence
        }
      }
      if (toAdd.length > 0) {
        // addMediaFiles handles deduplication (both within toAdd and against existing files)
        store.workspace.media.addMediaFiles(toAdd);
      }
    }
  }

  /**
   * Execute tool calls and apply side effects.
   * PocketFlow compliance: All mutations happen here.
   */
  async post(
    shared: ToolUseCycleShared<C>,
    prepRes: ToolUseDispatchPrepResult,
    execRes: ToolUseDispatchExecResult,
  ): Promise<string | undefined> {
    const { options, store } = this._params.services;
    const { state } = shared;
    const groupId = options.logger.withCurrentGroup((id) => id);

    if (execRes.skipped) {
      // Apply interrupted side effect if needed
      if (execRes.interrupted) {
        state.shouldStop = true;
      }
      return FlowTransition.COMPLETE;
    }

    const { calls } = execRes;
    const assistantText = prepRes.text ?? '';
    const tracker = store.workspace.interactions;
    const todoState = store.workspace.todos;

    // Step 1: Execute all tool calls and collect results
    const execResults: ToolExecutionResult[] = [];
    for (const call of calls) {
      const execResult = await this.executeToolCall(
        call,
        options,
        tracker,
        todoState,
      );
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
      if (isNonEmptyString(execResult.result.userInstruction)) {
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
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  // Main flow: prep → call → process → dispatch
  // Note: Retry (both auto and manual) is handled internally by PocketFlow Node
  // via maxRetries, wait, and retryPrompt. No separate RetryWaitNode needed.
  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);

  // Dispatch can loop back to prep for next tool cycle
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleShared<C>, ToolUseCycleParams<C>>(prepNode);
}
