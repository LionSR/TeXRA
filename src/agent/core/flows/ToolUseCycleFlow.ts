// Third-party imports
import { z } from 'zod';

// Local imports - core flow primitives
import { isRemoteAgent } from '@agent/index';
import { BaseNode, Flow } from '@agent/node';
import {
  BaseCycleFieldsSchema,
  BaseInvocationPrepResult,
  BaseInvocationSuccessData,
  resetCycleState,
  getDebugContext,
} from '@agent/core/flows/CommonCycleTypes';
import { createRetryState, type RetryState } from './RetryState';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

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

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
// Type imports
import type { ToolDefinition } from '@model';
import { AbsoluteFS, pathToLocation, type FileLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import { formatContent } from '@utils/text/xmlUtils';

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

// ============================================================================
// Tool-Use Cycle Schema (Extends Base)
// ============================================================================

/**
 * Schema for serializable tool-use cycle fields.
 *
 * Extends BaseCycleFieldsSchema with tool-specific fields.
 * Uses the same flat pattern as ResponseCycleFlow for consistency.
 *
 * ## Field Categories
 *
 * From BaseCycleFieldsSchema (shared with ResponseCycleFlow):
 * - messages, shouldStop, endTurn, responseTimeMs, stopReason, lastError
 *
 * Tool-use specific fields:
 * - response, toolCalls, text, cycleIndex, cycleResponseTimeMs, cycleNormalizedUsage
 */
export const ToolUseCycleFieldsSchema = BaseCycleFieldsSchema.extend({
  /** Raw response from model (provider-specific, not schematized) */
  response: z.unknown().optional(),
  /**
   * Tool calls extracted from response.
   * Runtime type is SdkToolCall[] (discriminated union of provider-specific types).
   * Uses z.unknown() because SdkToolCall is a complex union without a Zod schema.
   */
  toolCalls: z.array(z.unknown()).optional(),
  /** Text content from response */
  text: z.string().optional(),
  /**
   * Current cycle index (0-based).
   *
   * Used for debug file naming and usage tracking. Incremented after each
   * successful cycle in ToolUseProcessNode.post().
   */
  cycleIndex: z.number(),
  /**
   * Accumulated response time for current cycle (milliseconds).
   * Reset after finalization when continuing to next cycle.
   */
  cycleResponseTimeMs: z.number(),
  /**
   * Normalized usage for current cycle.
   * Reset after finalization when continuing to next cycle.
   */
  cycleNormalizedUsage: NormalizedUsageSchema.optional(),
});

/** Tool-use cycle fields derived from schema */
export type ToolUseCycleFields = z.infer<typeof ToolUseCycleFieldsSchema>;

/**
 * Reset tool-use cycle state for a new iteration.
 * Called at the start of each cycle to clear transient fields.
 */
function resetToolUseState(shared: ToolUseCycleShared): void {
  resetCycleState(shared, []);
  shared.response = undefined;
  shared.toolCalls = undefined;
  shared.text = undefined;
  // Reset cycle metrics for next cycle
  shared.cycleResponseTimeMs = 0;
  shared.cycleNormalizedUsage = undefined;
  // Note: cycleIndex is incremented, not reset
  // Note: endTurn is reset by resetCycleState (part of base fields)
}

/**
 * Shared state for tool-use cycle flows.
 *
 * Uses flat structure (like ResponseCycleFlow) for consistency.
 * All fields from ToolUseCycleFieldsSchema plus runtime-only toolCalls typing.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface) - flat, no nested wrappers
 * - Immutable services: `this.services` (ToolUseCycleServices)
 */
export interface ToolUseCycleShared extends ToolUseCycleFields {
  /** Tool calls with proper typing (schema uses z.unknown()) */
  toolCalls?: SdkToolCall[];
  /** Normalized usage with proper typing */
  cycleNormalizedUsage?: NormalizedUsage;
}

/**
 * Prepares a tool-use cycle by checking interruptions.
 *
 * Services accessed via `this.services` (ToolUseCycleServices).
 * All debug options are derived at maybeSaveDebugObject call sites.
 */
class ToolUsePrepNode<C> extends BaseNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  async prep(shared: ToolUseCycleShared): Promise<{ interrupted: boolean }> {
    const interrupted = Boolean(await this.services.checkInterruption());
    return { interrupted };
  }

  async post(
    shared: ToolUseCycleShared,
    prepRes: { interrupted: boolean },
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      shared.shouldStop = true;
      shared.endTurn = false; // Interrupted, not a normal completion
      return FlowTransition.COMPLETE;
    }

    // Reset at the start of each cycle so downstream nodes observe a clean
    // runtime state before enriching it with model responses.
    resetToolUseState(shared);

    const { modelName, agentName } = this.services;
    await maybeSaveDebugObject({
      object: shared.messages,
      objectType: 'messages',
      context: getDebugContext(this.services, {
        modelName,
        isRemote: isRemoteAgent(agentName),
      }),
      fileOptions: {
        continuationCount: shared.cycleIndex,
        baseName: 'tooluse',
      },
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Success data for tool-use call.
 * All debug options are derived at maybeSaveDebugObject call sites.
 */
type ToolUseCallSuccessData = BaseInvocationSuccessData;

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
  async prep(shared: ToolUseCycleShared): Promise<BaseInvocationPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      messages: shared.messages,
    };
  }

  async exec(prepRes: BaseInvocationPrepResult): Promise<ToolUseCallResult> {
    const services = this.services;

    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    const start = Date.now();

    // Use base class helper for abort controller lifecycle
    return this.withAbortController(async (signal) => {
      services.modelHandler.setOutputStreaming(true);
      const response = await services.modelHandler.createResponse({
        client: services.client,
        messages: prepRes.messages,
        temperature: services.setting.temperature ?? 0,
        signal,
        tools: services.setting.tools as ToolDefinition[] | undefined,
      });

      const responseTimeMs = Date.now() - start;

      return { kind: 'success', response, responseTimeMs };
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

    // Handle non-success cases (returns null) or get narrowed success result
    // Pass shared directly since it's now flat (has shouldStop, endTurn, lastError)
    const successRes = handleInvocationResult(
      execRes,
      shared,
      { lastError: shared.lastError },
      {
        logger: services.logger,
        operationName: this.getOperationName(),
      },
    );

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    // Apply success-specific side effects
    shared.response = successRes.response;
    shared.responseTimeMs = successRes.responseTimeMs;

    const { modelName, agentName } = services;
    await maybeSaveDebugObject({
      object: successRes.response,
      objectType: 'response',
      context: getDebugContext(services, {
        modelName,
        isRemote: isRemoteAgent(agentName),
      }),
      fileOptions: {
        continuationCount: shared.cycleIndex,
        baseName: 'tooluse_response',
      },
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
  | { kind: 'skipped' }
  | {
      kind: 'success';
      toolCalls?: SdkToolCall[];
      stopReason?: ProviderStopReason;
      text?: string;
      endTurn: boolean;
      serverToolContentBlocks?: ServerToolContentBlock[];
      lastAssistantContent?: unknown[];
      normalizedUsage?: NormalizedUsage;
      responseTimeMs?: number;
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
    return {
      shouldStop: shared.shouldStop,
      response: shared.response,
      responseTimeMs: shared.responseTimeMs,
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
      return { kind: 'skipped' };
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
      const formatted = await formatContent(thinking);
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
        const formatted = await formatContent(text);
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

    if (execRes.kind === 'skipped') {
      return FlowTransition.COMPLETE;
    }

    // Apply side effects: server tool content
    workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    // Accumulate cycle metrics in shared (flat pattern)
    if (execRes.responseTimeMs !== undefined) {
      shared.cycleResponseTimeMs += execRes.responseTimeMs;
    }
    if (execRes.normalizedUsage) {
      shared.cycleNormalizedUsage = execRes.normalizedUsage;
    }

    // Finalize cycle using direct values (no round object needed)
    await finalizeToolUseCycle({
      cycleIndex: shared.cycleIndex,
      responseTimeMs: shared.cycleResponseTimeMs,
      normalizedUsage: shared.cycleNormalizedUsage ?? null,
      run,
      onRoundFinalized,
    });
    run.incrementRounds();

    if (execRes.endTurn) {
      // Apply side effects for end turn
      shared.toolCalls = undefined;
      if (execRes.createAssistantMessage && execRes.text) {
        shared.messages.push(
          services.modelHandler.createAssistantMessage(execRes.text),
        );
        workspace.assembly.lastResponse = execRes.text;
      }
      // Clear ephemeral state
      workspace.resetServerToolContent();
      workspace.resetReasoning();
      shared.shouldStop = true;
      shared.endTurn = true; // Normal completion (model said end_turn)
      shared.stopReason = execRes.stopReason;
      return FlowTransition.COMPLETE;
    }

    // Apply side effects for continuing with tool calls
    shared.toolCalls = execRes.toolCalls;
    shared.text = execRes.text;
    shared.stopReason = execRes.stopReason;
    // Increment cycle index and reset metrics for next cycle
    shared.cycleIndex += 1;
    shared.cycleResponseTimeMs = 0;
    shared.cycleNormalizedUsage = undefined;

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
 * PocketFlow compliance: exec() executes tools and returns results, post() applies side effects.
 */
type ToolUseDispatchExecResult =
  | { kind: 'skipped'; interrupted: boolean }
  | {
      kind: 'success';
      execResults: ToolExecutionResult[];
      assistantText: string;
    };

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
    const toolCalls = shared.toolCalls ?? [];

    // Check skip conditions (including interruption) in prep
    const shouldSkip = shared.shouldStop || toolCalls.length === 0;
    const interrupted = shouldSkip
      ? false
      : Boolean(await services.checkInterruption());

    return {
      shouldSkip,
      interrupted,
      toolCalls,
      text: shared.text,
    };
  }

  /**
   * Execute all tool calls and return results.
   *
   * PocketFlow compliance:
   * - exec() executes tools using services (tracker/todos are service state, not shared state)
   * - Tool execution is I/O but acceptable since this node uses NODE_NO_RETRY
   * - Results are returned for post() to apply side effects (logging, messages)
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

    const services = this.services;
    const { workspace } = services;
    const tracker = workspace.interactions;
    const todoState = workspace.todos;
    const assistantText = prepRes.text ?? '';

    // Execute all tool calls and collect results
    const execResults: ToolExecutionResult[] = [];
    for (const call of prepRes.toolCalls) {
      const execResult = await this.executeToolCall(
        call,
        services,
        tracker,
        todoState,
      );
      execResults.push(execResult);
    }

    return {
      kind: 'success',
      execResults,
      assistantText,
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
      result = {
        error: `Unknown tool ${call.name}`,
        isError: true,
      };
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
          () => tool.call(parsedInput),
        );
      } catch (err) {
        const { message, diagnostics } = normalizeToolCallError(call.name, err);
        result = {
          error: message,
          isError: true,
          diagnostics,
        };
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
   * Apply side effects from tool execution.
   *
   * PocketFlow compliance:
   * - post() logs results, processes media files, and creates follow-up messages
   * - All shared state mutations happen here
   */
  async post(
    shared: ToolUseCycleShared,
    _prepRes: ToolUseDispatchPrepResult,
    execRes: ToolUseDispatchExecResult,
  ): Promise<string | undefined> {
    const services = this.services;
    const { workspace } = services;
    const groupId = services.logger.withCurrentGroup((id) => id);

    if (execRes.kind === 'skipped') {
      if (execRes.interrupted) {
        shared.shouldStop = true;
      }
      return FlowTransition.COMPLETE;
    }

    const { execResults, assistantText } = execRes;

    // Step 1: Log each tool execution and process media files
    for (const execResult of execResults) {
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

    // Extract calls from results for message creation
    const calls = execResults.map((er) => er.call);

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
      shared.messages.push(...followUpMsgs);
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
        shared.messages.push(...followUpMsgs);
      }
    }

    // Step 3: Handle user instructions from tool results
    for (const execResult of execResults) {
      if (isNonEmptyString(execResult.result.userInstruction)) {
        await services.modelHandler.createUserFollowUpMessages(
          shared.messages,
          execResult.result.userInstruction,
        );
      }
    }

    shared.toolCalls = [];

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

  // COMPLETE transitions exit directly (no finalize node needed).
  // Unlike ResponseCycleFlow which needs finalizeRound() for stats recording,
  // ToolUseCycleFlow handles finalization inline in ProcessNode.post() for
  // successful cycles. Error/interrupt paths don't need finalization since
  // there's nothing to record.

  return new Flow<ToolUseCycleShared, ToolUseCycleParams<C>>(prepNode);
}
