// Local imports - core flow primitives
import { Node } from '@agent/node';
import {
  emitToolUseCard,
  endToolUseCard,
  startToolUseCard,
} from '@agent/trace';
import type { SdkToolCall } from '@agent/types/IModelHandler';
import {
  extractToolAttachments,
  type ExtractedToolAttachments,
} from '@agent/core/tools/toolAttachmentExtraction';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { FileLocation } from '@shared/schemas';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';

// Local imports - logging
import type { ToolResult } from '@shared/schemas/toolResult';
import { AbsoluteFS, pathToLocation } from '@utils/files';
import { isNonEmptyString, createSemaphore } from '@utils/core';

// Local file imports
import { FlowTransition } from '../FlowTransitions';
import {
  normalizeToolCallError,
  parseToolInput,
  partitionDuplicateCalls,
  UNSAFE_DUPLICATE_CALL_ERROR,
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
  DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
]);

/** Tools that defer in-progress logging until after approval. */
const DEFERRED_LOG_TOOLS = new Set(['bash', 'codex', 'wolfram']);

/** Tools that support streaming partial output to the UI. */
const STREAMABLE_TOOLS = new Set(['bash']);

/** Max concurrently executing tool calls within one dispatch batch. */
const MAX_PARALLEL_TOOL_CALLS = 4;

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
 * Dispatches tool calls with ordering barriers.
 *
 * Contiguous runs of parallel-safe (read-only) calls execute concurrently
 * under a small semaphore; any other tool acts as a barrier and runs alone,
 * preserving ordering guarantees when tools have dependencies (e.g., read
 * file then edit file). Duplicate parallel calls (identical name+arguments)
 * to parallel-safe tools execute once, with duplicates receiving a copy of
 * the primary's result; duplicates of side-effect tools get a synthetic
 * error instead, since sharing a success would misreport an effect that
 * never ran.
 *
 * Batches follow-up messages for Google/DeepSeek handlers to preserve thought signatures.
 */
export class ToolUseDispatchNode<C> extends Node<
  ToolUseRoundShared,
  ToolUseRoundServices<C>
