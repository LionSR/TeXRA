/**
 * Tool-use cycle: prep → invoke model → process response → dispatch tools → loop.
 *
 * Replaces the previous Flow-of-Nodes architecture with plain functions and a
 * direct while loop.  ModelInvocationNode is kept as-is (it carries the retry /
 * abort-controller / 401-recovery machinery that cannot be trivially inlined).
 *
 * Exports:
 * - `runToolUseCycle()` — the only entry point; returns a discriminated union.
 * - `ToolUseCycleOutcome` — the outcome type.
 */

// Third-party imports
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';

// Local imports - core flow primitives
import { MESSAGE_TYPES } from '@shared/schemas';
import { isRemoteAgent } from '@agent/index';
import { recordCycleMetrics } from '@agent/core/AgentState';
import type { AgentRunStateSnapshot } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type {
  FileInteractionState,
  TodoState,
} from '@agent/core/AgentWorkspaceState';
import {
  BaseCycleFieldsSchema,
  type BaseCycleFields,
  resetCycleState,
  getDebugContext,
} from '@agent/core/flows/CommonCycleTypes';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { NormalizedUsageSchema } from '@agent/types/NormalizedUsage';
import type { ToolResult, IToolRegistry } from '@agent/core/ToolTypes';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import { extractToolAttachments } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import { toErrorMessage } from '@common/errors';
import { AgentLogger } from '@logger/AgentLogger';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  type ValidationErrorDiagnostics,
} from '@tools/result';
import { AbsoluteFS, pathToLocation, type FileLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import { formatContent } from '@utils/text/xmlUtils';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import { ModelInvocationNode } from './ModelInvocationNode';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import type { RoundFinalizedCallback } from './CycleServices';

// ============================================================================
// Parallel call deduplication
// ============================================================================

const DUPLICATE_CALL_ERROR =
  'Duplicate parallel call skipped. This call has the same tool name and arguments ' +
  'as an earlier call in this batch that was already executed. ' +
  'If you need to run this tool multiple times with the same arguments, ' +
  'please call them sequentially in separate responses.';

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

function parseToolInput(
  raw: unknown,
  callId: string,
  logger: AgentLogger,
): unknown {
  if (raw == null) {
    logger.warn(`Tool call ${callId}: Received null input, using empty object`);
    return {};
  }
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn(
      `Tool call ${callId}: Failed to parse input as JSON, using raw string`,
    );
    return raw;
  }
}

function isZodError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}

function normalizeToolCallError(
  toolName: string,
  error: unknown,
): { message: string; diagnostics?: ValidationErrorDiagnostics } {
  if (!isZodError(error)) {
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
// Internal cycle state
// ============================================================================

interface CycleState extends BaseCycleFields {
  response?: unknown;
  toolCalls?: SdkToolCall[];
  text?: string;
  cycleIndex: number;
  cycleResponseTimeMs: number;
  cycleNormalizedUsage?: NormalizedUsage;
}

function createCycleState(
  messages: ProviderMessage[],
  cycleIndex: number,
): CycleState {
  return {
    messages,
    shouldStop: false,
    endTurn: false,
    responseTimeMs: undefined,
    stopReason: undefined,
    lastError: undefined,
    response: undefined,
    toolCalls: undefined,
    text: undefined,
    cycleIndex,
    cycleResponseTimeMs: 0,
    cycleNormalizedUsage: undefined,
  };
}

// ============================================================================
// Services type — combines outer services + client
// ============================================================================

/** Services available to cycle steps. Built inline by the caller. */
export interface CycleServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly client: C;
  readonly refreshClient?: () => Promise<void>;
  readonly toolRegistry: IToolRegistry;
  readonly modelName?: string;
  readonly agentName?: string;
  readonly session?: IToolUseSession;
  readonly onFollowUpConsumed?: () => void;
  readonly onRoundFinalized?: RoundFinalizedCallback;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
}

// ============================================================================
// Public API
// ============================================================================

/** Input to runToolUseCycle. */
export interface RunToolUseCycleInput<C> {
  messages: ProviderMessage[];
  cycleIndex: number;
  services: CycleServices<C>;
}

/** Discriminated outcome — callers match on `outcome`, no flag interpretation. */
export type ToolUseCycleOutcome =
  | { outcome: 'completed'; messages: ProviderMessage[] }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; message: string };

/**
 * Run the tool-use cycle loop: prep → invoke model → process → dispatch tools.
 * Loops on CONTINUE (tool dispatch triggers re-invocation).
 */
