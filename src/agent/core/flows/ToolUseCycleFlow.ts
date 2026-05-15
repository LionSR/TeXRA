// Third-party imports
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';

// Local imports - core flow primitives
import { isRemoteAgent } from '@agent/index';
import { BaseNode, BatchNode, Flow, Node } from '@agent/node';
import { recordCycleMetrics } from '@agent/core/AgentState';
import {
  BaseCycleFieldsSchema,
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
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';

// Internal imports - use core ToolTypes as single source of truth
import {
  extractToolAttachments,
  type ExtractedToolAttachments,
} from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/AgentWorkspaceState';
import type { ToolResult } from '@agent/core/ToolTypes';
import { getActiveChildren } from '@agent/runtime/executionRegistry';
import { toErrorMessage } from '@common/errors';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@shared/schemas';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  type ValidationErrorDiagnostics,
} from '@tools/result';
import { formatPostCompactionContext } from '@tools/subagentResults';
import { AbsoluteFS, pathToLocation, type FileLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import { formatContent } from '@utils/text/xmlUtils';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import { ModelInvocationNode } from './ModelInvocationNode';
import type { CycleParams, ToolUseCycleServices } from './CycleServices';

// ============================================================================
// Parallel call deduplication
// ============================================================================

const DUPLICATE_CALL_ERROR =
  'Duplicate parallel call skipped — same tool name and arguments as an earlier call in this batch. ' +
  'To run identical calls, invoke them sequentially in separate responses.';

/**
 * Identify duplicate parallel tool calls (same name + identical arguments).
 * Returns the set of `callId`s that should be skipped (all but the first
 * occurrence of each unique call signature).
 */
function findDuplicateCallIds(toolCalls: SdkToolCall[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const call of toolCalls) {
    const key = call.name + '\0' + stableStringify(call.input);
    if (seen.has(key)) {
      duplicates.add(call.callId);
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

// ============================================================================
// Tool input parsing and error handling
// ============================================================================

/** Parse tool input, handling JSON strings and other formats from model providers. */
function parseToolInput(
  raw: unknown,
  callId: string,
  logger: AgentLogger,
): unknown {
  if (raw == null) {
    logger.debug(
      `Tool call ${callId}: Received null input, using empty object`,
    );
    return {};
  }

  if (typeof raw !== 'string') {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    logger.debug(
      `Tool call ${callId}: Failed to parse input as JSON, using raw string`,
    );
    return raw;
  }
}

/** Normalize a tool call error into a user-friendly message with optional diagnostics. */
function normalizeToolCallError(
  toolName: string,
  error: unknown,
): { message: string; diagnostics?: ValidationErrorDiagnostics } {
  if (!(error instanceof z.ZodError)) {
    return { message: `${toolName}: ${toErrorMessage(error)}` };
  }

  return {
    message: `${toolName}: Invalid parameters provided`,
    diagnostics: {
      type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
      issues: error.issues,
      formatted: formatZodIssuesForDiagnostics(error.issues),
    },
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
  cycleIndex: z.int().nonnegative(),
  /**
   * Accumulated response time for current cycle (milliseconds).
   * Reset after finalization when continuing to next cycle.
   */
  cycleResponseTimeMs: z.number().nonnegative(),
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

/**
 * Prepares a tool-use cycle by checking interruptions and injecting queued follow-ups.
 *
 * If there are queued user messages (typed during previous tool execution),
 * they are injected here BEFORE calling the model. This ensures the model's
 * thinking/response considers the user's feedback.
 */
class ToolUsePrepNode<C> extends BaseNode<
  ToolUseCycleShared,
  CycleParams,
  ToolUseCycleServices<C>
> {
  async prep(
    _shared: ToolUseCycleShared,
  ): Promise<{ interrupted: boolean; queuedFollowUp: string | null }> {
    const interrupted = this.services.checkInterruption();

    if (!this.services.session?.hasQueuedFollowUp()) {
      return { interrupted, queuedFollowUp: null };
    }

    // Drain without waiting (we know there's something queued)
    const items = await this.services.session.waitForFollowUp(() => false);
    return { interrupted, queuedFollowUp: items?.join('\n\n') ?? null };
  }

  async post(
    shared: ToolUseCycleShared,
    prepRes: { interrupted: boolean; queuedFollowUp: string | null },
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      shared.shouldStop = true;
      shared.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    // Inject queued follow-up BEFORE the model call
    // This ensures user's message typed during tool execution is seen
    // before the model starts thinking/responding
    if (prepRes.queuedFollowUp) {
      this.services.logger.userMessage(prepRes.queuedFollowUp);
      shared.messages =
        await this.services.modelHandler.createUserFollowUpMessages(
          shared.messages,
          prepRes.queuedFollowUp,
        );
      this.services.onFollowUpConsumed?.();
    }

    resetCycleState(shared, [
      'response',
      'toolCalls',
      'text',
      'cycleNormalizedUsage',
    ]);
    shared.cycleResponseTimeMs = 0;

    const { config } = this.services;
    await maybeSaveDebugObject({
      object: shared.messages,
      objectType: 'messages',
      context: getDebugContext(this.services, {
        modelName: config.model,
        isRemote: isRemoteAgent(config.agent),
      }),
      fileOptions: {
        continuationCount: shared.cycleIndex,
        baseName: 'tooluse',
      },
    });

    return FlowTransition.DEFAULT;
  }
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
    };

/** Prep result for ToolUseProcessNode - captures shared state snapshot for exec. */
interface ToolUseProcessPrepResult {
  shouldStop: boolean;
  response?: unknown;
  responseTimeMs?: number;
}

/** Processes the model response to extract tool calls and usage data. */
class ToolUseProcessNode<C> extends BaseNode<
  ToolUseCycleShared,
  CycleParams,
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
    const { text, usage, stopReason } = services.modelHandler.extractResponse(
      prepRes.response,
      '',
    );

    const serverToolData = services.modelHandler.extractServerToolData(
      prepRes.response,
    );

    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        services.logger.logWebSearch(searchResult);
      }
      for (const fetchResult of serverToolData.webFetchResults) {
        services.logger.logWebFetch(fetchResult);
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
      const contextWindow = services.modelHandler.getEffectiveContextWindow();
      if (inputTokens > 0 && contextWindow > 0) {
        services.logger.logContextState(inputTokens, contextWindow);
      }
    }

    const endTurn =
      services.modelHandler.isEndTurnStop(stopReason) || !toolCalls?.length;

    return {
      kind: 'success',
      toolCalls: endTurn ? undefined : toolCalls,
      stopReason,
      text: text ?? undefined,
      endTurn,
      serverToolContentBlocks: serverToolData.contentBlocks,
      lastAssistantContent,
      normalizedUsage,
    };
  }

  async post(
    shared: ToolUseCycleShared,
    prepRes: ToolUseProcessPrepResult,
    execRes: ToolUseProcessExecResult,
  ): Promise<string | undefined> {
    const { run, workspace, onRoundFinalized, modelHandler } = this.services;

    if (execRes.kind === 'skipped') {
      return FlowTransition.COMPLETE;
    }

    workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    if (shared.responseTimeMs != null) {
      shared.cycleResponseTimeMs += shared.responseTimeMs;
    }
    if (execRes.normalizedUsage) {
      shared.cycleNormalizedUsage = execRes.normalizedUsage;
    }

    recordCycleMetrics(
      run,
      shared.cycleIndex,
      shared.cycleResponseTimeMs,
      shared.cycleNormalizedUsage ?? null,
    );
    await onRoundFinalized?.(run);
    run.totalRounds += 1;

    shared.stopReason = execRes.stopReason;

    if (execRes.endTurn) {
      shared.toolCalls = undefined;
      shared.shouldStop = true;
      shared.endTurn = true;
      if (execRes.text) {
        shared.messages.push(
          modelHandler.createAssistantMessageFromResponse(
            prepRes.response,
            execRes.text,
          ),
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

/** Tools that may take a while and benefit from showing in-progress state. */
const SLOW_TOOLS = new Set([
  'bash',
  'wolfram',
  'web_fetch',
  'web_search',
  'executions',
]);

/** Tools that defer in-progress logging until after approval. */
const DEFERRED_LOG_TOOLS = new Set(['bash', 'codex']);

/** Tools that support streaming partial output to the UI. */
const STREAMABLE_TOOLS = new Set(['bash']);

/** Maximum size of the streaming output buffer sent to the UI (bytes). */
const STREAM_BUFFER_MAX = 50_000;

/**
 * Result of executing a single tool call, capturing everything needed
 * for logging and message creation.
 */
interface ToolExecutionResult {
  call: SdkToolCall;
  result: ToolResult;
  parsedInput: unknown;
  /** Pre-extracted attachments and sanitized result (avoids re-extraction in post). */
  extracted: ExtractedToolAttachments;
  editedFiles: Array<{
    path: string;
    ok: boolean;
    source: string;
    sourceDisplay: string;
  }>;
  /** Log reference for consistent grouping. logId only set for slow tools. */
  logRef: { logId: string | undefined; groupId: string | undefined };
}

/**
 * Dispatches tool calls sequentially.
 *
 * Sequential dispatch preserves ordering guarantees when tools have
 * dependencies (e.g., read file then edit file). The inquiry tool used
 * to need a concurrency carve-out because it blocked on a human round-
 * trip; it now returns synchronously, so the default sequential path
 * is sufficient.
 *
 * Batches follow-up messages for Google/DeepSeek handlers to preserve thought signatures.
 */
class ToolUseDispatchNode<C> extends BatchNode<
  ToolUseCycleShared,
  CycleParams,
  ToolUseCycleServices<C>
> {
  /**
   * Call IDs of duplicate parallel calls detected during prep().
   * These are skipped during exec() and receive a synthetic error result
   * instructing the model to call them sequentially instead.
   */
  private _duplicateCallIds = new Set<string>();

  /** Returns tool calls to execute, or empty array if skipped/interrupted. */
  async prep(shared: ToolUseCycleShared): Promise<SdkToolCall[]> {
    this._duplicateCallIds.clear();
    const toolCalls = shared.toolCalls ?? [];

    if (shared.shouldStop || toolCalls.length === 0) {
      return [];
    }

    if (this.services.checkInterruption()) {
      shared.shouldStop = true;
      return [];
    }

    // Deduplicate parallel calls: when multiple calls have the same tool name
    // and identical arguments, only execute the first one. Later duplicates
    // receive a synthetic error result prompting sequential invocation.
    if (toolCalls.length > 1) {
      this._duplicateCallIds = findDuplicateCallIds(toolCalls);

      if (this._duplicateCallIds.size > 0) {
        const dupNames = [
          ...new Set(
            toolCalls
              .filter((c) => this._duplicateCallIds.has(c.callId))
              .map((c) => c.name),
          ),
        ];
        this.services.logger.debug(
          `Deduplicated ${this._duplicateCallIds.size} parallel tool call(s) ` +
            `with identical name and arguments: ${dupNames.join(', ')}`,
        );
      }
    }

    return toolCalls;
  }

  /** Execute a single tool call, returning null if interrupted. */
  async exec(call: SdkToolCall): Promise<ToolExecutionResult | null> {
    if (this.services.checkInterruption()) {
      return null;
    }

    // Skip duplicate parallel calls — return a synthetic error result so
    // the model is informed and can retry sequentially if needed.
    if (this._duplicateCallIds.has(call.callId)) {
      return {
        call,
        result: { error: DUPLICATE_CALL_ERROR, isError: true as const },
        parsedInput: call.input,
        extracted: {
          sanitizedResult: { error: DUPLICATE_CALL_ERROR },
          attachments: [],
        },
        editedFiles: [],
        logRef: {
          logId: undefined,
          groupId: this.services.logger.resolveActiveGroupId(),
        },
      };
    }

    const { workspace } = this.services;
    workspace.interactions.recordToolCall();

    return this.executeToolCall(
      call,
      this.services,
      workspace.interactions,
      workspace.workPlan,
    );
  }

  clone(): this {
    const cloned = super.clone();
    cloned._duplicateCallIds = new Set();
    return cloned;
  }

  /** Invoke a tool with error handling, returning an error result if the tool is missing. */
  private async invokeToolSafely(
    call: SdkToolCall,
    tool: { call(input: unknown): Promise<ToolResult> } | undefined,
    parsedInput: unknown,
    options: ToolUseCycleServices<C>,
    tracker: FileInteractionState,
    workPlanState: WorkPlanState,
    onExecutionReady?: () => void,
    onToolOutput?: (chunk: string) => void,
  ): Promise<ToolResult> {
    if (!tool) {
      return { error: `Unknown tool ${call.name}`, isError: true };
    }

    try {
      return await withToolFileInteractionContext(
        {
          tracker,
          workPlanState,
          toolCallId: call.callId,
          onExecutionReady,
          onToolOutput,
        },
        () => tool.call(parsedInput),
      );
    } catch (err) {
      const { message, diagnostics } = normalizeToolCallError(call.name, err);
      return { error: message, isError: true, diagnostics };
    }
  }

  /** Execute a single tool call and return the result with metadata. */
  private async executeToolCall(
    call: SdkToolCall,
    options: ToolUseCycleServices<C>,
    tracker: FileInteractionState,
    workPlanState: WorkPlanState,
  ): Promise<ToolExecutionResult> {
    const parsedInput = parseToolInput(call.input, call.callId, options.logger);
    const tool = options.toolRegistry.get(call.name);
    const isDeferred = DEFERRED_LOG_TOOLS.has(call.name);

    // Capture groupId at start. For deferred tools, delay logging until onExecutionReady.
    const logRef: ToolExecutionResult['logRef'] =
      SLOW_TOOLS.has(call.name) && !isDeferred
        ? options.logger.logToolUseStart(call.name, parsedInput ?? call.raw)
        : { logId: undefined, groupId: options.logger.resolveActiveGroupId() };

    const onExecutionReady = isDeferred
      ? () => {
          if (!logRef.logId) {
            const ref = options.logger.logToolUseStart(
              call.name,
              parsedInput ?? call.raw,
              logRef.groupId,
            );
            logRef.logId = ref.logId;
          }
        }
      : undefined;

    // Build streaming callback for tools that support it.
    // Keeps a rolling tail buffer (max STREAM_BUFFER_MAX) to bound memory.
    let onToolOutput: ((chunk: string) => void) | undefined;
    if (STREAMABLE_TOOLS.has(call.name)) {
      let outputBuffer = '';
      onToolOutput = (chunk: string) => {
        outputBuffer += chunk;
        // Cap buffer to last STREAM_BUFFER_MAX chars to prevent unbounded growth
        if (outputBuffer.length > STREAM_BUFFER_MAX) {
          outputBuffer = outputBuffer.slice(-STREAM_BUFFER_MAX);
        }
        if (!logRef.logId) return;
        options.logger.updateToolUse(
          logRef.logId,
          {
            toolName: call.name,
            input: parsedInput ?? call.raw,
            output: outputBuffer,
          },
          logRef.groupId,
          'in_progress',
        );
      };
    }

    const result = await this.invokeToolSafely(
      call,
      tool,
      parsedInput,
      options,
      tracker,
      workPlanState,
      onExecutionReady,
      onToolOutput,
    );

    const trackedEdits = tracker.recordEdits(result.edits);
    if (!result.lineChanges && trackedEdits.lineChanges) {
      result.lineChanges = trackedEdits.lineChanges;
    }

    const extracted = extractToolAttachments(result);
    const editedFiles = trackedEdits.edits.map((entry) => ({
      path: entry.path,
      ok: true,
      source: 'tool',
      sourceDisplay: 'Tool use',
    }));

    return {
      call,
      result,
      parsedInput,
      extracted,
      editedFiles,
      logRef,
    };
  }

  private async logAndProcessMediaFiles(
    execResult: ToolExecutionResult,
  ): Promise<void> {
    const { call, result, parsedInput, extracted, editedFiles, logRef } =
      execResult;
    const options = this.services;
    const { workspace } = options;

    // Spread sanitizedResult so editedFiles in the log don't leak into
    // extracted.sanitizedResult (which is reused for model messages in post).
    const logOutput = editedFiles.length
      ? { ...extracted.sanitizedResult, editedFiles }
      : extracted.sanitizedResult;

    const toolUseLog = {
      toolName: call.name,
      input: parsedInput ?? call.raw,
      output: logOutput,
      ...(editedFiles.length && { files: editedFiles }),
      isError: Boolean(result.isError),
    };

    // Update in-progress log (slow tools) or create new log (fast tools)
    // Both use the groupId captured at execution start for consistency
    if (logRef.logId) {
      options.logger.updateToolUse(logRef.logId, toolUseLog, logRef.groupId);
    } else {
      options.logger.logToolUse(
        { ...toolUseLog, status: 'completed' },
        logRef.groupId,
      );
    }

    // Collect and add valid media file locations
    if (result.files?.length) {
      const validLocations: FileLocation[] = [];
      for (const attachment of result.files) {
        if (!isNonEmptyString(attachment.path)) {
          continue;
        }
        const location = pathToLocation(attachment.path);
        try {
          if (await AbsoluteFS.exists(location.absolutePath)) {
            validLocations.push(location);
          }
        } catch (err) {
          options.logger.debug(
            `Skipping inaccessible media file: ${attachment.path} (${err instanceof Error ? err.message : 'unknown error'})`,
          );
        }
      }
      if (validLocations.length) {
        workspace.media.addMediaFiles(validLocations);
      }
    }
  }

  /** Process tool execution results and create follow-up messages. */
  async post(
    shared: ToolUseCycleShared,
    _toolCalls: SdkToolCall[],
    execResults: (ToolExecutionResult | null)[],
  ): Promise<string | undefined> {
    const { workspace } = this.services;

    const completedResults = execResults.filter(
      (r): r is ToolExecutionResult => r !== null,
    );

    if (completedResults.length < execResults.length) {
      shared.shouldStop = true;
    }
    if (!completedResults.length) {
      return FlowTransition.COMPLETE;
    }

    const assistantText = shared.text ?? '';

    for (const execResult of completedResults) {
      await this.logAndProcessMediaFiles(execResult);
    }

    const extracted = completedResults.map((er) => er.extracted);
    const calls = completedResults.map((er) => er.call);

    // For Google/DeepSeek/Kimi handlers with multiple parallel calls, batch all tool calls
    // into a single message to preserve thought signatures / reasoning_content.
    const { modelHandler } = this.services;
    const shouldBatch =
      calls.length > 1 &&
      (modelHandler.isGoogle ||
        modelHandler.isDeepSeek ||
        modelHandler.isKimi ||
        modelHandler.isMiniMax) &&
      !!modelHandler.createBatchedToolUseFollowUpMessages;

    if (shouldBatch) {
      const followUpMsgs =
        await modelHandler.createBatchedToolUseFollowUpMessages!(
          calls,
          extracted.map((e) => e.sanitizedResult),
          extracted.map((e) => e.attachments),
          workspace,
          assistantText || undefined,
        );
      shared.messages.push(...followUpMsgs);
    } else {
      for (const [index, execResult] of completedResults.entries()) {
        const { sanitizedResult, attachments } = extracted[index];
        const followUpMsgs = await modelHandler.createToolUseFollowUpMessages(
          this.services.client,
          execResult.call,
          sanitizedResult,
          attachments,
          workspace,
          index === 0 ? assistantText || undefined : undefined,
        );
        shared.messages.push(...followUpMsgs);
      }
    }

    // Note: userInstruction is already included in the tool_result content
    // via formatToolResultAsText (as "User feedback: ..."). Do NOT create
    // separate user text messages for it — non-tool-result user messages cause
    // Anthropic to strip thinking blocks from context, invalidating the prefix
    // cache and forcing expensive cache re-creation.

    shared.toolCalls = [];

    return FlowTransition.CONTINUE;
  }
}

/**
 * Creates a tool-use cycle flow with services injected via params.
 *
 * Flow structure:
 *   Prep → Call → Process → Dispatch
 *     ↑                        |
 *     └────── CONTINUE ────────┘
 *
 * Queued user messages (typed during tool execution) are injected in PrepNode
 * BEFORE calling the model, so the model's thinking/response considers the
 * user's feedback.
 */
export function createToolUseCycleFlow<C>(): Flow<
  ToolUseCycleShared,
  CycleParams
> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ModelInvocationNode<
    ToolUseCycleShared,
    CycleParams,
    ToolUseCycleServices<C>
  >({
    operationName: 'Tool-use call',
    streaming: true,
    storeResponse: (shared, response) => {
      shared.response = response;
    },
    getPostCompactionContext: (services) => {
      const { subagents, processes } = getActiveChildren(services.streamId);
      return formatPostCompactionContext(
        subagents,
        processes,
        services.workspace.workPlan.toSnapshot(),
      );
    },
    getDebugSaveOptions: (shared, services) => ({
      context: {
        modelName: services.config.model,
        isRemote: isRemoteAgent(services.config.agent),
      },
      fileOptions: {
        continuationCount: shared.cycleIndex,
        baseName: 'tooluse_response',
      },
    }),
  });
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleShared, CycleParams>(prepNode);
}
