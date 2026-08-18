// Third-party imports
import PQueue from 'p-queue';

// Local imports
import { Node } from '@agent/node';
import {
  emitToolUseCard,
  endToolUseCard,
  startToolUseCard,
} from '@agent/trace';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import {
  extractToolAttachments,
  type ExtractedToolAttachments,
} from '@agent/core/tools/toolAttachmentExtraction';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  normalizeToolCallError,
  parseToolInput,
  partitionDuplicateCalls,
} from '@agent/core/flows/toolCallParsing';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import type { FileLocation, ToolResult } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';

// Local file imports
import type { ToolUseRoundShared } from './roundShared';

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
  'Tool call cancelled: the run was interrupted and no result was recorded for this call.';

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

interface SafeToolInvocation {
  result: ToolResult;
  extracted: ExtractedToolAttachments;
}

function endsToolUseTurn(result: ToolExecutionResult | null): boolean {
  return result?.result.status === 'executed' && result.result.endTurn === true;
}

/**
 * Dispatches tool calls with ordering barriers.
 *
 * Contiguous runs of parallel-safe (read-only) calls execute concurrently
 * under a small semaphore; any other tool acts as a barrier and runs alone,
 * preserving ordering guarantees when tools have dependencies (e.g., read
 * file then edit file). Duplicate parallel calls (identical name+arguments)
 * execute once; duplicates receive a side-effect-stripped copy of the
 * primary's result (including accidental GPT re-emissions of bash/write).
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

  /** Returns tool calls to execute, or empty array if skipped/interrupted. */
  async prep(shared: ToolUseRoundShared): Promise<SdkToolCall[]> {
    this._duplicateToPrimary.clear();
    this._currentUserInstruction = shared.currentUserInstruction;
    const toolCalls = shared.toolCalls ?? [];

    if (shared.shouldStop || toolCalls.length === 0) {
      return [];
    }

    if (this.services.runScope.signal.aborted) {
      shared.shouldStop = true;
      return [];
    }

    // Deduplicate parallel calls (same tool name + identical arguments):
    // execute once and fan the primary's result out to every duplicate.
    // Parallel-safe sharing is limited to a contiguous safe segment; a
    // side-effect call in between may change what a repeated read returns.
    // Side-effect identicals share too (models often re-emit bash by
    // accident); a different mutation between two identical mutations
    // re-opens the window so intentional restores still run.
    if (toolCalls.length > 1) {
      this._duplicateToPrimary = partitionDuplicateCalls(toolCalls, (call) =>
        this.isParallelSafe(call),
      );

      if (this._duplicateToPrimary.size > 0) {
        this.services.logger.debug(
          `Deduplicated ${this._duplicateToPrimary.size} parallel tool call(s) with identical name and arguments`,
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
   * cancellation runs through the run's abort signal, not `this.signal`.
   */
  async _exec(calls: SdkToolCall[]): Promise<(ToolExecutionResult | null)[]> {
    if (calls.length === 0) return [];

    const results = new Array<ToolExecutionResult | null>(calls.length).fill(
      null,
    );
    // Duplicates execute nothing — schedule only the live calls, then copy
    // the primaries' results onto them afterwards.
    const live = calls.flatMap((call, index) =>
      this._duplicateToPrimary.has(call.callId) ? [] : [index],
    );
    const { signal } = this.services.runScope;
    const queue = new PQueue({ concurrency: MAX_PARALLEL_TOOL_CALLS });
    let i = 0;
    while (i < live.length) {
      if (signal.aborted) {
        break;
      }
      const index = live[i];
      if (!this.isParallelSafe(calls[index])) {
        // Barrier: mutating/unknown tools run alone, in order.
        results[index] = await this.exec(calls[index]);
        i += 1;
        if (endsToolUseTurn(results[index])) break;
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
          queue.add(async () => {
            // Re-check after waiting for a slot: an interrupt while this
            // call was queued must not start new work.
            if (signal.aborted) return;
            results[index] = await this.exec(calls[index]);
          }),
        ),
      );
      if (run.some((index) => endsToolUseTurn(results[index]))) break;
    }
    this.fanOutDuplicateResults(calls, results);
    return results;
  }

  /**
   * Build a synthetic ToolExecutionResult for a call that never actually
   * executed a tool (duplicate fan-out or cancelled call) — always empty
   * edits/attachments, and a fresh logRef.
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
    if (this.services.runScope.signal.aborted) {
      return null;
    }

    this.services.workspace.interactions.recordToolCall();

    return this.executeToolCall(call);
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
    cloned._currentUserInstruction = undefined;
    return cloned;
  }

  /** Invoke a tool with error handling, returning an error result if the tool is missing. */
  private async invokeToolSafely(
    call: SdkToolCall,
    tool: { call(input: unknown): Promise<ToolResult> } | undefined,
    parsedInput: unknown,
    onExecutionReady: (() => void) | undefined,
    onToolOutput: ((chunk: string) => void) | undefined,
    signal: AbortSignal,
  ): Promise<SafeToolInvocation> {
    if (!tool) {
      const result: ToolResult = {
        status: 'error',
        error: `Unknown tool ${call.name}`,
      };
      return { result, extracted: extractToolAttachments(result) };
    }

    const options = this.services;
    let result: ToolResult;
    try {
      result = await withToolFileInteractionContext(
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
      result = {
        status: 'error',
        error: message.trim() || 'Tool execution failed.',
        ...(diagnostics ? { diagnostics } : {}),
      };
    }

    try {
      return { result, extracted: extractToolAttachments(result) };
    } catch (err) {
      result = {
        status: 'error',
        error: `${call.name}: Tool returned an invalid result (${toErrorMessage(err)})`,
      };
      return { result, extracted: extractToolAttachments(result) };
    }
  }

  /** Execute a single tool call and return the result with metadata. */
  private async executeToolCall(
    call: SdkToolCall,
  ): Promise<ToolExecutionResult | null> {
    const options = this.services;
    const parsedInput = parseToolInput(call.input, call.callId, options.logger);
    const tool = options.toolRegistry.get(call.name);
    const isDeferred = tool?.deferLogUntilApproval === true;

    // Capture groupId at start. For deferred tools, delay logging until onExecutionReady.
    const logRef: ToolExecutionResult['logRef'] =
      tool?.slow === true && !isDeferred
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
    if (tool?.streamsOutput === true) {
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

    // Every call runs under the run's one signal, so a single interrupt
    // cancels the whole in-flight batch.
    const { result, extracted } = await this.invokeToolSafely(
      call,
      tool,
      parsedInput,
      onExecutionReady,
      onToolOutput,
      options.runScope.signal,
    );

    if (options.runScope.signal.aborted) {
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
      extracted.sanitizedResult.lineChanges = trackedEdits.lineChanges;
    }

    const editedFiles = trackedEdits.paths.map((path) => ({
      path,
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
      ...(editedFiles.length > 0 ? { files: editedFiles } : {}),
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
    const endTurn = allResults.some(endsToolUseTurn);
    if (endTurn) {
      shared.shouldStop = true;
      shared.endTurn = true;
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

    // For handlers that carry provider-side reasoning across multiple parallel
    // calls, batch all tool calls into a single message to preserve thought
    // signatures / reasoning_content.
    //
    // Called through `modelHandler.` (not an extracted local reference) so
    // provider implementations that read `this` internally (e.g. Google,
    // OpenAI) keep their receiver bound.
    const modelHandler = this.services.modelCell.handler;
    const client = await this.services.modelCell.getClient();
    const toolResults = allResults.map((execResult) => ({
      call: execResult.call,
      result: execResult.extracted.sanitizedResult,
      attachments: execResult.extracted.attachments,
    }));
    if (
      toolResults.length > 1 &&
      modelHandler.requiresBatchedParallelToolResults &&
      modelHandler.createBatchedToolUseFollowUpMessages
    ) {
      const followUpMsgs =
        await modelHandler.createBatchedToolUseFollowUpMessages(
          toolResults,
          workspace,
          assistantText || undefined,
          client,
        );
      shared.messages.push(...followUpMsgs);
    } else {
      for (const [
        index,
        { call, result, attachments },
      ] of toolResults.entries()) {
        const followUpMsgs = await modelHandler.createToolUseFollowUpMessages(
          client,
          call,
          result,
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

    return endTurn ? FlowTransition.COMPLETE : FlowTransition.CONTINUE;
  }
}