export async function runToolUseCycle<C>(
  input: RunToolUseCycleInput<C>,
): Promise<ToolUseCycleOutcome> {
  const { services } = input;
  const state = createCycleState(input.messages, input.cycleIndex);

  // ModelInvocationNode — kept for retry / abort / 401 machinery
  const invokeNode = new ModelInvocationNode<
    CycleState,
    Record<string, unknown>,
    CycleServices<C>
  >({
    operationName: 'Tool-use call',
    streaming: true,
    storeResponse: (s, response) => {
      s.response = response;
    },
    getDebugSaveOptions: (s, svc) => ({
      context: {
        modelName: svc.modelName,
        isRemote: isRemoteAgent(svc.agentName),
      },
      fileOptions: {
        continuationCount: s.cycleIndex,
        baseName: 'tooluse_response',
      },
    }),
  });

  // Main cycle loop
  let looping = true;
  while (looping) {
    looping = false; // exit unless dispatch says CONTINUE

    // ── PREP ──
    if (services.checkInterruption()) {
      state.shouldStop = true;
      state.endTurn = false;
      break;
    }

    if (services.session?.hasQueuedFollowUp()) {
      const followUp = await services.session.waitForFollowUp(() => false);
      if (followUp) {
        services.logger.userMessage(followUp);
        state.messages =
          await services.modelHandler.createUserFollowUpMessages(
            state.messages,
            followUp,
          );
        services.onFollowUpConsumed?.();
      }
    }

    resetCycleState(state, [
      'response',
      'toolCalls',
      'text',
      'cycleNormalizedUsage',
    ]);
    state.cycleResponseTimeMs = 0;

    await maybeSaveDebugObject({
      object: state.messages,
      objectType: 'messages',
      context: getDebugContext(services, {
        modelName: services.modelName,
        isRemote: isRemoteAgent(services.agentName),
      }),
      fileOptions: {
        continuationCount: state.cycleIndex,
        baseName: 'tooluse',
      },
    });

    // ── INVOKE MODEL ──
    const cloned = invokeNode.clone();
    cloned.setServices(services);
    const invokeAction = await cloned._run(state);
    if (invokeAction === FlowTransition.COMPLETE) break;

    // ── PROCESS RESPONSE ──
    const processAction = await processResponse(state, services);
    if (processAction === FlowTransition.COMPLETE) break;

    // ── DISPATCH TOOLS ──
    const dispatchAction = await dispatchTools(state, services);
    if (dispatchAction === FlowTransition.CONTINUE) {
      looping = true;
    }
  }

  // Typed outcome — callers never interpret flags
  if (state.shouldStop && state.lastError) {
    return {
      outcome: 'failed',
      message: state.lastError.message ?? 'Cycle failed',
    };
  }
  if (state.shouldStop && !state.lastError && !state.endTurn) {
    return { outcome: 'cancelled' };
  }
  return { outcome: 'completed', messages: state.messages };
}

// ============================================================================
// Step: Process Response
// ============================================================================

