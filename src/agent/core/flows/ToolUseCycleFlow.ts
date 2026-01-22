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
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

// Local imports - utilities
import { toErrorMessage } from '@common/errors';
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
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  type ValidationErrorDiagnostics,
} from '@tools/result';
import { AbsoluteFS, pathToLocation, type FileLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import { formatContent } from '@utils/text/xmlUtils';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  type RetryState,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';
import type {
  ToolUseCycleOptions,
  ToolUseCycleServices,
  ToolUseCycleParams,
} from './CycleServices';

/** Parse tool input, handling JSON strings and other formats from model providers. */
function parseToolInput(
  raw: unknown,
  callId: string,
  logger: AgentLogger,
): unknown {
  if (raw == null) {
    logger.warn(`Tool call ${callId}: Received null input, using empty object`);
    return {};
  }

  if (typeof raw !== 'string') {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    logger.warn(
      `Tool call ${callId}: Failed to parse input as JSON, using raw string`,
    );
    return raw;
  }
}

/** Check if an error has Zod-like issues array (duck typing). */
function hasZodIssues(
  error: unknown,
): error is { issues: Array<{ path: (string | number)[]; message: string }> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/** Result of normalizing a tool call error. */
interface NormalizedToolError {
  message: string;
  diagnostics?: ValidationErrorDiagnostics;
  /** Original error preserved for debugging/logging. */
  cause?: unknown;
}

/** Normalize a tool call error into a user-friendly message with optional diagnostics. */
function normalizeToolCallError(
  toolName: string,
  error: unknown,
): NormalizedToolError {
  if (!hasZodIssues(error)) {
    return {
      message: `${toolName}: ${toErrorMessage(error)}`,
      cause: error,
    };
  }

  const issues = error.issues as ValidationErrorDiagnostics['issues'];
  return {
    message: `${toolName}: Invalid parameters provided`,
    diagnostics: {
      type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
      issues,
      formatted: formatZodIssuesForDiagnostics(issues),
    },
    cause: error,
  };
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

/** Prepares a tool-use cycle by checking interruptions. */
class ToolUsePrepNode<C> extends BaseNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  async prep(shared: ToolUseCycleShared): Promise<{ interrupted: boolean }> {
    const interrupted = this.services.checkInterruption();
    return { interrupted };
  }

  async post(
    shared: ToolUseCycleShared,
    prepRes: { interrupted: boolean },
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      shared.shouldStop = true;
      shared.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    resetCycleState(shared, [
      'response',
      'toolCalls',
      'text',
      'cycleNormalizedUsage',
    ]);
    shared.cycleResponseTimeMs = 0;

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

/** Success data for tool-use call. */
type ToolUseCallSuccessData = BaseInvocationSuccessData;

/** Result type for tool-use call. */
type ToolUseCallResult = InvocationResult<ToolUseCallSuccessData>;

/**
 * Handles model invocation for tool-use cycles with PocketFlow's built-in retry.
 * Uses RetryableInvocationNode for automatic retry logic with user prompts.
 */
class ToolUseCallNode<C> extends RetryableInvocationNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  protected getOperationName(): string {
    return 'Tool-use call';
  }

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
  }

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

/** Data extracted by prep() for tool-use process. */
interface ToolUseProcessPrepResult {
  shouldStop: boolean;
  response?: unknown;
  responseTimeMs?: number;
}

/** Result of exec() containing extracted data needed for post() side effects. */
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
    };

/** Processes the model response to extract tool calls and usage data. */
class ToolUseProcessNode<C> extends BaseNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  async prep(shared: ToolUseCycleShared): Promise<ToolUseProcessPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      response: shared.response,
      responseTimeMs: shared.responseTimeMs,
    };
  }

  async exec(
    prepRes: ToolUseProcessPrepResult,
  ): Promise<ToolUseProcessExecResult> {
    if (prepRes.shouldStop || !prepRes.response) {
      return { kind: 'skipped' };
    }

    const services = this.services;
    const { workspace } = services;

    const thinking = services.modelHandler.processThinkingBlock(
      prepRes.response,
      workspace,
    );
    const useStreaming = services.modelHandler.getStreamingConfig();
    if (thinking && !useStreaming) {
      const formatted = await formatContent(thinking);
      if (isNonEmptyString(formatted)) {
        services.logger.info(formatted, {
          messageType: MESSAGE_TYPES.THINKING,
        });
      }
    }

    const toolCalls = services.modelHandler.extractToolUse(prepRes.response);
    const {
      response: text,
      usage,
      stopReason,
    } = services.modelHandler.extractResponse(prepRes.response, '');

    const serverToolData = services.modelHandler.extractServerToolData(
      prepRes.response,
    );

    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        services.logger.logWebSearch(searchResult);
      }
    }

    const lastAssistantContent = services.modelHandler.extractAssistantContent(
      prepRes.response,
    );

    if (text) {
      services.logger.debug(`Model response: ${text.slice(0, 100)}`);
      if (!useStreaming) {
        const formatted = await formatContent(text);
        services.logger.info(formatted, {
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        });
      }
    }

    let normalizedUsage: NormalizedUsage | undefined;
    if (usage) {
      normalizedUsage = services.modelHandler.normalizeUsage(
        usage,
        prepRes.responseTimeMs ?? 0,
      );
      const { inputTokens } = normalizedUsage;
      const { contextWindow } = services.modelHandler.config;
      if (inputTokens > 0 && contextWindow > 0) {
        services.logger.logContextState(inputTokens, contextWindow);
      }
    }

    const endTurn =
      services.modelHandler.isEndTurnStop(stopReason) ||
      !toolCalls ||
      toolCalls.length === 0;

    return {
      kind: 'success',
      toolCalls: endTurn ? undefined : toolCalls,
      stopReason,
      text: text ?? undefined,
      endTurn,
      serverToolContentBlocks: serverToolData.contentBlocks,
      lastAssistantContent,
      normalizedUsage,
      responseTimeMs: prepRes.responseTimeMs,
    };
  }

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

    workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    if (execRes.responseTimeMs !== undefined) {
      shared.cycleResponseTimeMs += execRes.responseTimeMs;
    }
    if (execRes.normalizedUsage) {
      shared.cycleNormalizedUsage = execRes.normalizedUsage;
    }

    run.recordCycleMetrics(
      shared.cycleIndex,
      shared.cycleResponseTimeMs,
      shared.cycleNormalizedUsage ?? null,
    );
    if (onRoundFinalized) {
      await onRoundFinalized(run);
    }
    run.incrementRounds();

    shared.stopReason = execRes.stopReason;

    if (execRes.endTurn) {
      shared.toolCalls = undefined;
      shared.shouldStop = true;
      shared.endTurn = true;
      if (execRes.text) {
        shared.messages.push(
          services.modelHandler.createAssistantMessage(execRes.text),
        );
        workspace.assembly.lastResponse = execRes.text;
      }
      workspace.resetServerToolContent();
      workspace.resetReasoning();
      return FlowTransition.COMPLETE;
    }

    shared.toolCalls = execRes.toolCalls;
    shared.text = execRes.text;
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