> {
  /** Instruction snapshot associated with the tool calls being dispatched. */
  private _currentUserInstruction: string | undefined;

  /**
   * Duplicate parallel calls detected during prep(), mapped to the index of
   * their first occurrence. Duplicates are not executed; after the batch
   * completes they receive a side-effect-stripped copy of the primary's
   * result.
   */
  private _duplicateToPrimary = new Map<string, number>();

  /**
   * Duplicates of side-effect tools. Fanning the primary's success out
   * would report an effect that never ran (two identical appends would
   * "succeed" twice while running once), so these are answered with a
   * synthetic error instead — the model can re-issue sequentially if it
   * truly wants the effect twice.
   */
  private _unsafeDuplicateCallIds = new Map<string, number>();

  /** Returns tool calls to execute, or empty array if skipped/interrupted. */
  async prep(shared: ToolUseRoundShared): Promise<SdkToolCall[]> {
    this._duplicateToPrimary.clear();
    this._unsafeDuplicateCallIds.clear();
    this._currentUserInstruction = shared.currentUserInstruction;
    const toolCalls = shared.toolCalls ?? [];

    if (shared.shouldStop || toolCalls.length === 0) {
      return [];
    }

    if (this.services.checkInterruption()) {
      shared.shouldStop = true;
      return [];
    }

    // Deduplicate parallel calls (same tool name + identical arguments):
    // parallel-safe duplicates share their primary's result, but only
    // within a contiguous safe segment — a side-effect call in between may
    // change what a repeated read returns. Side-effect duplicates are
    // rejected with a synthetic error (see _unsafeDuplicateCallIds).
    if (toolCalls.length > 1) {
      const partition = partitionDuplicateCalls(toolCalls, (call) =>
        this.isParallelSafe(call),
      );
      this._duplicateToPrimary = partition.sharedWithPrimary;
      this._unsafeDuplicateCallIds = partition.rejected;

      const duplicateCount =
        this._duplicateToPrimary.size + this._unsafeDuplicateCallIds.size;
      if (duplicateCount > 0) {
        this.services.logger.debug(
          `Deduplicated ${duplicateCount} parallel tool call(s) with identical name and arguments (${this._unsafeDuplicateCallIds.size} side-effect duplicate(s) rejected)`,
        );
      }
    }

    return toolCalls;
  }

  /**
   * Execute the batch: parallel-safe runs concurrently, barriers alone,
   * duplicates filled from their primary's result afterwards. Results keep
   * the original call order; skipped/interrupted slots stay null.
   *
   * Bypasses Node._exec's per-item retry machinery on purpose: tool calls
   * are never auto-retried (default maxRetries, exec never throws), and
   * cancellation runs through the batch abort controller, not `this.signal`.
   */
  async _exec(items: unknown[]): Promise<unknown[]> {
    const calls = Array.isArray(items) ? (items as SdkToolCall[]) : [];
    if (calls.length === 0) return [];

    const results: (ToolExecutionResult | null)[] = new Array<null>(
      calls.length,
    ).fill(null);
    // Duplicates execute nothing — schedule only the live calls, then copy
    // the primaries' results (or synthetic errors) onto them afterwards.
    const live = calls.flatMap((call, index) =>
      this._duplicateToPrimary.has(call.callId) ||
      this._unsafeDuplicateCallIds.has(call.callId)
        ? []
        : [index],
    );
    const batchController = new AbortController();
    this.services.setAbortController(batchController);
    try {
      const semaphore = createSemaphore(MAX_PARALLEL_TOOL_CALLS);
      let i = 0;
      while (i < live.length) {
        if (
          batchController.signal.aborted ||
          this.services.checkInterruption()
        ) {
          break;
        }
        if (!this.isParallelSafe(calls[live[i]])) {
          // Barrier: mutating/unknown tools run alone, in order.
          const index = live[i];
          results[index] = await this.execCall(
            calls[index],
            batchController.signal,
          );
          i += 1;
          continue;
        }
        // Contiguous run of parallel-safe calls executes concurrently.
        const run: number[] = [];
        while (i < live.length && this.isParallelSafe(calls[live[i]])) {
          run.push(live[i]);
          i += 1;
        }
        await Promise.all(
          run.map((index) =>
            semaphore.run(async () => {
              // Re-check after waiting for a slot: an interrupt while this
              // call was queued must not start new work.
              if (batchController.signal.aborted) return;
              results[index] = await this.execCall(
                calls[index],
                batchController.signal,
              );
            }),
          ),
        );
      }
      this.fanOutDuplicateResults(calls, results);
      this.rejectUnsafeDuplicates(calls, results);
      return results;
    } finally {
      this.services.setAbortController(null);
    }
  }

  /** Answer side-effect duplicates with a synthetic error (never executed). */
  private rejectUnsafeDuplicates(
    calls: SdkToolCall[],
    results: (ToolExecutionResult | null)[],
  ): void {
    for (const [index, call] of calls.entries()) {
      const primaryIndex = this._unsafeDuplicateCallIds.get(call.callId);
      if (primaryIndex === undefined) continue;
      // If the primary never ran (interrupted batch), the duplicate stays
      // null too — a "side effects" skip message would be misleading when
      // no effect happened at all.
      if (!results[primaryIndex]) continue;
      const duplicateResult: ToolResult = {
        status: 'error',
        error: UNSAFE_DUPLICATE_CALL_ERROR,
      };
      results[index] = this.makeSyntheticResult(
        call,
        duplicateResult,
        call.input,
      );
    }
  }

  /**
   * Build a synthetic ToolExecutionResult for a call that never actually
   * executed a tool (duplicate fan-out, rejected duplicate, or cancelled
   * call) — always empty edits/attachments, and a fresh logRef.
   */
  private makeSyntheticResult(
    call: SdkToolCall,
    result: ToolResult,
    parsedInput: unknown,
    sanitizedResult: ToolResult = result,
  ): ToolExecutionResult {
    return {
      call,
      result,
      parsedInput,
      extracted: { sanitizedResult, attachments: [] },
      editedFiles: [],
      logRef: {
        logId: undefined,
        groupId: this.services.logger.activeStageId(),
      },
    };
  }

  /** A tool declares itself side-effect-free via ITool.parallelSafe. */
  private isParallelSafe(call: SdkToolCall): boolean {
    return this.services.toolRegistry.get(call.name)?.parallelSafe === true;
  }

  /** Execute a single tool call, returning null if interrupted. */
  async exec(call: SdkToolCall): Promise<ToolExecutionResult | null> {
    return this.execCall(call, null);
  }

  private async execCall(
    call: SdkToolCall,
    batchSignal: AbortSignal | null,
  ): Promise<ToolExecutionResult | null> {
    if (this.services.checkInterruption()) {
      return null;
    }

    this.services.workspace.interactions.recordToolCall();

    return this.executeToolCall(call, this.services, batchSignal);
  }

  /**
   * Give each duplicate call a copy of its primary's completed result.
   * Edits and file attachments are stripped: the primary already recorded
   * them, and a duplicate must not double-track edits or re-register media.
   */
  private fanOutDuplicateResults(
    calls: SdkToolCall[],
    results: (ToolExecutionResult | null)[],
  ): void {
    for (const [index, call] of calls.entries()) {
      const primaryIndex = this._duplicateToPrimary.get(call.callId);
      if (primaryIndex === undefined) continue;
      const primary = results[primaryIndex];
      // Primary interrupted or never ran: leave the duplicate null too.
      if (!primary) continue;
      const {
        edits: _edits,
        files: _files,
        lineChanges: _lineChanges,
        ...sharedResult
      } = primary.result;
      // The primary already injected any attachments into the follow-up;
      // repeating them per duplicate would duplicate binary context.
      results[index] = this.makeSyntheticResult(
        call,
        sharedResult as ToolResult,
        primary.parsedInput,
        primary.extracted.sanitizedResult,
      );
    }
  }

  clone(): this {
    const cloned = super.clone();
    cloned._duplicateToPrimary = new Map();
    cloned._unsafeDuplicateCallIds = new Map();
    cloned._currentUserInstruction = undefined;
    return cloned;
  }

  /** Invoke a tool with error handling, returning an error result if the tool is missing. */
  private async invokeToolSafely(
    call: SdkToolCall,
    tool: { call(input: unknown): Promise<ToolResult> } | undefined,
    parsedInput: unknown,
    options: ToolUseRoundServices<C>,
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
          tracker: options.workspace.interactions,
          workPlanState: options.workspace.workPlan,
          trace: options.logger,
          userInstruction:
            options.config.rootUserInstruction ?? this._currentUserInstruction,
          toolCallId: call.callId,
          signal,
          hooks: {
            onExecutionReady,
            onToolOutput,
            // Subagent cost lands in the parent's totals only (no normalized
            // snapshot), so per-round usage reporting doesn't double-count it —
            // the child's own run already reported its rounds.
            recordSubagentCost: (costUsd) => {
              if (costUsd > 0) {
                options.run.usageAccumulator.totals.totalCost += costUsd;
              }
            },
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
    batchSignal: AbortSignal | null,
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

    // Each call gets its own controller. Inside a dispatch batch it chains
    // to the batch-wide signal (one interrupt cancels every in-flight call);
    // standalone exec() (tests, direct invocation) registers it as before.
    const controller = new AbortController();
    let detachBatchAbort: (() => void) | undefined;
    if (batchSignal) {
      if (batchSignal.aborted) {
        controller.abort();
      } else {
        const onBatchAbort = () => controller.abort();
        batchSignal.addEventListener('abort', onBatchAbort, { once: true });
        detachBatchAbort = () =>
          batchSignal.removeEventListener('abort', onBatchAbort);
      }
    } else {
      options.setAbortController(controller);
    }

    let result: ToolResult;
    try {
      result = await this.invokeToolSafely(
        call,
        tool,
        parsedInput,
        options,
        onExecutionReady,
        onToolOutput,
        controller.signal,
      );
    } finally {
      detachBatchAbort?.();
      if (!batchSignal) {
        options.setAbortController(null);
      }
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

    const trackedEdits = options.workspace.interactions.recordEdits(
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
      return this.makeSyntheticResult(
        call,
        { status: 'error', error: CANCELLED_CALL_ERROR },
        call.input,
      );
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
          calls.map((call, index) => ({
            call,
            result: extracted[index].sanitizedResult,
            attachments: extracted[index].attachments,
          })),
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
