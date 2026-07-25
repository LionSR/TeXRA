/**
 * Tool for viewing and managing execution history, generated files, and
 * running processes. Supports viewing past executions, waiting for status
 * changes, reading output from background processes, and killing running
 * executions.
 */

// Third-party imports
import { z } from 'zod';

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
import { currentSession } from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { platform } from '@platform/platform';
import {
  ExecutionIdSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamLogEntry,
} from '@shared/schemas';
import {
  BASH_BACKGROUND_LOG_CAP_CHARS,
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
} from '@shared/toolUse';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireRunStream, requireStreamId } from '@tools/contextHelpers';
import { assertNoParentTraversal } from '@tools/pathResolution';
import {
  readCompletedRunConversation,
  readCompletedRunTodos,
  resolvePersistedStreamIdForExecution,
} from '@transcript';
import { AbsoluteFS, StorageFS } from '@utils/files';
import { clamp, unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import {
  formatListingLine,
  formatStatusInfo,
  formatTodoHeader,
  formatTodoSection,
  getExecutionStatusInfo,
  resolveExecutionDisplayCategory,
} from './executionFormatters';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
  ViewRangeSchema,
} from './formatting';
import {
  applyViewRange,
  formatConversation,
} from './executions/conversationFormat';
import { listRunDirectoryFiles } from './executions/runDirectoryFiles';
import { serializeFilteredConfig } from './executions/configFieldFilter';
import {
  listenForFollowUp,
  shouldSkipWait,
} from './executions/waitCoordination';
import {
  buildCompletedSummaryLines,
  buildRunningSummaryLines,
  buildSummaryTailLines,
  formatChildLine,
  formatListingHeader,
  shouldSuppressAutoDeliveredSubagentReport,
  type ExecutionSummaryOptions,
} from './executions/summaryFormat';
import { formatSizedEntryLines } from './executions/fileListingFormat';

// ============================================================================
// Background command output
// ============================================================================

/** Lines returned by /executions/{id}/output when no view_range is given. */
const OUTPUT_TAIL_LINES = 200;

/** Hard ceiling on lines a single /output read returns, view_range included. */
const OUTPUT_MAX_LINES = 1_000;

/** Marks a projected line that the command wrote to stderr. */
const OUTPUT_STDERR_PREFIX = 'err: ';

interface ProcessOutputProjection {
  readonly lines: readonly string[];
  readonly chars: number;
}

/**
 * Flatten a background command's transcript rows into display lines.
 *
 * Rows stay in append order — the only surviving record of how stdout and
 * stderr actually interleaved. Consecutive rows on the same channel are
 * concatenated before the split so a line straddling two chunk boundaries
 * stays one line; `warn`/`error` rows are the stderr channel and every line
 * they contribute is marked. Structured rows (usage, context state, tool
 * frames) carry a non-default `messageType` and are dropped: this endpoint
 * projects command output, not the run's own bookkeeping.
 */
function projectProcessOutput(
  entries: readonly StreamLogEntry[],
): ProcessOutputProjection {
  const runs: { stderr: boolean; text: string }[] = [];
  let chars = 0;

  for (const entry of entries) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) continue;
    if ((entry.messageType ?? MESSAGE_TYPES.DEFAULT) !== MESSAGE_TYPES.DEFAULT)
      continue;
    const text = entry.text;
    if (!text) continue;

    chars += text.length;
    const stderr =
      entry.level === LOG_LEVELS.WARN || entry.level === LOG_LEVELS.ERROR;
    const open = runs.at(-1);
    if (open && open.stderr === stderr) open.text += text;
    else runs.push({ stderr, text });
  }

  const lines: string[] = [];
  for (const run of runs) {
    // A chunk's trailing newline terminates its last line rather than opening
    // an empty one; blank lines inside the chunk still survive the split.
    const text = run.text.endsWith('\n') ? run.text.slice(0, -1) : run.text;
    for (const line of text.split('\n')) {
      lines.push(run.stderr ? `${OUTPUT_STDERR_PREFIX}${line}` : line);
    }
  }

  return { lines, chars };
}

// ============================================================================
// Schema
// ============================================================================