/** Data extracted by prep() for tool dispatch. */
interface ToolUseDispatchPrepResult {
  shouldSkip: boolean;
  interrupted: boolean;
  toolCalls: SdkToolCall[];
  text?: string;
}

/** Result of exec() for tool dispatch. */
type ToolUseDispatchExecResult =
  | { kind: 'skipped'; interrupted: boolean }
  | {
      kind: 'success';
      execResults: ToolExecutionResult[];
      assistantText: string;
    };

/**
 * Dispatches tool calls and processes their results.
 * Batches multiple parallel calls for Google/DeepSeek handlers to preserve thought signatures.
 */
class ToolUseDispatchNode<C> extends BaseNode<
  ToolUseCycleShared,
  ToolUseCycleParams<C>,
  ToolUseCycleServices<C>
> {
  async prep(shared: ToolUseCycleShared): Promise<ToolUseDispatchPrepResult> {
    const services = this.services;
    const toolCalls = shared.toolCalls ?? [];

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

    const execResults: ToolExecutionResult[] = [];
    for (const call of prepRes.toolCalls) {
      if (services.checkInterruption()) {
        break;
      }
      const execResult = await this.executeToolCall(
        call,
        services,
        tracker,
        todoState,
      );
      execResults.push(execResult);
    }

    if (execResults.length === 0 && services.checkInterruption()) {
      return { kind: 'skipped', interrupted: true };
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
            streamId: options.logger.streamId,
            executionId: options.executionId,
            toolCallId: call.callId,
          },
          () => tool.call(parsedInput),
        );
      } catch (err) {
        const { message, diagnostics, cause } = normalizeToolCallError(
          call.name,
          err,
        );
        // Include cause in diagnostics for debugging/logging while keeping
        // structured validation info when available
        const enrichedDiagnostics = diagnostics ?? { cause };
        result = {
          error: message,
          isError: true,
          diagnostics: enrichedDiagnostics,
        };
      }
    }

    const trackedEdits = tracker.recordEdits(result.edits);
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

  private async logAndProcessMediaFiles(
    execResult: ToolExecutionResult,
    options: ToolUseCycleOptions<C>,
    workspace: ToolUseCycleServices<C>['workspace'],
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
    options.logger.logToolUse(toolUseLog);

    const mediaLocations = await this.collectValidMediaLocations(
      result.files,
      options.logger,
    );
    if (mediaLocations.length > 0) {
      workspace.media.addMediaFiles(mediaLocations);
    }
  }

  /** Collect valid file locations from tool result attachments. */
  private async collectValidMediaLocations(
    files: ToolResult['files'],
    logger: AgentLogger,
  ): Promise<FileLocation[]> {
    if (!files || files.length === 0) {
      return [];
    }

    const validLocations: FileLocation[] = [];
    for (const attachment of files) {
      const filePath = attachment.path;
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        continue;
      }
      const location = pathToLocation(filePath);
      try {
        if (await AbsoluteFS.exists(location.absolutePath)) {
          validLocations.push(location);
        }
      } catch (err) {
        logger.debug(
          `Skipping inaccessible media file: ${filePath} (${err instanceof Error ? err.message : 'unknown error'})`,
        );
      }
    }
    return validLocations;
  }

  async post(
    shared: ToolUseCycleShared,
    _prepRes: ToolUseDispatchPrepResult,
    execRes: ToolUseDispatchExecResult,
  ): Promise<string | undefined> {
    const services = this.services;
    const { workspace } = services;

    if (execRes.kind === 'skipped') {
      if (execRes.interrupted) {
        shared.shouldStop = true;
      }
      return FlowTransition.COMPLETE;
    }

    const { execResults, assistantText } = execRes;

    for (const execResult of execResults) {
      await this.logAndProcessMediaFiles(execResult, services, workspace);
    }

    const extracted = execResults.map((er) =>
      extractToolAttachments(er.result),
    );
    const calls = execResults.map((er) => er.call);

    // For Google/DeepSeek handlers with multiple parallel calls, batch all tool calls
    // into a single message to preserve thought signatures.
    const shouldBatch =
      calls.length > 1 &&
      (services.modelHandler.isGoogle || services.modelHandler.isDeepSeek) &&
      !!services.modelHandler.createBatchedToolUseFollowUpMessages;

    if (shouldBatch) {
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
/** Creates a tool-use cycle flow with services injected via params. */
export function createToolUseCycleFlow<C>(): Flow<
  ToolUseCycleShared,
  ToolUseCycleParams<C>
> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ToolUseCallNode<C>();
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleShared, ToolUseCycleParams<C>>(prepNode);
}
