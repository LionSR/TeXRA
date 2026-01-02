// Third-party imports (none needed)

// Local imports - core flow primitives
import { isRemoteAgent } from '@agent/index';
import { BaseNode, Flow } from '@agent/node';
import {
  BaseCycleState,
  BaseCycleShared,
  BaseInvocationPrepResult,
  BaseInvocationSuccessData,
  resetCycleState,
  CycleDebugContext,
  CycleDebugFileOptions,
  createDebugContext,
  createDebugFileOptions,
} from '@agent/core/flows/CommonCycleTypes';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
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
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';
import {
  finalizeToolUseCycle,
  type ToolUseCycleOptions,
  type ToolUseCycleServices,
  type ToolUseCycleParams,
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
  /**
   * Current cycle index (0-based).
   *
   * Used for debug file naming and usage tracking. Incremented after each
   * successful cycle in ContinuationNode.post().
   *
   * This replaces the need for ConversationRoundState.roundIndex in tool-use
   * agents, simplifying the service dependencies.
   */
  cycleIndex: number;
  /**
   * Accumulated response time for current cycle (milliseconds).
   * Reset after finalization when continuing to next cycle.
   */
  cycleResponseTimeMs: number;
  /**
   * Normalized usage for current cycle.
   * Reset after finalization when continuing to next cycle.
   */
  cycleNormalizedUsage?: import('@agent/types/NormalizedUsage').NormalizedUsage;
  /**
   * Whether the last cycle ended normally (model said end_turn).
   *
   * Lifecycle:
   * - Initialized to `false` when shared state is created
   * - Set to `true` when model's stop_reason is 'end_turn'
   * - Set to `false` on failures, cancellations, or empty responses
   * - NOT reset by resetToolUseState() - preserved across cycles
   *
   * Used by callers to distinguish between:
   * - Normal completion: shouldStop=true, endTurn=true
   * - User cancellation: shouldStop=true, endTurn=false, lastError=undefined
   * - Failure: shouldStop=true, endTurn=false, lastError defined
   */
  endTurn: boolean;
}

function resetToolUseState(state: ToolUseCycleState): void {
  resetCycleState(state, []);
  state.response = undefined;
  state.toolCalls = undefined;
  state.text = undefined;
  // Reset cycle metrics for next cycle
  state.cycleResponseTimeMs = 0;
  state.cycleNormalizedUsage = undefined;
  // Note: cycleIndex is incremented, not reset
  // Note: endTurn is NOT reset here - it tracks whether the LAST cycle
  // ended normally, which is needed for caller detection of user cancellation.
}

/**
 * Shared state for tool-use cycle flows.
 * Uses BaseCycleShared with ToolUseCycleState for type safety.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface)
 * - Immutable services: `_params.services` (ToolUseCycleServices)
 */
export type ToolUseCycleShared = BaseCycleShared<ToolUseCycleState>;

/**
 * Prepares a tool-use cycle by checking interruptions and setting up debug context.
 *
 * Services accessed via `_params.services`: options, store
 */