const ExecutionsToolInputSchema = z.strictObject({
  /** Virtual path: /executions, /executions/{id}, /executions/{id}/files, /executions/{id}/workspace-files/{path} */
  path: z.string().describe('Path starting with /executions'),

  /** Action to perform. */
  action: z
    .enum(['view', 'wait', 'kill', 'subscribe', 'unsubscribe'])
    .prefault('view')
    .describe(
      'view: read execution data (returns immediately). ' +
        'wait: wait for a status change on /executions or /executions/{id}, then return the same data as view (avoids sleep-poll loops). ' +
        'kill: terminate a running execution by ID (use on /executions/{id}). ' +
        'subscribe: receive future status changes for /executions/{id} as <execution-activity> follow-ups; auto-disposes when the execution finishes or this stream is released. ' +
        'unsubscribe: stop receiving <execution-activity> follow-ups for /executions/{id}.',
    ),

  /** Optional line range [start, end] for large outputs (action="view" only). */
  view_range: ViewRangeSchema.nullish().describe(
    'Line range [start, end] for paginating large outputs (action="view" only).',
  ),

  /** Execution IDs to wait on (action="wait" with /executions only). */
  ids: z
    .array(ExecutionIdSchema)
    .min(1)
    .max(50)
    .nullish()
    .describe(
      'List of execution IDs to wait on (action="wait" with /executions only). ' +
        'Waits for any of the listed executions to change status. ' +
        'If omitted, waits for any active execution.',
    ),

  /** Max seconds to wait (action="wait" only). Default: 300. */
  timeout: z
    .number()
    .finite()
    .nullish()
    // Clamp in the schema so input.timeout is always a ready-to-use number:
    // an out-of-range or missing value becomes a value inside the wait window.
    .transform((v) =>
      clamp(
        v ?? EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
        EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
        EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
      ),
    )
    .describe(
      `Max seconds to wait for a status change (action="wait" only). Default: ${EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS}; finite values are clamped to the ${EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS}-${EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS} range.`,
    ),

  /** Zero-based offset for paginating the /executions listing (action="view" only). */
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Zero-based offset into the executions list. Use with limit for pagination on /executions. Default: 0.',
    ),

  /** Maximum number of entries to return from the /executions listing (action="view" only). */
  limit: z
    .int()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Max entries to return from /executions listing. Default: 100, max: 200.',
    ),
});

export type ExecutionsToolInput = z.infer<typeof ExecutionsToolInputSchema>;

