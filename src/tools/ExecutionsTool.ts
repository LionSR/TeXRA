/**
 * Tool for viewing and managing execution history, generated files, and
 * running processes. Supports viewing past executions, waiting for status
 * changes, reading output from background processes, and killing running
 * executions.
 */

// Local imports
import {
  deriveResumability,
  getExecutionStore,
  listExecutionWorkspaceFiles,
  unwrapResultMeta,
  type ChildRecord,
  type TodoEntry,
  listExecutions,
  resolveExecutionWorkspaceFilePath,
} from '@agent/storage';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { createLog } from '@logger/logUtils';
import type { FileStat } from '@platform/interfaces';
import { platform } from '@platform/platform';
import {
  ExecutionIdSchema,
  ToolError,
  type ExecutionId,
  type ToolResult,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import { BASH_BACKGROUND_LOG_CAP_CHARS } from '@shared/toolUse';
import { warnAbandonedSlotValue } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { requireRunStream, requireStreamId } from '@tools/contextHelpers';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
  readCompletedRunTodos,
} from '@transcript';
import { assertNever, unique } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/runStorageFs';
import { getPathSegments } from '@utils/core/pathCore';
import { formatBytes, splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import {
  buildCompletedSummaryLines,
  buildRunningSummaryLines,
  buildSummaryTailLines,
  formatChildLine,
  formatListingLine,
  formatStatusInfo,
  formatTodoHeader,
  formatTodoSection,
  getExecutionStatusInfo,
  executionDisplayCategory,
  shouldSuppressAutoDeliveredSubagentReport,
  type ExecutionDisplayCategory,
  type ExecutionSummaryOptions,
} from './executionFormatters';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
} from './formatting';
import { serializeFilteredConfig } from './executions/configView';
import { formatConversation } from './executions/conversationFormat';
import { EXECUTION_PATH_LIST } from './executions/pathCatalog';
import {
  OUTPUT_MAX_LINES,
  OUTPUT_TAIL_LINES,
  projectProcessOutput,
} from './executions/processOutput';
import { listRunGeneratedFiles } from './executions/runGeneratedFiles';
import {
  ExecutionsToolInputSchema,
  type ExecutionsToolInput,
} from './executions/toolInput';
import { turnAttributionNote } from './executions/turnAttribution';
import {
  listenForFollowUp,
  shouldSkipWait,
} from './executions/waitCoordination';
import { workflowExecutionView } from './executions/workflowSummaryView';

const log = createLog('ExecutionsTool');

function getRunningTodos(
  session: SessionHandle,
  handle: AgentExecutionHandle,
): TodoEntry[] {
  return session.snapshots.getWorkPlan(handle.childStreamId).todos;
}

interface SizedEntry {
  readonly path: string;
  readonly size: number;
  readonly isDir: boolean;
}

/**
 * Format entries as right-aligned "<size>  <path>" lines (`<dir>` for
 * directories). `/files` and `/workspace-files` render the same shape, so each
 * normalizes its own entry shape to `SizedEntry` first — `listFiles` and
 * `listWorkspaceFiles` source entries with differently-named directory flags.
 */
function formatSizedEntryLines(entries: readonly SizedEntry[]): string[] {
  return entries.map((entry) => {
    const sizeStr = entry.isDir ? '<dir>' : formatBytes(entry.size);
    return `${sizeStr.padStart(8)}  ${entry.path}`;
  });
}

