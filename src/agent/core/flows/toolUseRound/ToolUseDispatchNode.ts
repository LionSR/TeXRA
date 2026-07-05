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
 * Error message for a tool_result synthesized in place of a tool_use with no
 * recorded result: the call may have never started (interrupted before
 * dispatch), or started and been aborted mid-flight (interrupted after the
 * tool ran but before its result was accepted). Every persisted tool_use must
 * have a paired tool_result — providers with strict tool-call pairing
 * requirements (e.g. Anthropic, and OpenAI's response-chaining mode) reject
 * follow-up requests otherwise.
 */
const CANCELLED_CALL_ERROR =
  'Tool call cancelled — the run was interrupted and no result was recorded for this call.';

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
          `Deduplicated ${this._duplicateCallIds.size} parallel tool call(s) with identical name and arguments`,
          { data: dupNames },
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
      const duplicateResult: ToolResult = {
        status: 'error',
        error: DUPLICATE_CALL_ERROR,
      };
      return {
        call,
        result: duplicateResult,
        parsedInput: call.input,
        extracted: {
          sanitizedResult: duplicateResult,
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
      return {
        status: 'error',
        error: `Unknown tool ${call.name}`,
      };
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
      return {
        status: 'error',
        error: message.trim() || 'Tool execution failed.',
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      };
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
              result.status === 'error'
                ? result.error
                : (result.output ?? 'Tool execution cancelled.'),
            isError: true,
          },
          'failed',
        );
      }
      return null;
    }

    const trackedEdits = tracker.recordEdits(
      result.status === 'executed' ? result.edits : undefined,
    );
    if (
      result.status === 'executed' &&
      !result.lineChanges &&
      trackedEdits.lineChanges
    ) {
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

  /**
   * Build a synthetic "cancelled" result for a tool_use that never executed
   * (interrupted before dispatch, or aborted mid-flight and returned `null`
   * from `exec()`). Mirrors the duplicate-call synthetic result shape so it
   * flows through the same follow-up-message construction unchanged.
   */
  private buildCancelledResult(call: SdkToolCall): ToolExecutionResult {
    const cancelledResult: ToolResult = {
      status: 'error',
      error: CANCELLED_CALL_ERROR,
    };
    return {
      call,
      result: cancelledResult,
      parsedInput: call.input,
      extracted: {
        sanitizedResult: cancelledResult,
        attachments: [],
      },
      editedFiles: [],
      logRef: {
        logId: undefined,
        groupId: this.services.logger.activeStageId(),
      },
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
    if (result.status === 'executed' && result.files?.length) {
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
            `Skipping inaccessible media file: ${attachment.path}`,
            { data: err },
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
    dispatchedCalls: SdkToolCall[],
    execResults: (ToolExecutionResult | null)[],
  ): Promise<string | undefined> {
    const { workspace } = this.services;

    // prep() returns [] when interruption is detected before any call is
    // dispatched (or when there was nothing to dispatch this round). Fall
    // back to shared.toolCalls — the full set the model requested — so an
    // interruption caught this early still gets synthesized cancelled
    // results instead of leaving those tool_use blocks unpaired in history.
    const toolCalls = dispatchedCalls.length
      ? dispatchedCalls
      : (shared.toolCalls ?? []);

    if (!toolCalls.length) {
      return FlowTransition.COMPLETE;
    }

    // Every tool_use the model requested must end up paired with a tool_result
    // before persistence. A call that never executed — interrupted before
    // dispatch, aborted mid-flight, or a duplicate whose primary never ran —
    // shows up here as `null`; synthesize a "cancelled" result for it instead
    // of silently dropping it, so the persisted turn always satisfies
    // provider tool-call pairing invariants on resume.
    let interrupted = false;
    const allResults = toolCalls.map((call, index) => {
      const execResult = execResults[index];
      if (execResult) return execResult;
      interrupted = true;
      return this.buildCancelledResult(call);
    });

    if (interrupted) {
      shared.shouldStop = true;
    }

    const assistantText = shared.text ?? '';

    // Only log results that actually ran (or were synthesized earlier for
    // duplicate skips) — a mid-flight abort already finalizes its own card
    // with a 'failed' status inside executeToolCall(), and a never-started
    // call has no card to update.
    for (const execResult of execResults) {
      if (execResult) {
        await this.logAndProcessMediaFiles(execResult);
      }
    }

    const extracted = allResults.map((er) => er.extracted);
    const calls = allResults.map((er) => er.call);

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
      for (const [index, execResult] of allResults.entries()) {
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