export class ExecutionsTool extends defineTool({
  name: 'executions',
  slow: true,
  description: `View execution history and manage running executions.

Paths:
- /executions - List executions (paginated; use offset/limit for pages)
- /executions/{id} - Execution summary (agent, model, timestamp, status, children, todos)
- /executions/{id}/config - Agent configuration JSON
- /executions/{id}/conversation - Full message history (subagents)
- /executions/{id}/todos - Task list (tool-use subagents)
- /executions/{id}/report - Result report (persists after context compaction)
- /executions/{id}/result - Final result envelope (JSON) for chaining; process result for background commands
- /executions/{id}/output - stdout/stderr of a background command, readable WHILE IT RUNS (report/result only exist once it finishes)
- /executions/{id}/children - Child executions
- /executions/{id}/files - Generated files (workflows only)
- /executions/{id}/files/{path} - Read specific generated file (workflows only)
- /executions/{id}/workspace-files - Workspace files edited by tool-use runs
- /executions/{id}/workspace-files/{path} - Read a workspace file edited by a tool-use run

Use "current" as {id} to access the active execution.
Use offset/limit to paginate the /executions listing (default: offset 0, limit 100).
Use view_range: [start, end] to paginate conversation, file, and background-command output content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed executions to change.
Use action: "kill" on /executions/{id} to terminate a running execution.
Use action: "subscribe" on /executions/{id} to receive future status and termination events as <execution-activity> follow-ups (auto-disposes when the execution finishes or this stream is released). Use action: "unsubscribe" on /executions/{id} to stop them.`,
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
      if (input.action === 'subscribe' || input.action === 'unsubscribe') {
        throw new ToolError(
          `action='${input.action}' requires a specific execution: use /executions/{id}.`,
        );
      }
      if (input.action === 'wait')
        await this.waitForAnyChange(input.timeout, input.ids);
      return this.listExecutions(input.offset ?? 0, input.limit ?? 100);
    }

    const executionId = this.resolveExecutionId(id);

    // /executions/{id} - execution summary or actions
    if (!resource) {
      // Kill action: terminate a running execution (only valid on /executions/{id})
      if (input.action === 'kill') {
        return this.handleKill(executionId);
      }
      if (input.action === 'subscribe') {
        return this.handleSubscribe(executionId);
      }
      if (input.action === 'unsubscribe') {
        return this.handleUnsubscribe(executionId);
      }
      if (input.action === 'wait')
        await this.waitForChange(executionId, input.timeout);
      return this.showSummary(executionId, {
        suppressAutoDeliveredSubagentReport: input.action === 'wait',
      });
    }

    switch (resource) {
      case 'config':
        return this.showConfig(executionId);
      case 'conversation':
        return this.showConversation(
          executionId,
          input.view_range ?? undefined,
        );
      case 'todos':
        return this.showTodos(executionId);
      case 'report':
        return this.showReport(executionId);
      case 'result':
        return this.showResultMeta(executionId);
      case 'children':
        return this.showChildren(executionId);
      case 'output':
        return this.showOutput(executionId, input.view_range ?? undefined);
      case 'files':
        if (rest.length === 0) {
          return this.listFiles(executionId);
        }
        return this.readFile(
          executionId,
          rest.join('/'),
          input.view_range ?? undefined,
        );
      case 'workspace-files':
        if (rest.length === 0) {
          return this.listWorkspaceFiles(executionId);
        }
        return this.readWorkspaceFile(
          executionId,
          rest.join('/'),
          input.view_range ?? undefined,
        );
    }

    throw new ToolError(
      `Unknown path: ${input.path}.\n` +
        `Valid paths:\n` +
        `- /executions/{id}              - Summary (status, agent, model)\n` +
        `- /executions/{id}/config       - Agent configuration\n` +
        `- /executions/{id}/report       - Result report (prose)\n` +
        `- /executions/{id}/result       - Final result envelope (JSON) for chaining\n` +
        `- /executions/{id}/output       - Background command stdout/stderr (readable while running)\n` +
        `- /executions/{id}/conversation - Message history (subagents)\n` +
        `- /executions/{id}/todos        - Task list (tool-use subagents)\n` +
        `- /executions/{id}/children     - Child executions\n` +
        `- /executions/{id}/files        - Generated files (workflows)\n` +
        `- /executions/{id}/workspace-files - Workspace files edited by tool-use runs`,
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
    const waitPromise = register(ac.signal);
    if (settled()) ac.abort();
    await waitPromise;
    clearTimeout(timer);
    cleanupFollowUp();
  }

  private async listExecutions(
    offset: number,
    limit: number,
  ): Promise<ToolResult> {
    const entries = await listExecutions();

    if (entries.length === 0) {
      return { status: 'executed', output: 'No execution history found.' };
    }

    const { page, start, end, total } = paginateToolListing(
      entries,
      offset,
      limit,
    );
    const lines = page.map(formatListingLine);

    const header = formatListingHeader(start, end, total);
    return {
      status: 'executed',
      output: `${header}\n\n${lines.join('\n')}${formatPaginationHint(end, total)}`,
    };
  }

  private async showSummary(
    executionId: ExecutionId,
    options: ExecutionSummaryOptions = {},
  ): Promise<ToolResult> {
    // Check in-memory handle first (free) — running executions have everything we need
    const handle = currentSession().executions.getHandle(executionId);

    if (handle) {
      // Running execution: agent/status from handle, only fetch live data from KV
      const store = getExecutionStore(executionId);
      const [meta, children, todos, report] = await Promise.all([
        store.readMeta(),
        store.readChildren(),
        store.readTodos(),
        store.readReport(),
      ]);

      const info = currentSession().executions.getStatus(handle);
      const lines = buildRunningSummaryLines(executionId, handle, info, meta);

      await this.appendSummaryTail(
        lines,
        executionId,
        handle.category,
        children,
        todos,
        report,
        {
          suppressReport: shouldSuppressAutoDeliveredSubagentReport(
            options,
            handle,
          ),
        },
      );

      return { status: 'executed', output: lines.join('\n') };
    }

    // Completed execution: full KV fetch
    const store = getExecutionStore(executionId);
    const [meta, config, children, todosResult, report] = await Promise.all([
      store.readMeta(),
      store.readConfig(),
      store.readChildren(),
      readCompletedRunTodos(executionId),
      store.readReport(),
    ]);

    if (!meta && !config) {
      const resumability = await deriveResumability(executionId);
      if (!resumability.resumable) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return {
        status: 'executed',
        output: `Execution: ${executionId}\nStatus: resumable\n(No metadata available - use /executions/${executionId}/conversation to view messages)`,
      };
    }

    const category = resolveExecutionDisplayCategory(
      config?.agent,
      meta?.category ?? config?.agentCategory,
    );
    const info = getExecutionStatusInfo(executionId, meta?.terminalStatus);
    const lines = buildCompletedSummaryLines(
      executionId,
      config,
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
      {
        suppressReport: false,
      },
    );

    return { status: 'executed', output: lines.join('\n') };
  }

  /**
   * Append the shared summary tail (children, todos, report, available paths)
   * common to both the running-handle and completed-execution branches.
   */
  private async appendSummaryTail(
    lines: string[],
    executionId: ExecutionId,
    category: string | undefined,
    children: ChildRecord[],
    todos: TodoEntry[],
    report: string | null,
    options: { readonly suppressReport?: boolean } = {},
  ): Promise<void> {
    await this.appendChildren(lines, children);
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

  /** Append formatted child entries to output lines. */
  private async appendChildren(
    lines: string[],
    children: ChildRecord[],
  ): Promise<void> {
    if (children.length === 0) return;
    lines.push('', `Children (${children.length}):`);
    const formatted = await this.formatChildren(children);
    lines.push(...formatted.map((line) => `  ${line}`));
  }

  private handleKill(executionId: ExecutionId): ToolResult {
    const ctx = tryUseRunContext();
    const callerStreamId = getRunContextStreamId(ctx);

    if (getRunContextExecutionId(ctx) === executionId) {
      return {
        status: 'error',
        error: `Cannot kill your own execution (${executionId}).`,
      };
    }

    const target = currentSession().executions.getHandle(executionId);
    if (!target) {
      return {
        status: 'error',
        error: `Execution ${executionId} not found or already completed.`,
      };
    }

    // Scope: can only kill your own children. Deny if no context.
    if (!callerStreamId || target.parentStreamId !== callerStreamId) {
      return {
        status: 'error',
        error: `Cannot kill execution ${executionId}: not a child of this session.`,
      };
    }

    // Only block subagent kills when the toggle is disabled; process kills are always allowed.
    if (
      target instanceof AgentExecutionHandle &&
      !platform().workspaceState.get<boolean>(
        WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
        true,
      )
    ) {
      return {
        status: 'error',
        error:
          'Killing subagents is disabled. Enable it in Settings > Multi-Agent.',
      };
    }

    const success = currentSession().executions.kill(executionId, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
    if (success) {
      return {
        status: 'executed',
        output: `Execution ${executionId} terminated.`,
      };
    }
    return {
      status: 'error',
      error: `Execution ${executionId} could not be terminated.`,
    };
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
    try {
      currentSession().subscriptions.bind(streamId, executionId);
    } catch (err) {
      throw new ToolError(toErrorMessage(err));
    }
    return {
      status: 'executed',
      summary: `Subscribed to ${executionId}`,
      output: `Subscribed to ${executionId}. Status and termination events will arrive as follow-ups wrapped in <execution-activity>. Auto-disposes when the execution finishes or this stream is released. Call again with action='unsubscribe' to stop sooner.`,
    };
  }

  private handleUnsubscribe(executionId: ExecutionId): ToolResult {
    const streamId = requireStreamId('unsubscribe');
    const removed = currentSession().subscriptions.unbind(
      streamId,
      executionId,
    );
    return {
      status: 'executed',
      output: removed
        ? `Unsubscribed from ${executionId}.`
        : `No active subscription to ${executionId} on this stream.`,
    };
  }

  /**
   * Same source of truth as `showSummary()`'s completed-run todos branch: a
   * running execution's task list is read live from KV, but once the
   * execution is finished this must route through `readCompletedRunTodos()`
   * so this endpoint never disagrees with the summary about which tasks are
   * still pending.
   */
  private async showTodos(executionId: ExecutionId): Promise<ToolResult> {
    const handle = currentSession().executions.getHandle(executionId);
    const store = getExecutionStore(executionId);
    const todos = handle
      ? await store.readTodos()
      : (await readCompletedRunTodos(executionId)).todos;

    if (todos.length === 0) {
      return {
        status: 'executed',
        output: `No task list found for execution ${executionId}.`,
      };
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(executionId, todos);

    return { status: 'executed', output: `${header}\n\n${lines.join('\n')}` };
  }

  private async showReport(executionId: ExecutionId): Promise<ToolResult> {
    const report = await getExecutionStore(executionId).readReport();
    if (!report) {
      return {
        status: 'executed',
        output: `No report found for execution ${executionId}. Reports are persisted when subagents or background processes complete.`,
      };
    }
    return { status: 'executed', output: report };
  }

  /**
   * Machine-readable final result for chaining a completed execution into a
   * later stage without parsing the prose report.
   */
  private async showResultMeta(executionId: ExecutionId): Promise<ToolResult> {
    const resultMeta = await getExecutionStore(executionId).readResultMeta();
    if (!resultMeta) {
      return {
        status: 'executed',
        output: `No structured result recorded for ${executionId} yet. It is written when the execution completes.`,
      };
    }
    return {
      status: 'executed',
      output: JSON.stringify(unwrapResultMeta(resultMeta), null, 2),
    };
  }

  private async showChildren(executionId: ExecutionId): Promise<ToolResult> {
    const children = await getExecutionStore(executionId).readChildren();
    if (children.length === 0) {
      return {
        status: 'executed',
        output: `No child executions found for ${executionId}.`,
      };
    }

    const lines = await this.formatChildren(children);
    return {
      status: 'executed',
      output: `Children of ${executionId} (${children.length}):\n\n${lines.join('\n')}`,
    };
  }

  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const config = await getExecutionStore(executionId).readConfig();

    if (!config) {
      throw new ToolError(`Config not found for execution: ${executionId}.`);
    }

    // Filter out fields irrelevant to this agent's category
    const category = resolveExecutionDisplayCategory(
      config.agent,
      config.agentCategory,
    );
    return {
      status: 'executed',
      output: serializeFilteredConfig(config, category),
    };
  }

  private async showConversation(
    executionId: ExecutionId,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const { conversation } = await readCompletedRunConversation(executionId);

    if (!conversation) {
      // Match the top-level execution lookup: a flow-only record is found only
      // when the shared storage decision says it is resumable.
      const meta = await store.readMeta();
      const resumability = await deriveResumability(executionId);
      const exists = meta !== null || resumability.resumable;
      if (!exists) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return {
        status: 'executed',
        output: '(No conversation history available)',
      };
    }

    const output = applyViewRange(formatConversation(conversation), viewRange);

    return { status: 'executed', output };
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
    if (meta?.category !== 'process') {
      return {
        status: 'executed',
        output:
          `/executions/${executionId}/output is only available for background commands (bash with run_in_background). ` +
          `Use /executions/${executionId}/conversation for an agent run's message history.`,
      };
    }

    const transcripts = currentSession().transcripts;
    const streamId =
      handle instanceof AgentExecutionHandle
        ? handle.childStreamId
        : (
            await resolvePersistedStreamIdForExecution(executionId, {
              streamLogStore: transcripts,
            })
          )?.streamId;
    // Resident while the command runs (an open writer refuses eviction); a
    // released stream rehydrates from disk, and an ephemeral store no-ops.
    if (streamId) await transcripts.ensureLoaded(streamId);
    const log = streamId ? transcripts.get(streamId) : undefined;
    if (!log) {
      return {
        status: 'executed',
        output:
          `No retained output for ${executionId} — its stream log is no longer available. ` +
          `Use /executions/${executionId}/report for the result summary.`,
      };
    }

    const { lines, chars } = projectProcessOutput(log.toJSON());
    const info = getExecutionStatusInfo(executionId, meta.terminalStatus);
    const footer = handle
      ? `[still running — re-read for more output, or use action='wait' on /executions/${executionId} to block until it finishes]`
      : `[finished — this is the retained log; /executions/${executionId}/report has the result summary]`;
    const out: string[] = [
      `Output for ${executionId} (bash, ${formatStatusInfo(info)}) — ${chars.toLocaleString()} of ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} logged chars, ${lines.length.toLocaleString()} lines.`,
    ];

    if (lines.length === 0) {
      out.push('', footer);
      return { status: 'executed', output: out.join('\n') };
    }
    out.push('Lines are in arrival order; `err:` marks one written to stderr.');

    // Default to the tail, where a live build's news is; a view_range window
    // is clamped so a wide request still can't return an unbounded log.
    const first = viewRange
      ? viewRange[0]
      : Math.max(lines.length - OUTPUT_TAIL_LINES, 0) + 1;
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
      return { status: 'executed', output: out.join('\n') };
    }

    let hint = '';
    if (last < requestedLast) {
      hint = ` (capped at ${OUTPUT_MAX_LINES} lines per read — continue from view_range: [${last + 1}, …])`;
    } else if (!viewRange && first > 1) {
      hint = ` (the last ${OUTPUT_TAIL_LINES} by default — use view_range to page earlier ones)`;
    }
    out.push(
      `Showing lines ${first}-${last} of ${lines.length}${hint}.`,
      '',
      applyViewRange(lines.join('\n'), [first, last]),
      '',
      footer,
    );

    return {
      status: 'executed',
      summary: `Read lines ${first}-${last} of /executions/${executionId}/output`,
      output: out.join('\n'),
    };
  }

  private async listFiles(executionId: ExecutionId): Promise<ToolResult> {
    const runDir = await findExistingRunStoragePath(executionId);
    if (!runDir) {
      return {
        status: 'executed',
        output: 'No files generated for this execution.',
      };
    }

    const entries = await listRunDirectoryFiles(runDir);

    if (entries.length === 0) {
      return {
        status: 'executed',
        output: 'No files generated for this execution.',
      };
    }

    const lines = formatSizedEntryLines(entries);

    return {
      status: 'executed',
      output: `Files in /executions/${executionId}/files:\n\n${lines.join('\n')}`,
    };
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

    const stats = await StorageFS.stat(fullPath);
    if (isDirectory(stats.type)) {
      throw new ToolError(
        `Path is a directory: ${displayPath}. Use without trailing path to list.`,
      );
    }

    const content = await StorageFS.read(fullPath);
    const lines = splitContentLines(content);

    return formatFileView({
      path: displayPath,
      lines,
      viewRange,
      maxLines: Infinity,
    });
  }

  private async listWorkspaceFiles(
    executionId: ExecutionId,
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [config, paths] = await Promise.all([
      store.readConfig(),
      store.readWorkspaceFiles(),
    ]);
    const entries = await listExecutionWorkspaceFiles(config, paths);

    if (entries.length === 0) {
      return {
        status: 'executed',
        output: `No workspace files recorded for execution ${executionId}.`,
      };
    }

    const lines = formatSizedEntryLines(
      entries.map((entry) => ({
        path: entry.path,
        size: entry.size,
        isDir: entry.isDirectory,
      })),
    );

    return {
      status: 'executed',
      output:
        `Workspace files for /executions/${executionId}/workspace-files:\n\n` +
        lines.join('\n'),
    };
  }

  private async readWorkspaceFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [config, paths] = await Promise.all([
      store.readConfig(),
      store.readWorkspaceFiles(),
    ]);
    const recordedPaths = this.recordedWorkspacePathSet(config, paths);
    const resolved = this.resolveRecordedWorkspaceFile(
      config,
      recordedPaths,
      filePath,
    );
    if (!resolved) {
      throw new ToolError(
        `Workspace file not found: /executions/${executionId}/workspace-files/${filePath}`,
      );
    }

    const stats = await AbsoluteFS.stat(resolved.absolutePath);
    if (isDirectory(stats.type)) {
      throw new ToolError(
        `Path is a directory: /executions/${executionId}/workspace-files/${filePath}. Use without trailing path to list.`,
      );
    }

    const content = await AbsoluteFS.read(resolved.absolutePath);
    return formatFileView({
      path: `/executions/${executionId}/workspace-files/${resolved.path}`,
      lines: splitContentLines(content),
      viewRange,
      maxLines: Infinity,
    });
  }

  private resolveRecordedWorkspaceFile(
    config: AgentConfig | null,
    recordedPaths: ReadonlySet<string>,
    filePath: string,
  ): { readonly absolutePath: string; readonly path: string } | undefined {
    const direct = resolveExecutionWorkspaceFilePath(config, filePath);
    if (direct && recordedPaths.has(direct.path)) {
      return direct;
    }
    const displayPrefix = 'workspace/';
    if (!filePath.startsWith(displayPrefix)) return undefined;
    const stripped = resolveExecutionWorkspaceFilePath(
      config,
      filePath.slice(displayPrefix.length),
    );
    return stripped && recordedPaths.has(stripped.path) ? stripped : undefined;
  }

  private recordedWorkspacePathSet(
    config: AgentConfig | null,
    paths: readonly string[],
  ): Set<string> {
    return new Set(
      paths.flatMap((candidate) => {
        const resolved = resolveExecutionWorkspaceFilePath(config, candidate);
        return resolved ? [resolved.path] : [];
      }),
    );
  }
}