async function processResponse<C>(
  state: CycleState,
  services: CycleServices<C>,
): Promise<string | undefined> {
  if (state.shouldStop || !state.response) {
    return FlowTransition.COMPLETE;
  }

  const { workspace, modelHandler, logger } = services;

  const thinking = modelHandler.processThinkingBlock(state.response, workspace);
  const useStreaming = modelHandler.getStreamingConfig();
  if (thinking && !useStreaming) {
    const formatted = await formatContent(thinking);
    if (isNonEmptyString(formatted)) {
      logger.info(formatted, { messageType: MESSAGE_TYPES.THINKING });
    }
  }

  const toolCalls = modelHandler.extractToolUse(state.response);
  const { text, usage, stopReason } = modelHandler.extractResponse(
    state.response,
    '',
  );

  const serverToolData = modelHandler.extractServerToolData(state.response);
  if (!useStreaming) {
    for (const searchResult of serverToolData.webSearchResults) {
      logger.logWebSearch(searchResult);
    }
  }

  const lastAssistantContent = modelHandler.extractAssistantContent(
    state.response,
  );

  if (text) {
    logger.debug(`Model response: ${text.slice(0, 100)}`);
    if (!useStreaming) {
      const formatted = await formatContent(text);
      logger.info(formatted, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
    }
  }

  let normalizedUsage: NormalizedUsage | undefined;
  if (usage) {
    normalizedUsage = modelHandler.normalizeUsage(
      usage,
      state.responseTimeMs ?? 0,
    );
    const { inputTokens } = normalizedUsage;
    const { contextWindow } = modelHandler.config;
    if (inputTokens > 0 && contextWindow > 0) {
      logger.logContextState(inputTokens, contextWindow);
    }
  }

  const endTurn =
    modelHandler.isEndTurnStop(stopReason) || !toolCalls?.length;

  // Side effects
  workspace.serverToolContent.contentBlocks =
    serverToolData.contentBlocks ?? [];
  workspace.serverToolContent.lastAssistantContent =
    lastAssistantContent ?? [];

  if (state.responseTimeMs !== undefined) {
    state.cycleResponseTimeMs += state.responseTimeMs;
  }
  if (normalizedUsage) {
    state.cycleNormalizedUsage = normalizedUsage;
  }

  recordCycleMetrics(
    services.run,
    state.cycleIndex,
    state.cycleResponseTimeMs,
    state.cycleNormalizedUsage ?? null,
  );
  if (services.onRoundFinalized) {
    await services.onRoundFinalized(services.run);
  }
  services.run.totalRounds += 1;
  state.stopReason = stopReason;

  if (endTurn) {
    state.toolCalls = undefined;
    state.shouldStop = true;
    state.endTurn = true;
    if (text) {
      state.messages.push(modelHandler.createAssistantMessage(text));
      workspace.assembly.lastResponse = text;
    }
    workspace.resetServerToolContent();
    workspace.resetReasoning();
    return FlowTransition.COMPLETE;
  }

  state.toolCalls = toolCalls;
  state.text = text ?? undefined;
  state.cycleIndex += 1;
  state.cycleResponseTimeMs = 0;
  state.cycleNormalizedUsage = undefined;
  return FlowTransition.DEFAULT;
}

// ============================================================================
// Step: Dispatch Tools
// ============================================================================

const SLOW_TOOLS = new Set(['bash', 'wolfram', 'web_fetch', 'web_search']);
const DEFERRED_LOG_TOOLS = new Set(['bash']);
const STREAMABLE_TOOLS = new Set(['bash']);
const STREAM_THROTTLE_MS = 500;
const STREAM_BUFFER_MAX = 50_000;

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
  logRef: { logId: string | undefined; groupId: string | undefined };
}