export class ExecutionsTool extends defineTool({
  name: 'executions',
  slow: true,
  description: `View execution history and manage running executions.

Paths:
${EXECUTION_PATH_LIST}

Use "current" as {id} to access the active execution.
Use offset/limit to paginate the /executions listing or conversation messages (default: offset 0, limit 100).
Use view_range: [start, end] to paginate file and background-command output content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed executions to change.
Use action: "kill" on /executions/{id} to terminate a running execution.
Use action: "subscribe" on /executions/{id} to receive future status and termination events as <execution-activity> follow-ups (auto-disposes when the execution finishes or this stream is released). Use action: "unsubscribe" on /executions/{id} to stop them.
Delegated subagent and workflow results are delivered automatically as follow-up messages. No wait or subscription is needed for executions you launched. Use action: "wait" only when you cannot proceed without a status change; use action: "subscribe" for push updates on executions whose results are not auto-delivered.`,
  schema: ExecutionsToolInputSchema,
}) {
  protected async execute(input: ExecutionsToolInput): Promise<ToolResult> {
    const segments = getPathSegments(input.path);
    const [namespace, id, resource, ...rest] = segments;

    if (namespace !== 'executions') {
      throw new ToolError(
        `Path must start with /executions. Got: ${input.path}`,
      );
    }

    // /executions - list all executions
    if (!id) {
      if (
        input.action === 'subscribe' ||
        input.action === 'unsubscribe' ||
        input.action === 'kill'
      ) {
        throw new ToolError(
          `action='${input.action}' requires a specific execution: use /executions/{id}.`,
        );
      }
      if (input.action === 'wait') {
        await this.waitForAnyChange(input.timeout, input.ids);
      }
      return this.listExecutions(input.offset, input.limit);
    }

    const executionId = this.resolveExecutionId(id);

    // /executions/{id} - execution summary or actions
    if (!resource) {
      switch (input.action) {
        case 'kill':
          return this.handleKill(executionId);
        case 'subscribe':
          return this.handleSubscribe(executionId);
        case 'unsubscribe':
          return this.handleUnsubscribe(executionId);
        case 'wait':
          await this.waitForChange(executionId, input.timeout);
          return this.showSummary(executionId, {
            suppressAutoDeliveredSubagentReport: true,
          });
        case 'view':
          return this.showSummary(executionId, {
            suppressAutoDeliveredSubagentReport: false,
          });
        default:
          return assertNever(input, 'Unrecognized executions action');
      }
    }

    // Sub-resource paths (config, conversation, files, ...) only support
    // reading — wait/kill/subscribe/unsubscribe operate on /executions or
    // /executions/{id}, never a deeper resource.
    if (input.action !== 'view') {
      throw new ToolError(
        `action='${input.action}' is only valid on /executions or /executions/{id}; use action='view' to read /executions/${id}/${resource}.`,
      );
    }

    const viewRange = input.view_range ?? undefined;

    switch (resource) {
      case 'config':
        return this.showConfig(executionId);
      case 'conversation': {
        if (viewRange) {
          throw new ToolError(
            'Conversation pagination is message-based. Use offset and limit; view_range applies only to file and background-command output.',
          );
        }
        return this.showConversation(executionId, input.offset, input.limit);
      }
      case 'todos':
        return this.showTodos(executionId);
      case 'report':
        return this.showReport(executionId);
      case 'result':
        return this.showResultMeta(executionId);
      case 'children':
        return this.showChildren(executionId);
      case 'output':
        return this.showOutput(executionId, viewRange);
      case 'files':
        if (rest.length === 0) {
          return this.listFiles(executionId);
        }
        return this.readFile(executionId, rest.join('/'), viewRange);
      case 'workspace-files':
        if (rest.length === 0) {
          return this.listWorkspaceFiles(executionId);
        }
        return this.readWorkspaceFile(executionId, rest.join('/'), viewRange);
    }

    throw new ToolError(
      `Unknown path: ${input.path}.\nValid paths:\n${EXECUTION_PATH_LIST}`,
    );
  }

  private resolveExecutionId(id: string): ExecutionId {
    if (id === 'current') {
      const executionId = getRunContextExecutionId();
      if (!executionId) {
        throw new ToolError(
          'No active execution. Use a specific execution ID instead of "current".',
        );
      }
      return executionId;
    }
    const result = ExecutionIdSchema.safeParse(id);
    if (!result.success) {
      throw new ToolError(
        `Invalid execution ID format: ${id}. Expected hex string.`,
      );
    }
    return result.data;
  }

  /** Wait for executions to change status, with timeout. */
  private async waitForAnyChange(
    timeout: number,
    ids?: readonly string[] | null,
  ): Promise<void> {
    const candidateIds = ids?.length
      ? unique(ids)
      : currentSession().executions.getActiveIds();
    // Exclude executions that are already effectively done
    // (completed, inactive, or tool-use subagent WAITING with result delivered).
    const pendingIds = candidateIds.filter((id) => !shouldSkipWait(id));
    if (pendingIds.length === 0) return;

    await this.waitWithTimeout(
      timeout,
      (signal) =>
        currentSession().executions.waitForAnyChange(pendingIds, signal),
      () => pendingIds.every(shouldSkipWait),
    );
  }

  /** Wait for a specific execution to change status, with timeout. */
  private async waitForChange(
    executionId: ExecutionId,
    timeout: number,
  ): Promise<void> {
    if (shouldSkipWait(executionId)) return;
    await this.waitWithTimeout(
      timeout,
      (signal) =>
        currentSession().executions.waitForChange(executionId, signal),
      () => shouldSkipWait(executionId),
    );
  }

  /**
   * Shared wait choreography: arm a timeout and a follow-up listener that both
   * abort the wait, register the change callback, then re-check `settled` to
   * close the race window between the initial pre-check and registration.
   */
  private async waitWithTimeout(
    timeout: number,
    register: (signal: AbortSignal) => Promise<unknown>,
    settled: () => boolean,
  ): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout * 1000);
    // Abort early if a follow-up is sent to this stream (user wants to break the wait).
    const cleanupFollowUp = listenForFollowUp(ac);
    try {
      const waitPromise = register(ac.signal);
      if (settled()) ac.abort();
      await waitPromise;
    } finally {
      clearTimeout(timer);
      cleanupFollowUp();
    }
  }

  private async listExecutions(
    offset: number,
    limit: number,
  ): Promise<ToolResult> {
    const entries = await listExecutions();

    if (entries.length === 0) {
      return executed('No execution history found.');
    }

    const { page, start, end, total } = paginateToolListing(
      entries,
      offset,
      limit,
    );
    const lines = page.map(formatListingLine);

    return executed(
      `Executions (showing ${start}–${end} of ${total}, most recent first):\n\n${lines.join('\n')}${formatPaginationHint(end, total)}`,
    );
  }

  private async showSummary(
    executionId: ExecutionId,
    options: ExecutionSummaryOptions = {},
  ): Promise<ToolResult> {
    // Check in-memory handle first (free) — running executions have everything we need
    const session = currentSession();
    const handle = session.executions.getHandle(executionId);

    if (handle) {
      // Running execution: agent/status and task state are session-owned;
      // fetch only the remaining durable details from execution storage.
      const store = getExecutionStore(executionId);
      const todos = getRunningTodos(session, handle);
      const [meta, children, report] = await Promise.all([
        store.readMeta(),
        store.readChildren(),
        store.readReport(),
      ]);

      const info = session.executions.getStatus(handle);
      // `handle.category` is the live wire's execution mode, fabricated for a
      // non-agent run (a background bash reports toolUse). The stamped
      // identity is what the completed branch displays, so the running branch
      // reads it too and the same run cannot change category as it settles;
      // an agent run has no identity-derived category and keeps its mode.
      const category =
        executionDisplayCategory(meta?.identity, null) ?? handle.category;
      const lines = buildRunningSummaryLines(
        executionId,
        handle,
        category,
        info,
        meta,
      );

      await this.appendSummaryTail(
        lines,
        executionId,
        category,
        children,
        todos,
        report,
        {
          workflow: meta?.workflow,
          suppressReport: shouldSuppressAutoDeliveredSubagentReport(
            options,
            handle,
          ),
        },
      );

      return executed(lines.join('\n'));
    }

    // Completed execution: full KV fetch
    const store = getExecutionStore(executionId);
    const [meta, record, children, todosResult, report] = await Promise.all([
      store.readMeta(),
      store.readRunRecord(),
      store.readChildren(),
      readCompletedRunTodos(executionId),
      store.readReport(),
    ]);

    if (!meta && !record) {
      const resumability = await deriveResumability(executionId);
      if (!resumability.resumable) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return executed(
        `Execution: ${executionId}\nStatus: resumable\n(No metadata available - use /executions/${executionId}/conversation to view messages)`,
      );
    }

    // Identity comes only from the stamped execution row; pre-identity rows
    // lost their reader per #9590 Stage 7 and degrade to the config-derived
    // display category, loudly.
    const identity = meta?.identity;
    if (meta && !identity) {
      log.warn(
        `Execution ${executionId} is a pre-identity row; showing config-derived category only (reader retired per #9590 Stage 7)`,
      );
    }
    const category = executionDisplayCategory(identity, record);
    const info = getExecutionStatusInfo(executionId, meta?.outcome);
    const lines = buildCompletedSummaryLines(
      executionId,
      record,
      identity,
      category,
      info,
      meta,
    );

    await this.appendSummaryTail(
      lines,
      executionId,
      category,
      children,
      todosResult.todos,
      report,
      { workflow: meta?.workflow },
    );

    return executed(lines.join('\n'));
  }

  /**
   * Append the shared summary tail (children, todos, report, available paths)
   * common to both the running-handle and completed-execution branches.
   */
  private async appendSummaryTail(
    lines: string[],
    executionId: ExecutionId,
    category: ExecutionDisplayCategory | undefined,
    children: ChildRecord[],
    todos: TodoEntry[],
    report: string | null,
    options: {
      readonly workflow?: WorkflowExecutionSnapshot;
      readonly suppressReport?: boolean;
    } = {},
  ): Promise<void> {
    if (options.workflow) {
      lines.push(
        '',
        'Workflow:',
        JSON.stringify(workflowExecutionView(options.workflow), null, 2),
      );
    }
    if (children.length > 0) {
      lines.push('', `Children (${children.length}):`);
      const formatted = await this.formatChildren(children);
      lines.push(...formatted.map((line) => `  ${line}`));
    }
    lines.push(
      ...buildSummaryTailLines(
        executionId,
        category,
        children.length > 0,
        todos,
        report,
        options,
      ),
    );
  }

  /** Fetch metas and format each child as a summary line. */
  private async formatChildren(children: ChildRecord[]): Promise<string[]> {
    const metas = await Promise.all(
      children.map((c) => getExecutionStore(c.id).readMeta()),
    );
    return children.map((child, i) => formatChildLine(child, metas[i]));
  }

  private handleKill(executionId: ExecutionId): ToolResult {
    const ctx = tryUseRunContext();
    const callerStreamId = getRunContextStreamId(ctx);

    if (getRunContextExecutionId(ctx) === executionId) {
      throw new ToolError(`Cannot kill your own execution (${executionId}).`);
    }

    const target = currentSession().executions.getHandle(executionId);
    if (!target) {
      throw new ToolError(
        `Execution ${executionId} not found or already completed.`,
      );
    }

    // Scope: can only kill your own children. Deny if no context.
    if (!target.isOwnedBy(callerStreamId)) {
      throw new ToolError(
        `Cannot kill execution ${executionId}: not a child of this session.`,
      );
    }

    // Only block kills when the toggle is disabled (the guard above has
    // already narrowed `target` to an owned AgentExecutionHandle).
    warnAbandonedSlotValue(
      GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
      'workspaceState',
      platform().workspaceState,
    );
    if (
      !platform().globalState.get<boolean>(
        GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
        true,
      )
    ) {
      throw new ToolError(
        'Killing subagents is disabled. Enable it in Settings > Multi-Agent.',
      );
    }

    const success = currentSession().executions.kill(executionId, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
    if (success) {
      return executed(`Execution ${executionId} terminated.`);
    }
    throw new ToolError(`Execution ${executionId} could not be terminated.`);
  }

  private handleSubscribe(executionId: ExecutionId): ToolResult {
    const { streamId, context: ctx } = requireRunStream('subscribe');
    // Subscribing to your own execution would feed every status transition
    // back into the same session, creating a self-sustaining loop of
    // <execution-activity> follow-ups.
    if (getRunContextExecutionId(ctx) === executionId) {
      throw new ToolError(
        `Cannot subscribe to your own execution (${executionId}).`,
      );
    }
    // A bind failure propagates as-is: `BaseTool.call` already formats the
    // message with `toErrorMessage`, so re-wrapping it added nothing.
    currentSession().subscriptions.bind(streamId, executionId);
    return executed(
      `Subscribed to ${executionId}. Status and termination events will arrive as follow-ups wrapped in <execution-activity>. Auto-disposes when the execution finishes or this stream is released. Call again with action='unsubscribe' to stop sooner.`,
      `Subscribed to ${executionId}`,
    );
  }

  private handleUnsubscribe(executionId: ExecutionId): ToolResult {
    const streamId = requireStreamId('unsubscribe');
    const removed = currentSession().subscriptions.unbind(
      streamId,
      executionId,
    );
    return executed(
      removed
        ? `Unsubscribed from ${executionId}.`
        : `No active subscription to ${executionId} on this stream.`,
    );
  }

  /**
   * Same source of truth as `showSummary()`'s completed-run todos branch: a
   * running execution's task list is read from session snapshot state. Once
   * the execution is finished this must route through
   * `readCompletedRunTodos()` so this endpoint never disagrees with the
   * summary about which tasks are still pending.
   */
  private async showTodos(executionId: ExecutionId): Promise<ToolResult> {
    const session = currentSession();
    const handle = session.executions.getHandle(executionId);
    const todos = handle
      ? getRunningTodos(session, handle)
      : (await readCompletedRunTodos(executionId)).todos;

    if (todos.length === 0) {
      return executed(`No task list found for execution ${executionId}.`);
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(executionId, todos);

    return executed(`${header}\n\n${lines.join('\n')}`);
  }

  private async showReport(executionId: ExecutionId): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [report, note] = await Promise.all([
      store.readReport(),
      turnAttributionNote(store),
    ]);
    if (!report) {
      return executed(
        `No report found for execution ${executionId}. Reports are persisted when subagents or background processes complete.`,
      );
    }
    return executed(note ? `${note}\n\n${report}` : report);
  }

  /**
   * Machine-readable final result for chaining a completed execution into a
   * later stage without parsing the prose report.
   */
  private async showResultMeta(executionId: ExecutionId): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [resultMeta, note] = await Promise.all([
      store.readResultMeta(),
      turnAttributionNote(store),
    ]);
    if (!resultMeta) {
      return executed(
        `No structured result recorded for ${executionId} yet. It is written when the execution completes.`,
      );
    }
    // The note rides INSIDE the JSON: /result is the machine-readable
    // chaining endpoint, so prefixed prose would break JSON.parse
    // consumers precisely in the interrupted-turn case it describes.
    const payload = note
      ? { turnAttribution: note, ...unwrapResultMeta(resultMeta) }
      : unwrapResultMeta(resultMeta);
    return executed(JSON.stringify(payload, null, 2));
  }

  private async showChildren(executionId: ExecutionId): Promise<ToolResult> {
    const children = await getExecutionStore(executionId).readChildren();
    if (children.length === 0) {
      return executed(`No child executions found for ${executionId}.`);
    }

    const lines = await this.formatChildren(children);
    return executed(
      `Children of ${executionId} (${children.length}):\n\n${lines.join('\n')}`,
    );
  }

  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const record = await store.readRunRecord();

    if (!record) {
      throw new ToolError(`Config not found for execution: ${executionId}.`);
    }

    // Filter out fields irrelevant to this agent's category. Identity comes
    // only from the stamped execution row; a pre-identity row (reader retired
    // per #9590 Stage 7) degrades to the config-derived category, loudly.
    const meta = await store.readMeta();
    const identity = meta?.identity;
    if (meta && !identity) {
      log.warn(
        `Execution ${executionId} is a pre-identity row; filtering config by its config-derived category only (reader retired per #9590 Stage 7)`,
      );
    }
    const category = executionDisplayCategory(identity, record);
    return executed(serializeFilteredConfig(record, category));
  }

  private async showConversation(
    executionId: ExecutionId,
    offset: number,
    limit: number,
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const conversationResult = await readCompletedRunConversation(executionId);
    const { conversation, source, streamId } = conversationResult;
    const streamDiagnostics = [`Stream: ${streamId ?? 'none'}`];

    if (!conversation) {
      // Match the top-level execution lookup: a flow-only record is found only
      // when the shared storage decision says it is resumable.
      const meta = await store.readMeta();
      const resumability = await deriveResumability(executionId);
      const exists =
        meta !== null ||
        resumability.resumable ||
        hasCompletedRunConversationEvidence(conversationResult);
      if (!exists) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return executed(
        formatConversation([], {
          totalMessages: 0,
          metadata: [
            'Source: none',
            ...streamDiagnostics,
            'Returned message interval: [0, 0)',
            'Next offset: none',
          ],
        }),
      );
    }

    const pageStart = Math.min(offset, conversation.length);
    const page = conversation.slice(pageStart, pageStart + limit);
    const pageEnd = pageStart + page.length;
    const output = formatConversation(page, {
      offset: pageStart,
      totalMessages: conversation.length,
      metadata: [
        `Source: ${source}`,
        ...streamDiagnostics,
        `Returned message interval: [${pageStart}, ${pageEnd})`,
        `Next offset: ${pageEnd < conversation.length ? pageEnd : 'none'}`,
      ],
    });

    return executed(output);
  }

  /**
   * stdout/stderr of a background command, projected from the transcript log
   * its child stream already writes (`createChildStream` in `tools/bash.ts`).
   *
   * This is the only route readable *while the command runs*: `/report` and
   * `/result` are written at completion, and the completion follow-up carries
   * only a 20-line preview, so without this the middle of a long build log is
   * unreachable even after the run ends. Restricted to process executions —
   * an agent run's rows are a model transcript, which `/conversation` already
   * renders properly.
   */
  private async showOutput(
    executionId: ExecutionId,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    // A tracked handle is also the liveness fact: the shared terminal
    // finalizer untracks it, so its presence means the command is still up.
    const handle = currentSession().executions.getHandle(executionId);
    const meta = await getExecutionStore(executionId).readMeta();
    if (!meta && !handle) {
      throw new ToolError(`Execution not found: ${executionId}`);
    }
    if (meta?.identity?.kind !== 'process') {
      return executed(
        `/executions/${executionId}/output is only available for background commands (bash with run_in_background). ` +
          `Use /executions/${executionId}/conversation for an agent run's message history.`,
      );
    }

    const transcripts = currentSession().transcripts;
    // The stream is the one stamped on execution metadata at registration.
    const streamId = handle?.childStreamId ?? meta?.streamId;
    if (!streamId || !transcripts.has(streamId)) {
      return executed(
        `No retained output for ${executionId}: its stream log is no longer available. ` +
          `Use /executions/${executionId}/report for the result summary.`,
      );
    }
    const entries = await transcripts.readEntries(streamId);

    const { lines, chars } = projectProcessOutput(entries);
    const info = getExecutionStatusInfo(executionId, meta?.outcome);
    const footer = handle
      ? `[still running: re-read for more output, or use action='wait' on /executions/${executionId} to block until it finishes]`
      : `[finished: this is the retained log; /executions/${executionId}/report has the result summary]`;
    const out: string[] = [
      `Output for ${executionId} (process, ${formatStatusInfo(info)}): ${chars.toLocaleString()} retained transcript chars; command-output cap ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} chars, ${lines.length.toLocaleString()} lines.`,
    ];

    if (lines.length === 0) {
      out.push('', footer);
      return executed(out.join('\n'));
    }
    out.push('Lines are in arrival order; `err:` marks one written to stderr.');

    // Default to the tail, where a live build's news is; a view_range window
    // is clamped so a wide request still can't return an unbounded log.
    const first =
      viewRange?.[0] ?? Math.max(lines.length - OUTPUT_TAIL_LINES, 0) + 1;
    const requestedLast = Math.min(
      viewRange?.[1] ?? lines.length,
      lines.length,
    );
    const last = Math.min(requestedLast, first + OUTPUT_MAX_LINES - 1);

    if (first > last) {
      out.push(
        `No lines in the requested range; the log has ${lines.length} lines.`,
        '',
        footer,
      );
      return executed(out.join('\n'));
    }

    let hint = '';
    if (last < requestedLast) {
      hint = ` (capped at ${OUTPUT_MAX_LINES} lines per read; continue from view_range: [${last + 1}, …])`;
    } else if (!viewRange && first > 1) {
      hint = ` (the last ${OUTPUT_TAIL_LINES} by default; use view_range to page earlier ones)`;
    }
    out.push(
      `Showing lines ${first}-${last} of ${lines.length}${hint}.`,
      '',
      lines.slice(first - 1, last).join('\n'),
      '',
      footer,
    );

    return executed(
      out.join('\n'),
      `Read lines ${first}-${last} of /executions/${executionId}/output`,
    );
  }

  private async listFiles(executionId: ExecutionId): Promise<ToolResult> {
    const files = await listRunGeneratedFiles(executionId);
    if (files.length === 0) {
      return executed('No files generated for this execution.');
    }

    const lines = formatSizedEntryLines(
      files.map((file) => ({
        path: file.path,
        size: file.size,
        isDir: file.isDirectory,
      })),
    );

    return executed(
      `Files in /executions/${executionId}/files:\n\n${lines.join('\n')}`,
    );
  }

  private async readFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    const displayPath = `/executions/${executionId}/files/${filePath}`;
    assertNoParentTraversal(filePath);
    const fullPath = await findExistingRunStoragePath(executionId, filePath);
    if (!fullPath) {
      throw new ToolError(`File not found: ${displayPath}`);
    }

    return readFileContent(StorageFS, fullPath, {
      directoryErrorPath: displayPath,
      resultPath: displayPath,
      viewRange,
    });
  }

  private async listWorkspaceFiles(
    executionId: ExecutionId,
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [record, paths] = await Promise.all([
      store.readRunRecord(),
      store.readWorkspaceFiles(),
    ]);
    const entries = await listExecutionWorkspaceFiles(record, paths);

    if (entries.length === 0) {
      return executed(
        `No workspace files recorded for execution ${executionId}.`,
      );
    }

    const lines = formatSizedEntryLines(
      entries.map((entry) => ({
        path: entry.path,
        size: entry.size,
        isDir: entry.isDirectory,
      })),
    );

    return executed(
      `Workspace files for /executions/${executionId}/workspace-files:\n\n` +
        lines.join('\n'),
    );
  }

  private async readWorkspaceFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [record, paths] = await Promise.all([
      store.readRunRecord(),
      store.readWorkspaceFiles(),
    ]);
    const recordedPaths = new Set(
      paths.flatMap((candidate) => {
        const resolvedCandidate = resolveExecutionWorkspaceFilePath(
          record,
          candidate,
        );
        return resolvedCandidate ? [resolvedCandidate.path] : [];
      }),
    );
    // The listing renders recorded paths under a `workspace/` display prefix,
    // so a read in that display form retries against the stripped path.
    const direct = resolveExecutionWorkspaceFilePath(record, filePath);
    let resolved =
      direct && recordedPaths.has(direct.path) ? direct : undefined;
    const displayPrefix = 'workspace/';
    if (!resolved && filePath.startsWith(displayPrefix)) {
      const stripped = resolveExecutionWorkspaceFilePath(
        record,
        filePath.slice(displayPrefix.length),
      );
      resolved =
        stripped && recordedPaths.has(stripped.path) ? stripped : undefined;
    }
    if (!resolved) {
      throw new ToolError(
        `Workspace file not found: /executions/${executionId}/workspace-files/${filePath}`,
      );
    }

    return readFileContent(AbsoluteFS, resolved.absolutePath, {
      directoryErrorPath: `/executions/${executionId}/workspace-files/${filePath}`,
      resultPath: `/executions/${executionId}/workspace-files/${resolved.path}`,
      viewRange,
    });
  }
}

/**
 * Shared stat → directory-guard → read → format tail for `readFile` and
 * `readWorkspaceFile`, which differ only in which FS backend resolved the
 * path. `directoryErrorPath` and `resultPath` can differ (a workspace-file
 * read reports the raw requested path on error but the canonical resolved
 * path on success).
 */
interface FileBackend {
  stat: (target: string) => Promise<FileStat>;
  read: (target: string) => Promise<string>;
}

async function readFileContent(
  fs: FileBackend,
  fullPath: string,
  {
    directoryErrorPath,
    resultPath,
    viewRange,
  }: {
    directoryErrorPath: string;
    resultPath: string;
    viewRange: [number, number] | undefined;
  },
): Promise<ToolResult> {
  const stats = await fs.stat(fullPath);
  if (isDirectory(stats.type)) {
    throw new ToolError(
      `Path is a directory: ${directoryErrorPath}. Use without trailing path to list.`,
    );
  }

  const content = await fs.read(fullPath);
  return formatFileView({
    path: resultPath,
    lines: splitContentLines(content),
    viewRange,
    maxLines: Infinity,
  });
}