class ToolUsePrepNode<C> extends BaseNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  async prep(shared: ToolUseCycleShared): Promise<{
    interrupted: boolean;
    debugContext: CycleDebugContext;
    debugFileOptions: CycleDebugFileOptions;
  }> {
    const services = this.services;
    const interrupted = Boolean(await services.checkInterruption());
    const debugContext = createDebugContext({
      logger: services.logger,
      modelName: services.modelName,
      executionId: services.context.executionId,
      isRemote: isRemoteAgent(services.agentName),
    });
    // Use cycleIndex from state instead of round.roundIndex
    const debugFileOptions = createDebugFileOptions(
      shared.state.cycleIndex,
      'tooluse',
    );
    return { interrupted, debugContext, debugFileOptions };
  }

  async post(
    shared: ToolUseCycleShared,
    prepRes: {
      interrupted: boolean;
      debugContext: CycleDebugContext;
      debugFileOptions: CycleDebugFileOptions;
    },
  ): Promise<string | undefined> {
    const { state } = shared;

    if (prepRes.interrupted) {
      state.shouldStop = true;
      state.endTurn = false; // Interrupted, not a normal completion
      return FlowTransition.COMPLETE;
    }

    // Reset at the start of each cycle so downstream nodes observe a clean
    // runtime state before enriching it with model responses.
    resetToolUseState(state);

    await maybeSaveDebugObject({
      object: state.messages,
      objectType: 'messages',
      context: prepRes.debugContext,
      fileOptions: prepRes.debugFileOptions,
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Success data for tool-use call.
 * Extends base with debug context for message saving.
 */
interface ToolUseCallSuccessData extends BaseInvocationSuccessData {
  debugContext: CycleDebugContext;
  debugFileOptions: CycleDebugFileOptions;
}

/**
 * Result type for tool-use call (uses shared InvocationResult).
 */
type ToolUseCallResult = InvocationResult<ToolUseCallSuccessData>;

/**
 * Handles model invocation for tool-use cycles with PocketFlow's built-in retry.
 *
 * Extends RetryableInvocationNode for shared retry logic:
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
class ToolUseCallNode<C> extends RetryableInvocationNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  protected getOperationName(): string {
    return 'Tool-use call';
  }

  /**
   * Extract data from shared for exec().
   * PocketFlow compliance: exec() should only use prepRes, not shared.
   */
  async prep(
    shared: ToolUseCycleShared,
  ): Promise<BaseInvocationPrepResult & { cycleIndex: number }> {
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      messages: state.messages,
      cycleIndex: state.cycleIndex,
    };
  }

  async exec(
    prepRes: BaseInvocationPrepResult & { cycleIndex: number },
  ): Promise<ToolUseCallResult> {
    const services = this.services;

    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    const debugContext = createDebugContext({
      logger: services.logger,
      modelName: services.modelName,
      executionId: services.context.executionId,
      isRemote: isRemoteAgent(services.agentName),
    });
    // Use cycleIndex from prepRes instead of round.roundIndex
    const debugFileOptions = createDebugFileOptions(
      prepRes.cycleIndex,
      'tooluse_response',
    );

    const start = Date.now();

    // Use base class helper for abort controller lifecycle
    return this.withAbortController(async (signal) => {
      services.modelHandler.setOutputStreaming(true);
      const response = await services.modelHandler.createResponse({
        client: services.client,
        messages: prepRes.messages,
        temperature: services.agentSetting.temperature ?? 0,
        signal,
        tools: services.agentSetting.tools as ToolDefinition[] | undefined,
      });

      const responseTimeMs = Date.now() - start;

      return {
        kind: 'success',
        response,
        responseTimeMs,
        debugContext,
        debugFileOptions,
      };
    });
    // Note: Errors from createResponse() are caught by PocketFlow Node's
    // retry loop in _exec(), which calls retryPrompt() then execFallback().
  }

  /**
   * Called by PocketFlow Node when retryPrompt returns false.
   * Uses base class getFallbackResult() for shared logic.
   */
  async execFallback(
    _prepRes: BaseInvocationPrepResult,
    error: Error,
  ): Promise<ToolUseCallResult> {
    return this.getFallbackResult(error);
  }

  async post(
    shared: ToolUseCycleShared,
    _prepRes: BaseInvocationPrepResult,
    execRes: ToolUseCallResult,
  ): Promise<string | undefined> {
    const services = this.services;
    const { state, retryState } = shared;

    // Handle non-success cases (returns null) or get narrowed success result
    const successRes = handleInvocationResult(execRes, state, retryState, {
      logger: services.logger,
      operationName: this.getOperationName(),
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    // Apply success-specific side effects
    state.response = successRes.response;
    state.responseTimeMs = successRes.responseTimeMs;

    await maybeSaveDebugObject({
      object: successRes.response,
      objectType: 'response',
      context: successRes.debugContext,
      fileOptions: successRes.debugFileOptions,
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Data extracted by prep() for tool-use process.
 * PocketFlow compliance: exec() should only use prepRes, not shared.
 */
interface ToolUseProcessPrepResult {
  shouldStop: boolean;
  response?: unknown;
  responseTimeMs?: number;
}

/**
 * Result of exec() containing extracted data and all values needed for post() side effects.
 * PocketFlow compliance: exec() returns computation results, post() applies side effects.
 */
type ToolUseProcessExecResult =
  | { kind: 'skipped'; endTurn: false }
  | {
      kind: 'success';
      // Core results
      toolCalls?: SdkToolCall[];
      stopReason?: ProviderStopReason;
      text?: string;
      endTurn: boolean;
      // Data for side effects in post()
      serverToolContentBlocks?: ServerToolContentBlock[];
      lastAssistantContent?: unknown[];
      normalizedUsage?: NormalizedUsage;
      responseTimeMs?: number;
      // Message to create if endTurn
      createAssistantMessage?: boolean;
      lastResponseUpdate?: string;
    };

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
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  /**
   * Extract data from shared for exec().
   * PocketFlow compliance: Only extract what exec() needs.
   */
  async prep(shared: ToolUseCycleShared): Promise<ToolUseProcessPrepResult> {
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      response: state.response,
      responseTimeMs: state.responseTimeMs,
    };
  }

  /**
   * Process response and extract tool calls.
   * PocketFlow compliance: Pure computation, no side effects on shared state.
   * Logging is allowed as it doesn't affect flow state.
   */
  async exec(
    prepRes: ToolUseProcessPrepResult,
  ): Promise<ToolUseProcessExecResult> {
    if (prepRes.shouldStop || !prepRes.response) {
      return { kind: 'skipped', endTurn: false };
    }

    const services = this.services;
    const { workspace } = services;
    const groupId = services.logger.withCurrentGroup((id) => id);

    // Process thinking block (logging only, state stored in workspace)
    const thinking = services.modelHandler.processThinkingBlock(
      prepRes.response,
      workspace,
    );
    const useStreaming = services.modelHandler.getStreamingConfig();
    if (thinking && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinking);
      if (isNonEmptyString(formatted)) {
        services.logger.info(formatted, {
          groupId,
          messageType: MESSAGE_TYPES.THINKING,
        });
      }
    }

    // Extract response data
    const toolCalls = services.modelHandler.extractToolUse(prepRes.response);
    const {
      response: text,
      usage,
      stopReason,
    } = services.modelHandler.extractResponse(prepRes.response, '');

    // Single extraction for all server tool data (single source of truth)
    const serverToolData = services.modelHandler.extractServerToolData(
      prepRes.response,
    );

    // Log web search results (logging doesn't affect flow state)
    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        services.logger.info('', {
          groupId,
          messageType: MESSAGE_TYPES.WEB_SEARCH,
          data: searchResult,
        });
      }
    }

    // Extract assistant content for follow-up messages
    const lastAssistantContent = services.modelHandler.extractAssistantContent(
      prepRes.response,
    );

    // Log response text
    if (text) {
      services.logger.debug(`Model response: ${text.slice(0, 100)}`, {
        groupId,
      });
      if (!useStreaming) {
        const formatted = await xmlUtils.formatContent(text);
        services.logger.info(formatted, {
          groupId,
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        });
      }
    }

    // Normalize usage if present
    let normalizedUsage: NormalizedUsage | undefined;
    if (usage) {
      normalizedUsage = services.modelHandler.normalizeUsage(
        usage,
        prepRes.responseTimeMs ?? 0,
      );
    }

    const endTurn = services.modelHandler.isEndTurnStop(stopReason);

    if (!toolCalls || toolCalls.length === 0 || endTurn) {
      return {
        kind: 'success',
        stopReason,
        text: text ?? undefined,
        endTurn: true,
        serverToolContentBlocks: serverToolData.contentBlocks,
        lastAssistantContent,
        normalizedUsage,
        responseTimeMs: prepRes.responseTimeMs,
        createAssistantMessage: Boolean(text),
        lastResponseUpdate: text ?? undefined,
      };
    }

    return {
      kind: 'success',
      toolCalls,
      stopReason,
      text: text ?? undefined,
      endTurn: false,
      serverToolContentBlocks: serverToolData.contentBlocks,
      lastAssistantContent,
      normalizedUsage,
      responseTimeMs: prepRes.responseTimeMs,
    };
  }

  /**
   * Apply all side effects to shared state and slices.
   * PocketFlow compliance: All mutations happen here.
   */
  async post(
    shared: ToolUseCycleShared,
    _prepRes: ToolUseProcessPrepResult,
    execRes: ToolUseProcessExecResult,
  ): Promise<string | undefined> {
    const services = this.services;
    const { run, workspace, onRoundFinalized } = services;
    const { state } = shared;

    if (execRes.kind === 'skipped') {
      return FlowTransition.COMPLETE;
    }

    // Apply side effects: server tool content
    workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    // Accumulate cycle metrics in state (not round object)
    if (execRes.responseTimeMs !== undefined) {
      state.cycleResponseTimeMs += execRes.responseTimeMs;
    }
    if (execRes.normalizedUsage) {
      state.cycleNormalizedUsage = execRes.normalizedUsage;
    }

    // Finalize cycle using direct values (no round object needed)
    await finalizeToolUseCycle({
      cycleIndex: state.cycleIndex,
      responseTimeMs: state.cycleResponseTimeMs,
      normalizedUsage: state.cycleNormalizedUsage ?? null,
      run,
      onRoundFinalized,
    });
    run.incrementRounds();

    if (execRes.endTurn) {
      // Apply side effects for end turn
      state.toolCalls = undefined;
      if (execRes.createAssistantMessage && execRes.text) {
        state.messages.push(
          services.modelHandler.createAssistantMessage(execRes.text),
        );
        workspace.assembly.lastResponse = execRes.text;
      }
      // Clear ephemeral state
      workspace.resetServerToolContent();
      workspace.resetReasoning();
      state.shouldStop = true;
      state.endTurn = true; // Normal completion (model said end_turn)
      state.stopReason = execRes.stopReason;
      return FlowTransition.COMPLETE;
    }

    // Apply side effects for continuing with tool calls
    state.toolCalls = execRes.toolCalls;
    state.text = execRes.text;
    state.stopReason = execRes.stopReason;
    // Increment cycle index and reset metrics for next cycle
    state.cycleIndex += 1;
    state.cycleResponseTimeMs = 0;
    state.cycleNormalizedUsage = undefined;

    return FlowTransition.DEFAULT;
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
  shouldSkip: boolean;
  interrupted: boolean;
  toolCalls: SdkToolCall[];
  text?: string;
}

/**
 * Result of exec() for tool dispatch.
 * PocketFlow compliance: exec() returns computation results, post() applies side effects.
 */
type ToolUseDispatchExecResult =
  | { kind: 'skipped'; interrupted: boolean }
  | { kind: 'success'; calls: SdkToolCall[] };

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
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  /**
   * Extract data from shared and check interruption.
   * PocketFlow compliance: I/O (checkInterruption) happens in prep().
   */
  async prep(shared: ToolUseCycleShared): Promise<ToolUseDispatchPrepResult> {
    const services = this.services;
    const { state } = shared;
    const toolCalls = state.toolCalls ?? [];

    // Check skip conditions (including interruption) in prep
    const shouldSkip = state.shouldStop || toolCalls.length === 0;
    const interrupted = shouldSkip
      ? false
      : Boolean(await services.checkInterruption());

    return {
      shouldSkip,
      interrupted,
      toolCalls,
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
    if (prepRes.shouldSkip) {
      return { kind: 'skipped', interrupted: false };
    }

    if (prepRes.interrupted) {
      return { kind: 'skipped', interrupted: true };
    }

    return {
      kind: 'success',
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
    workspace: ToolUseCycleServices<C>['workspace'],
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
        workspace.media.addMediaFiles(toAdd);
      }
    }
  }

  /**
   * Execute tool calls and apply side effects.
   * PocketFlow compliance: All mutations happen here.
   */
  async post(
    shared: ToolUseCycleShared,
    prepRes: ToolUseDispatchPrepResult,
    execRes: ToolUseDispatchExecResult,
  ): Promise<string | undefined> {
    const services = this.services;
    const { workspace } = services;
    const { state } = shared;
    const groupId = services.logger.withCurrentGroup((id) => id);

    if (execRes.kind === 'skipped') {
      // Apply interrupted side effect if needed
      if (execRes.interrupted) {
        state.shouldStop = true;
      }
      return FlowTransition.COMPLETE;
    }

    const { calls } = execRes;
    const assistantText = prepRes.text ?? '';
    const tracker = workspace.interactions;
    const todoState = workspace.todos;

    // Step 1: Execute all tool calls and collect results
    const execResults: ToolExecutionResult[] = [];
    for (const call of calls) {
      const execResult = await this.executeToolCall(
        call,
        services,
        tracker,
        todoState,
      );
      execResults.push(execResult);

      // Log each tool execution as it completes
      await this.logAndProcessMediaFiles(
        execResult,
        services,
        workspace,
        groupId,
      );
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
      (services.modelHandler.isGoogle || services.modelHandler.isDeepSeek) &&
      calls.length > 1 &&
      typeof services.modelHandler.createBatchedToolUseFollowUpMessages ===
        'function';

    if (shouldBatch) {
      // Batched: All function calls in one model message, all responses in one user message
      const followUpMsgs = await services.modelHandler
        .createBatchedToolUseFollowUpMessages!(
        calls,
        extracted.map((e) => e.sanitizedResult),
        extracted.map((e) => e.attachments),
        workspace,
        assistantText.length > 0 ? assistantText : undefined,
      );
      state.messages.push(...followUpMsgs);
    } else {
      // Individual: Process each call separately (original behavior)
      for (const [index, execResult] of execResults.entries()) {
        const { sanitizedResult, attachments } = extracted[index];
        const followUpMsgs =
          await services.modelHandler.createToolUseFollowUpMessages(
            services.client,
            execResult.call,
            sanitizedResult,
            attachments,
            workspace,
            index === 0 && assistantText.length > 0 ? assistantText : undefined,
          );
        state.messages.push(...followUpMsgs);
      }
    }

    // Step 3: Handle user instructions from tool results
    for (const execResult of execResults) {
      if (isNonEmptyString(execResult.result.userInstruction)) {
        await services.modelHandler.createUserFollowUpMessages(
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
  ToolUseCycleShared,
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

  return new Flow<ToolUseCycleShared, ToolUseCycleParams<C>>(prepNode);
}
