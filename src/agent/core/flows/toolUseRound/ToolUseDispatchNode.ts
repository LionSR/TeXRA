// Local imports - core flow primitives
import { BatchNode } from '@agent/node';
import {
  emitToolUseCard,
  endToolUseCard,
  startToolUseCard,
} from '@agent/trace';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import {
  extractToolAttachments,
  type ExtractedToolAttachments,
} from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import type { FlowParams } from '@agent/core/flows/BaseFlowServices';
import { toErrorMessage } from '@common/errors';

// Local imports - logging
import type { FileLocation } from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { AbsoluteFS, pathToLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';

// Local file imports
import { FlowTransition } from '../FlowTransitions';
import {
  DUPLICATE_CALL_ERROR,
  findDuplicateCallIds,
  normalizeToolCallError,
  parseToolInput,
} from './toolCallParsing';
import type { ToolUseRoundServices } from '../CycleServices';
import type { ToolUseRoundShared } from './roundShared';

/** Tools that may take a while and benefit from showing in-progress state. */
const SLOW_TOOLS = new Set([
  'bash',
  'wolfram',
  'web_fetch',
  'web_search',
  'executions',
]);

/** Tools that defer in-progress logging until after approval. */
const DEFERRED_LOG_TOOLS = new Set(['bash', 'codex', 'wolfram']);

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
  editedFiles: {
    path: string;
    ok: boolean;
    source: string;
    sourceDisplay: string;
  }[];
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
export class ToolUseDispatchNode<C> extends BatchNode<
  ToolUseRoundShared,
  FlowParams,
  ToolUseRoundServices<C>
> {
  /**
   * Call IDs of duplicate parallel calls detected during prep().
   * These are skipped during exec() and receive a synthetic error result
   * instructing the model to call them sequentially instead.
   */
  private _duplicateCallIds = new Set<string>();

  /** Returns tool calls to execute, or empty array if skipped/interrupted. */
  async prep(shared: ToolUseRoundShared): Promise<SdkToolCall[]> {
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
          sanitizedResult: { status: 'error', error: DUPLICATE_CALL_ERROR },
          attachments: [],
        },
        editedFiles: [],
        logRef: {
          logId: undefined,
          groupId: this.services.logger.activeStageId(),
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
    options: ToolUseRoundServices<C>,
    tracker: FileInteractionState,
    workPlanState: WorkPlanState,
    onExecutionReady?: () => void,
    onToolOutput?: (chunk: string) => void,
    signal?: AbortSignal,
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
          signal,
          // Subagent cost lands in the parent's totals only (no normalized
          // snapshot), so per-round usage reporting doesn't double-count it —
          // the child's own run already reported its rounds.
          recordSubagentCost: (costUsd) => {
            if (costUsd > 0) {
              options.run.usageAccumulator.totals.totalCost += costUsd;
            }
          },
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
    options: ToolUseRoundServices<C>,
    tracker: FileInteractionState,
    workPlanState: WorkPlanState,
  ): Promise<ToolExecutionResult | null> {
    const parsedInput = parseToolInput(call.input, call.callId, options.logger);
    const tool = options.toolRegistry.get(call.name);
    const isDeferred = DEFERRED_LOG_TOOLS.has(call.name);

    // Capture groupId at start. For deferred tools, delay logging until onExecutionReady.
    const logRef: ToolExecutionResult['logRef'] =
      SLOW_TOOLS.has(call.name) && !isDeferred
        ? startToolUseCard(options.logger, call.name, parsedInput ?? call.raw)
        : { logId: undefined, groupId: options.logger.activeStageId() };

    const onExecutionReady = isDeferred
      ? () => {
          if (!logRef.logId) {
            const ref = startToolUseCard(
              options.logger,
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
        endToolUseCard(
          options.logger,
          { logId: logRef.logId, groupId: logRef.groupId },
          {
            toolName: call.name,
            input: parsedInput ?? call.raw,
            output: outputBuffer,
          },
          'in_progress',
        );
      };
    }

    const controller = new AbortController();
    options.setAbortController(controller);

    let result: ToolResult;
    try {
      result = await this.invokeToolSafely(
        call,
        tool,
        parsedInput,
        options,
        tracker,
        workPlanState,
        onExecutionReady,
        onToolOutput,
        controller.signal,
      );
    } finally {
      options.setAbortController(null);
    }

    if (controller.signal.aborted || options.checkInterruption()) {
      if (logRef.logId) {
        endToolUseCard(
          options.logger,
          { logId: logRef.logId, groupId: logRef.groupId },
          {
            toolName: call.name,
            input: parsedInput ?? call.raw,
            output:
              result.error ?? result.output ?? 'Tool execution cancelled.',
            isError: true,
          },
          'failed',
        );
      }
      return null;
    }

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

    // The status discriminator belongs to model-facing tool results. Progress
    // logs should expose only visible tool content.
    const { status: _status, ...logOutputBase } = extracted.sanitizedResult;
    const logOutput = {
      ...logOutputBase,
      ...(editedFiles.length ? { editedFiles } : {}),
    };

    const toolUseLog = {
      toolName: call.name,
      input: parsedInput ?? call.raw,
      ...(Object.keys(logOutput).length > 0 ? { output: logOutput } : {}),
      ...(editedFiles.length && { files: editedFiles }),
      isError: extracted.sanitizedResult.status === 'error',
    };

    // Update in-progress log (slow tools) or create new log (fast tools)
    // Both use the groupId captured at execution start for consistency
    if (logRef.logId) {
      endToolUseCard(
        options.logger,
        { logId: logRef.logId, groupId: logRef.groupId },
        toolUseLog,
      );
    } else {
      emitToolUseCard(
        options.logger,
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
            `Skipping inaccessible media file: ${attachment.path} (${toErrorMessage(err)})`,
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
    shared: ToolUseRoundShared,
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

    // For handlers that carry provider-side reasoning across multiple parallel
    // calls, batch all tool calls into a single message to preserve thought
    // signatures / reasoning_content.
    const { modelHandler } = this.services;
    const shouldBatch =
      calls.length > 1 &&
      modelHandler.requiresBatchedParallelToolResults &&
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