async function dispatchTools<C>(
  state: CycleState,
  services: CycleServices<C>,
): Promise<string | undefined> {
  const toolCalls = state.toolCalls ?? [];
  if (state.shouldStop || toolCalls.length === 0) {
    return FlowTransition.COMPLETE;
  }

  if (services.checkInterruption()) {
    state.shouldStop = true;
    return FlowTransition.COMPLETE;
  }

  // Deduplicate parallel calls
  let duplicateCallIds = new Set<string>();
  if (toolCalls.length > 1) {
    duplicateCallIds = findDuplicateCallIds(toolCalls);
    if (duplicateCallIds.size > 0) {
      const dupNames = [
        ...new Set(
          toolCalls
            .filter((c) => duplicateCallIds.has(c.callId))
            .map((c) => c.name),
        ),
      ];
      services.logger.debug(
        `Deduplicated ${duplicateCallIds.size} parallel tool call(s) ` +
          `with identical name and arguments: ${dupNames.join(', ')}`,
      );
    }
  }

  // Execute tool calls sequentially
  const execResults: (ToolExecutionResult | null)[] = [];
  for (const call of toolCalls) {
    if (services.checkInterruption()) {
      execResults.push(null);
      continue;
    }

    if (duplicateCallIds.has(call.callId)) {
      execResults.push({
        call,
        result: { error: DUPLICATE_CALL_ERROR, isError: true },
        parsedInput: call.input,
        sanitizedOutput: { error: DUPLICATE_CALL_ERROR, isError: true },
        editedFiles: [],
        logRef: {
          logId: undefined,
          groupId: services.logger.resolveActiveGroupId(),
        },
      });
      continue;
    }

    execResults.push(
      await executeToolCall(
        call,
        services,
        services.workspace.interactions,
        services.workspace.todos,
      ),
    );
  }

  // Post-dispatch: log, process media, create follow-up messages
  const { workspace } = services;
  const completedResults = execResults.filter(
    (r): r is ToolExecutionResult => r !== null,
  );

  if (completedResults.length < execResults.length) {
    state.shouldStop = true;
  }

  if (completedResults.length === 0) {
    return FlowTransition.COMPLETE;
  }

  const assistantText = state.text ?? '';
  for (const execResult of completedResults) {
    await logAndProcessMedia(execResult, services);
  }

  const extracted = completedResults.map((er) =>
    extractToolAttachments(er.result),
  );
  const calls = completedResults.map((er) => er.call);

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
    state.messages.push(...followUpMsgs);
  } else {
    for (const [index, execResult] of completedResults.entries()) {
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

  state.toolCalls = [];
  return FlowTransition.CONTINUE;
}

// ============================================================================
// Tool execution helpers
// ============================================================================

async function invokeToolSafely<C>(
  call: SdkToolCall,
  tool: { call(input: unknown): Promise<ToolResult> } | undefined,
  parsedInput: unknown,
  services: CycleServices<C>,
  tracker: FileInteractionState,
  todoState: TodoState,
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
        todoState,
        streamId: services.logger.streamId,
        executionId: services.executionId,
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

async function executeToolCall<C>(
  call: SdkToolCall,
  services: CycleServices<C>,
  tracker: FileInteractionState,
  todoState: TodoState,
): Promise<ToolExecutionResult> {
  const parsedInput = parseToolInput(call.input, call.callId, services.logger);
  const tool = services.toolRegistry.get(call.name);
  const isDeferred = DEFERRED_LOG_TOOLS.has(call.name);

  const logRef: { logId: string | undefined; groupId: string | undefined } =
    SLOW_TOOLS.has(call.name) && !isDeferred
      ? services.logger.logToolUseStart(call.name, parsedInput ?? call.raw)
      : {
          logId: undefined,
          groupId: services.logger.resolveActiveGroupId(),
        };

  const onExecutionReady = isDeferred
    ? () => {
        if (!logRef.logId) {
          const ref = services.logger.logToolUseStart(
            call.name,
            parsedInput ?? call.raw,
            logRef.groupId,
          );
          logRef.logId = ref.logId;
        }
      }
    : undefined;

  let onToolOutput: ((chunk: string) => void) | undefined;
  if (STREAMABLE_TOOLS.has(call.name)) {
    let outputBuffer = '';
    let lastFlush = 0;
    onToolOutput = (chunk: string) => {
      outputBuffer += chunk;
      if (outputBuffer.length > STREAM_BUFFER_MAX) {
        outputBuffer = outputBuffer.slice(-STREAM_BUFFER_MAX);
      }
      const now = Date.now();
      if (now - lastFlush < STREAM_THROTTLE_MS) return;
      lastFlush = now;
      if (!logRef.logId) return;
      bus.emit('updateLogMessage', {
        streamId: services.logger.streamId,
        logMessage: {
          id: logRef.logId,
          groupId: logRef.groupId,
          messageType: MESSAGE_TYPES.TOOL_USE,
          data: {
            toolName: call.name,
            input: parsedInput ?? call.raw,
            output: outputBuffer,
            status: 'in_progress',
          },
        },
      });
    };
  }

  const result = await invokeToolSafely(
    call,
    tool,
    parsedInput,
    services,
    tracker,
    todoState,
    onExecutionReady,
    onToolOutput,
  );

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

  return { call, result, parsedInput, sanitizedOutput, editedFiles, logRef };
}

async function logAndProcessMedia<C>(
  execResult: ToolExecutionResult,
  services: CycleServices<C>,
): Promise<void> {
  const { call, result, parsedInput, sanitizedOutput, editedFiles, logRef } =
    execResult;
  const { workspace, logger } = services;

  const toolUseLog = {
    toolName: call.name,
    input: parsedInput ?? call.raw,
    output: sanitizedOutput,
    ...(editedFiles.length > 0 && { files: editedFiles }),
    isError: Boolean(result.isError),
  };

  if (logRef.logId) {
    logger.updateToolUse(logRef.logId, toolUseLog, logRef.groupId);
  } else {
    logger.logToolUse({ ...toolUseLog, status: 'completed' }, logRef.groupId);
  }

  const files = result.files;
  if (files && files.length > 0) {
    const validLocations: FileLocation[] = [];
    for (const attachment of files) {
      const filePath = attachment.path;
      if (typeof filePath !== 'string' || filePath.trim() === '') continue;
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
    if (validLocations.length > 0) {
      workspace.media.addMediaFiles(validLocations);
    }
  }
}
